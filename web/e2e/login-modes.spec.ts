import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession } from './session'

/**
 * VB-4 登入卡三模式、忘記密碼、重設密碼（visitor-r3 設計方案 §3.4；AC-VI-58、59、60、79）。
 *
 * - 寄信走擷取模式（`MAIL_CAPTURE=1`）：重設連結從 `mail_outbox.body_text` 取。寄重設信不等寄信結果
 *   （VB-2 刻意不讓有帳號的請求比較慢），所以讀信要輪詢。
 * - 每個 context 帶自己的 `X-Real-IP`：寄重設信每 IP 每小時 20 封、登入也有每 IP 的桶，不跟其他 spec 搶。
 * - CI 不設 Turnstile 金鑰，表單沒有 widget（有金鑰的情境由 `turnstile.spec.ts` 那一類管）。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER
const OLD_PASSWORD = 'E2e-Password-Correct-9'
const run = Date.now().toString(36)

test.describe.configure({ mode: 'serial' })

let pool: Pool
test.beforeAll(() => {
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能讀 mail_outbox')
  pool = new Pool({ connectionString: ownerUrl, max: 2 })
})
test.afterAll(async () => {
  await pool?.end()
})

let ipCounter = 0
function uniqueIp(): string {
  ipCounter += 1
  return `10.253.${Math.floor(Math.random() * 250)}.${(ipCounter % 250) + 1}`
}

async function newGuestPage(browser: Browser, options: { javaScriptEnabled?: boolean } = {}): Promise<Page> {
  const context = await browser.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: { 'x-real-ip': uniqueIp() },
    viewport: { width: 1440, height: 900 },
    ...options,
  })
  return context.newPage()
}

const card = (page: Page) => page.getByTestId('login-card')

/** 某個 Email 的重設信（新到舊）。 */
async function resetMails(email: string) {
  const rows = await pool.query<{ subject: string; body_text: string | null; status: string; template: string }>(
    `select subject, body_text, status, template from mail_outbox where to_email = $1 and template = 'password_reset' order by created_at desc`,
    [email],
  )
  return rows.rows
}

/** 等到這個 Email 有第 `count` 封重設信，回最新一封的連結（站內路徑＋查詢字串）。 */
async function waitForResetLink(email: string, count = 1): Promise<string> {
  await expect.poll(async () => (await resetMails(email)).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(count)
  const body = (await resetMails(email))[0]!.body_text ?? ''
  const url = /https?:\/\/\S+?\/reset-password\?token=[^\s。，]+/.exec(body)?.[0]
  if (!url) throw new Error(`重設信裡沒有連結：${body}`)
  const parsed = new URL(url)
  return `${parsed.pathname}${parsed.search}`
}

async function signInByForm(page: Page, email: string, password: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('密碼', { exact: true }).fill(password)
  await page.getByRole('button', { name: '登入', exact: true }).click()
}

function requestReset(request: APIRequestContext, email: string) {
  return request.post('/api/auth/request-password-reset', {
    data: { email, redirectTo: '/reset-password' },
    headers: { origin: BASE_URL, 'x-real-ip': uniqueIp() },
  })
}

test('AC-VI-58 登入模式 → 忘記密碼模式 → 返回登入：同一張卡、不整頁跳轉、Email 帶過去', async ({ browser }) => {
  const page = await newGuestPage(browser)
  await page.goto('/login')

  // 左圖右卡：≥1024 有校園照、沒有 canvas。
  await expect(page.locator('aside img[src="/placeholder/campus.jpg"]')).toBeVisible()
  await expect(page.locator('canvas')).toHaveCount(0)
  await expect(card(page)).toHaveAttribute('data-mode', 'login')
  await expect(card(page).getByRole('button', { name: '使用 Google 帳號登入' })).toBeVisible()
  await expect(card(page).getByLabel('Email')).toBeVisible()
  await expect(card(page).getByLabel('密碼', { exact: true })).toHaveAttribute('type', 'password')
  await expect(card(page).getByRole('button', { name: '顯示密碼' })).toBeVisible()
  const forgotLink = card(page).locator('a[href="/forgot-password"]')
  await expect(forgotLink).toHaveText('忘記密碼？')
  await expect(card(page).getByRole('button', { name: '登入', exact: true })).toBeVisible()

  // 整頁重載會洗掉這個記號；最後還在就證明沒有整頁跳轉。
  await page.evaluate(() => ((window as unknown as { __same: boolean }).__same = true))
  await card(page).getByLabel('Email').fill('carry@example.com')
  await forgotLink.click()
  await expect(page).toHaveURL(/\/login\?mode=forgot$/)
  await expect(card(page)).toHaveAttribute('data-mode', 'forgot')
  await expect(card(page)).toContainText('輸入 Email，我們寄重設連結給你。')
  await expect(card(page).getByLabel('Email')).toHaveValue('carry@example.com')
  await expect(card(page).getByRole('button', { name: '寄重設連結' })).toBeVisible()
  await expect(card(page).getByLabel('密碼', { exact: true })).toHaveCount(0)

  await card(page).getByLabel('Email').fill('back@example.com')
  await card(page).getByRole('link', { name: '返回登入' }).click()
  await expect(page).toHaveURL(/\/login$/)
  await expect(card(page)).toHaveAttribute('data-mode', 'login')
  await expect(card(page).getByLabel('Email')).toHaveValue('back@example.com')
  expect(await page.evaluate(() => (window as unknown as { __same?: boolean }).__same)).toBe(true)
  await page.screenshot({ path: test.info().outputPath('mode-login.png') })
  await page.context().close()
})

test('AC-VI-58 /forgot-password 導到 /login?mode=forgot；沒有 JavaScript 也能切到忘記密碼並寄出', async ({ browser, request }) => {
  const redirect = await request.get('/forgot-password', { maxRedirects: 0 })
  expect([302, 303, 307, 308]).toContain(redirect.status())
  expect(redirect.headers()['location']).toMatch(/\/login\?mode=forgot$/)

  const page = await newGuestPage(browser)
  await page.goto('/forgot-password')
  await expect(page).toHaveURL(/\/login\?mode=forgot$/)
  await expect(card(page)).toHaveAttribute('data-mode', 'forgot')
  await page.screenshot({ path: test.info().outputPath('mode-forgot.png') })
  await page.context().close()

  const noJs = await newGuestPage(browser, { javaScriptEnabled: false })
  await noJs.goto('/login')
  await card(noJs).locator('a[href="/forgot-password"]').click()
  await expect(noJs).toHaveURL(/\/login\?mode=forgot$/)
  await expect(card(noJs)).toContainText('輸入 Email，我們寄重設連結給你。')
  await card(noJs).getByLabel('Email').fill(`nojs-${run}@example.com`)
  await card(noJs).getByRole('button', { name: '寄重設連結' }).click()
  await expect(noJs.getByRole('heading', { name: '已寄出，請到信箱收信' })).toBeVisible()
  await noJs.context().close()
})

test('AC-VI-79 登入頁提示句（R11）', async ({ browser }) => {
  const page = await newGuestPage(browser)
  await page.goto('/login')
  const hint = page.getByTestId('register-hint')
  await expect(hint).toHaveText('還沒有帳號？學生請先註冊。')
  await expect(hint.getByRole('link', { name: '註冊' })).toHaveAttribute('href', '/register')
  await expect(page.locator('body')).not.toContainText('系辦核准後才會開通')
  await page.context().close()
})

for (const state of ['forgot', 'sent'] as const) {
  for (const where of ['header', 'footer'] as const) {
    test(`Review #587：${state} 模式點${where === 'header' ? '頂部' : '頁尾'}「登入」→ 網址 /login、回到登入表單`, async ({ browser }) => {
      const page = await newGuestPage(browser)
      await page.goto('/login')
      await card(page).locator('a[href="/forgot-password"]').click()
      await expect(card(page)).toHaveAttribute('data-mode', 'forgot')
      if (state === 'sent') {
        await card(page).getByLabel('Email').fill(`nav-${where}-${run}@example.com`)
        await card(page).getByRole('button', { name: '寄重設連結' }).click()
        await expect(card(page)).toHaveAttribute('data-mode', 'sent')
      }

      await page.locator(`${where} a[href="/login"]:visible`).first().click()
      await expect(page).toHaveURL(/\/login$/)
      await expect(card(page)).toHaveAttribute('data-mode', 'login')
      await expect(card(page).getByLabel('密碼', { exact: true })).toBeVisible()
      await expect(card(page).getByRole('button', { name: '登入', exact: true })).toBeVisible()

      // 再按「忘記密碼？」是全新的一輪：不會直接跳回上一輪的「已寄出」。
      await card(page).locator('a[href="/forgot-password"]').click()
      await expect(card(page)).toHaveAttribute('data-mode', 'forgot')
      await expect(card(page).getByRole('button', { name: '寄重設連結' })).toBeVisible()
      await page.context().close()
    })
  }
}

let studentEmail = ''
let resetLink = ''

test('AC-VI-59 有帳號、沒帳號都到同一個「已寄出」；只有有帳號的寄信；第 6 次 429', async ({ browser, request }) => {
  const page = await newGuestPage(browser)
  const student = await createTestSession(page.request, 'student')
  studentEmail = student.email
  await page.context().clearCookies()
  const nobody = `nobody-${run}@example.com`

  const sentText = (email: string) => `重設連結已寄到 ${email}，連結 30 分鐘內有效。沒看到的話，找找垃圾郵件匣。`
  const submitForgot = async (email: string) => {
    await page.goto('/login?mode=forgot')
    await card(page).getByLabel('Email').fill(email)
    await card(page).getByRole('button', { name: '寄重設連結' }).click()
  }

  await submitForgot(studentEmail)
  await expect(card(page)).toHaveAttribute('data-mode', 'sent')
  await expect(page.getByRole('heading', { name: '已寄出，請到信箱收信' })).toBeVisible()
  await expect(page.getByTestId('reset-sent')).toHaveText(sentText(studentEmail))
  await page.screenshot({ path: test.info().outputPath('mode-sent.png') })
  // 返回登入：剛才的 Email 帶回登入欄。
  await card(page).getByRole('link', { name: '返回登入' }).click()
  await expect(card(page).getByLabel('Email')).toHaveValue(studentEmail)

  await submitForgot(nobody)
  await expect(page.getByRole('heading', { name: '已寄出，請到信箱收信' })).toBeVisible()
  await expect(page.getByTestId('reset-sent')).toHaveText(sentText(nobody))

  resetLink = await waitForResetLink(studentEmail)
  const [mail] = await resetMails(studentEmail)
  const token = new URL(resetLink, BASE_URL).searchParams.get('token')!
  expect(mail!.status).toBe('captured')
  expect(mail!.subject).not.toContain(token)
  expect(mail!.body_text).toContain('/reset-password?token=')
  expect(await resetMails(nobody)).toEqual([])

  // 同一 Email 一小時內第 6 次：前面畫面送了 1 次，API 再送 4 次（每次換 IP），第 6 次在畫面上被擋。
  for (let i = 0; i < 4; i += 1) expect((await requestReset(request, studentEmail)).status()).toBe(200)
  await submitForgot(studentEmail)
  await expect(card(page).getByRole('alert')).toHaveText('寄太多次了，請一小時後再試。')
  await expect(card(page)).toHaveAttribute('data-mode', 'forgot')
  await expect(card(page).getByLabel('Email')).toHaveValue(studentEmail)
  // 擋下來的那次不寄；連結還是第一封那條（之後每封都會作廢前一條，所以下面用最新那一封）。
  resetLink = await waitForResetLink(studentEmail, 5)
  await page.context().close()
})

test('AC-VI-60 重設密碼：12 字、撤掉舊 session、連結只能用一次、過期同句、沒 token 導回', async ({ browser, request }) => {
  test.skip(!resetLink, '要接 AC-VI-59 的連結')
  const NEW_PASSWORD = 'New-Password-2026x'

  // 另一個 context 先用舊密碼登入。
  const other = await newGuestPage(browser)
  await signInByForm(other, studentEmail, OLD_PASSWORD)
  await expect(other).toHaveURL(/\/dashboard\/student/)

  const page = await newGuestPage(browser)
  await page.goto(resetLink)
  await expect(page.locator('meta[name="referrer"]')).toHaveAttribute('content', 'no-referrer')
  await expect(page.getByLabel('新密碼')).toBeVisible()
  await page.getByLabel('新密碼').fill('a'.repeat(11))
  await page.getByLabel('確認密碼').fill('a'.repeat(11))
  await page.getByRole('button', { name: '重設密碼' }).click()
  await expect(page.getByRole('main').getByRole('alert')).toHaveText('密碼至少 12 字。')

  await page.getByLabel('新密碼').fill(NEW_PASSWORD)
  await page.getByLabel('確認密碼').fill(NEW_PASSWORD)
  await page.getByRole('button', { name: '重設密碼' }).click()
  await expect(page.getByRole('heading', { name: '密碼已重設，請用新密碼登入' })).toBeVisible()
  await expect(page.getByRole('main').getByRole('link', { name: '前往登入' })).toHaveAttribute('href', '/login')

  // 重設前的 session 全被刪：另一個 context 重整就被導去登入頁。
  await other.reload()
  await expect(other).toHaveURL(/\/login/)
  await other.context().close()

  // 舊密碼不行、新密碼可以。
  const oldTry = await newGuestPage(browser)
  await signInByForm(oldTry, studentEmail, OLD_PASSWORD)
  await expect(card(oldTry).getByRole('alert')).toHaveText('Email 或密碼不正確。')
  await oldTry.context().close()
  const newTry = await newGuestPage(browser)
  await signInByForm(newTry, studentEmail, NEW_PASSWORD)
  await expect(newTry).toHaveURL(/\/dashboard\/student/)
  await newTry.context().close()

  // 同一條連結再用一次。
  const expiredText = '這個連結已失效，請重新申請'
  const reuse = async (link: string) => {
    await page.goto(link)
    await page.getByLabel('新密碼').fill(`${NEW_PASSWORD}-2`)
    await page.getByLabel('確認密碼').fill(`${NEW_PASSWORD}-2`)
    await page.getByRole('button', { name: '重設密碼' }).click()
    await expect(page.getByRole('heading', { name: expiredText })).toBeVisible()
    await expect(page.getByRole('main').getByRole('link', { name: '重新申請重設連結' })).toHaveAttribute('href', '/login?mode=forgot')
  }
  await reuse(resetLink)

  // 過期：另一個帳號（前一個已經用完這一小時的額度）申請新連結，把 expires_at 改成 31 分鐘前。
  const second = await createTestSession(request, 'student')
  expect((await requestReset(request, second.email)).status()).toBe(200)
  const fresh = await waitForResetLink(second.email)
  await pool.query(
    `update verifications set expires_at = now() - interval '31 minutes'
      where identifier like 'reset-password:%' and value = $1`,
    [second.userId],
  )
  await reuse(fresh)

  // 沒有 token：導回忘記密碼模式。
  await page.goto('/reset-password')
  await expect(page).toHaveURL(/\/login\?mode=forgot$/)
  await page.context().close()
})
