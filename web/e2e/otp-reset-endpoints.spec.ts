import { expect, test, type APIRequestContext } from '@playwright/test'
import { Pool } from 'pg'

/**
 * B 階段 VB-2：驗證碼與重設密碼端點掛上 Turnstile 與寄信（visitor-r3 設計方案 §3.2、§3.4、§3.8）。
 *
 * 三種 app 設定各一組；**起 app 的那個程序**的環境決定這次跑哪一組（spec 自己改不了 app 的環境）：
 *
 * - 預設（CI、本機；兩個 Turnstile 鍵都不設、`MAIL_CAPTURE=1`）：端點不要 token 照常通過（AC-VI-67）。
 * - `E2E_SERVER_MODE=turnstile`：app 設 Cloudflare 永遠通過的測試金鑰。三個寄信端點不帶 `x-turnstile-token`
 *   一律 400 `TURNSTILE_REQUIRED`；密碼登入不要 token（AC-VI-66 的「端點沒 token 回 400」）。
 * - `E2E_SERVER_MODE=mail-fail`：app 不開擷取、也沒有 Brevo 金鑰。註冊頁送出後畫面顯示
 *   「驗證信寄不出去，請稍後再試。」（AC-VI-76 的畫面段），`mail_outbox` 一列 `failed`。
 *
 * 表單上的 widget（AC-VI-66 畫面段）由掛載表單的 VB-3（註冊、重寄）與 VB-4（忘記密碼）各自補。
 */

const MODE = process.env.E2E_SERVER_MODE ?? 'default'
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER
const PASSWORD = 'Student-Password-2026'
const run = Date.now().toString(36)

let ipCounter = 0
/** 每個請求自己的來源 IP：限速桶彼此獨立，不跟其他 spec 搶額度。 */
function uniqueIp(): string {
  ipCounter += 1
  return `10.222.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`
}

function post(request: APIRequestContext, path: string, data: unknown, headers: Record<string, string> = {}) {
  return request.post(`/api/auth${path}`, {
    data,
    headers: { origin: BASE_URL, 'x-real-ip': uniqueIp(), ...headers },
  })
}

test.describe('沒設 Turnstile 金鑰：端點不要 token 照常通過（AC-VI-67）', () => {
  test.skip(MODE !== 'default', `app 是 ${MODE} 模式`)

  test('忘記密碼、重寄驗證碼不帶 token 都 200；註冊後 mail_outbox 有一封驗證碼', async ({ request }) => {
    const email = `vb2-e2e-default-${run}@example.com`
    const signUp = await post(request, '/sign-up/email', { email, password: PASSWORD, name: 'VB2' })
    expect(signUp.status()).toBe(200)

    const reset = await post(request, '/request-password-reset', { email, redirectTo: '/reset-password' })
    expect(reset.status()).toBe(200)

    // 註冊剛寄過第一封，未滿 120 秒重寄由伺服器擋（不只是按鈕倒數）。
    const resend = await post(request, '/email-otp/send-verification-otp', { email, type: 'email-verification' })
    expect(resend.status()).toBe(429)

    test.skip(!ownerUrl, '沒有 DATABASE_URL_OWNER，看不到 mail_outbox')
    const pool = new Pool({ connectionString: ownerUrl })
    try {
      const rows = await pool.query(`select template, status from mail_outbox where to_email = $1 order by created_at`, [email])
      expect(rows.rows[0]).toEqual({ template: 'email_otp', status: 'captured' })
    } finally {
      await pool.end()
    }
  })

  test('OTP 登入、OTP 重設、換 Email 的端點對外 403（AC-VI-71）', async ({ request }) => {
    for (const path of [
      '/sign-in/email-otp',
      '/forget-password/email-otp',
      '/email-otp/request-password-reset',
      '/email-otp/reset-password',
      '/email-otp/change-email',
      '/email-otp/request-email-change',
      '/send-verification-email',
    ]) {
      const response = await post(request, path, {})
      expect(response.status(), path).toBe(403)
    }
  })
})

test.describe('有 Turnstile 金鑰：寄信端點沒 token 一律 400（AC-VI-66 伺服器段）', () => {
  test.skip(MODE !== 'turnstile', `app 是 ${MODE} 模式`)

  test('註冊、忘記密碼、重寄驗證碼不帶 x-turnstile-token → 400 TURNSTILE_REQUIRED', async ({ request }) => {
    const email = `vb2-e2e-ts-${run}@example.com`
    for (const [path, data] of [
      ['/sign-up/email', { email, password: PASSWORD, name: 'VB2' }],
      ['/request-password-reset', { email, redirectTo: '/reset-password' }],
      ['/email-otp/send-verification-otp', { email, type: 'email-verification' }],
    ] as const) {
      const response = await post(request, path, data)
      expect(response.status(), path).toBe(400)
      expect(await response.json(), path).toMatchObject({ code: 'TURNSTILE_REQUIRED', message: '請完成人機驗證。' })
    }
  })

  test('密碼登入不要 token：照常 401（不是 400）', async ({ request }) => {
    const response = await post(request, '/sign-in/email', { email: `vb2-e2e-nobody-${run}@example.com`, password: PASSWORD })
    expect(response.status()).toBe(401)
  })

  test('註冊頁沒拿到 token 就送出：Server Action 那條一樣被擋，畫面「請完成人機驗證。」', async ({ page }) => {
    // VB-3 已在第 1 步掛 widget；擋掉 Cloudflare，widget 就拿不到 token（隱藏欄是空的）。
    await page.route('https://challenges.cloudflare.com/**', (route) => route.abort())
    await page.goto('/register')
    await page.getByLabel('Email', { exact: true }).fill(`vb2-e2e-ts-form-${run}@example.com`)
    await page.getByLabel('密碼', { exact: true }).fill(PASSWORD)
    await page.getByLabel('確認密碼').fill(PASSWORD)
    await page.getByRole('button', { name: '建立帳號' }).click()
    await expect(page.getByText('請完成人機驗證。')).toBeVisible()
    await expect(page).toHaveURL(/\/register$/)
  })
})

test.describe('驗證信寄不出去（AC-VI-76 畫面段）', () => {
  test.skip(MODE !== 'mail-fail', `app 是 ${MODE} 模式`)

  test('註冊頁送出 → 「驗證信寄不出去，請稍後再試。」；mail_outbox 一列 failed、不存內文', async ({ page }) => {
    const email = `vb2-e2e-mailfail-${run}@example.com`
    await page.goto('/register')
    await page.getByLabel('Email', { exact: true }).fill(email)
    await page.getByLabel('密碼', { exact: true }).fill(PASSWORD)
    await page.getByLabel('確認密碼').fill(PASSWORD)
    await page.getByRole('button', { name: '建立帳號' }).click()
    await expect(page.getByText('驗證信寄不出去，請稍後再試。')).toBeVisible()
    await page.screenshot({ path: process.env.E2E_SCREENSHOT ?? 'e2e/.artifacts/vb2-mail-fail.png', fullPage: true })

    test.skip(!ownerUrl, '沒有 DATABASE_URL_OWNER，看不到 mail_outbox')
    const pool = new Pool({ connectionString: ownerUrl })
    try {
      const rows = await pool.query(`select template, status, error, body_text from mail_outbox where to_email = $1`, [email])
      expect(rows.rows).toEqual([{ template: 'email_otp', status: 'failed', error: 'not_configured', body_text: null }])
    } finally {
      await pool.end()
    }
  })
})
