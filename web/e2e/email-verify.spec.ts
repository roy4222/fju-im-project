import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, toPlaywrightCookie } from './session'

/**
 * VB-5：待審頁、「我的帳號」驗證 Email、首頁導去驗證（visitor-r3 §3.5、§3.7、§3.2）。
 *
 * - AC-VI-50 首頁段：用密碼註冊、還沒驗證 Email、還沒送申請的人開 `/` → `/register/verify`。
 * - AC-VI-51 待審段、52：三步進度、說明句、帶學生證去哪裡；修改後只說「已編輯・時間」，學生看不到「第 N 版」。
 * - AC-VI-62 `/account` 段、65：本批之前註冊、已核准但沒驗證 Email 的學生照常使用；`/account` 多一顆「驗證 Email」，
 *   不掛 Turnstile；填對碼後「Email 已驗證」、按鈕消失。session 超過 10 分鐘要重新登入確認。
 * - AC-VI-64：`/login?error=account_not_linked` 是共用 N2 的句子。
 *
 * 要擷取模式（`MAIL_CAPTURE=1`）：驗證碼從 `mail_outbox.body_text` 讀。
 * `session.ts` 用註冊 API 造帳號，註冊時伺服器已寄第一封驗證碼並開始 120 秒冷卻；要從「我的帳號」寄碼的測試
 * 把登入 Email 換成一個新的（模擬本批之前註冊、沒有寄過驗證碼的舊帳號），冷卻才不會擋到。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'

/** 這份開的瀏覽器 context 每個測試結束就關（#816：沒關的分頁會活到 worker 結束，全套連跑時一直吃 CPU）。 */
const openContexts: BrowserContext[] = []
function track(context: BrowserContext): BrowserContext {
  openContexts.push(context)
  return context
}
test.afterEach(async () => {
  await Promise.all(openContexts.splice(0).map((context) => context.close()))
})

const ownerUrl = process.env.DATABASE_URL_OWNER
const PASSWORD = 'E2e-Password-Correct-9'
const SHOT_DIR = process.env.VB5_SHOT_DIR

async function sql<T extends Record<string, unknown> = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER')
  const pool = new Pool({ connectionString: ownerUrl, max: 1 })
  try {
    return (await pool.query<T>(text, params)).rows
  } finally {
    await pool.end()
  }
}

async function latestOtp(email: string): Promise<string> {
  for (let i = 0; i < 50; i += 1) {
    const rows = await sql<{ body_text: string | null }>(
      `select body_text from mail_outbox where to_email = $1 and template = 'email_otp' order by created_at desc limit 1`,
      [email],
    )
    const otp = /驗證碼是 (\d{6})/.exec(rows[0]?.body_text ?? '')?.[1]
    if (otp) return otp
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`mail_outbox 沒有 ${email} 的驗證碼（e2e 要 MAIL_CAPTURE=1）`)
}

let ipSeq = 0
const uniqueIp = () => `10.251.${Math.floor(Math.random() * 250)}.${(++ipSeq % 250) + 1}`

async function freshPage(browser: Browser): Promise<Page> {
  const context = track(await browser.newContext({ extraHTTPHeaders: { 'x-real-ip': uniqueIp() } }))
  return context.newPage()
}

/** 已核准的學生、`email_verified=false`、登入 Email 換成沒寄過驗證碼的新信箱（本批之前註冊的舊帳號）。 */
async function legacyStudent(page: Page): Promise<{ email: string; userId: string }> {
  const session = await createTestSession(page.request, 'student')
  const email = `vb5-old-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`
  await sql(`update users set email = $2, email_verified = false where id = $1`, [session.userId, email])
  await sql(`delete from sessions where user_id = $1`, [session.userId])
  return { email, userId: session.userId }
}

async function passwordLogin(page: Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('密碼', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: '登入', exact: true }).click()
  await expect(page).toHaveURL(/\/dashboard\/student$/)
}

test('AC-VI-65＋62：舊帳號照常使用；/account 驗證 Email（沒有 Turnstile），填對碼後「Email 已驗證」、按鈕消失', async ({ browser }) => {
  const page = await freshPage(browser)
  const { email, userId } = await legacyStudent(page)
  await passwordLogin(page, email)

  // AC-VI-65：既有帳號不受驗證限制。
  for (const route of ['/dashboard/student', '/projects', '/account']) {
    await page.goto(route)
    await expect(page).toHaveURL(new RegExp(`${route.replace(/\//g, '\\/')}$`))
  }

  const box = page.getByTestId('verify-email')
  await expect(box).toContainText(`登入 Email（${email}）還沒驗證`)
  await expect(page.locator('[data-turnstile-action]')).toHaveCount(0)
  await box.getByRole('button', { name: '驗證 Email' }).click()
  await expect(box.getByRole('status')).toContainText('驗證碼已寄到登入 Email')
  await expect(box.getByLabel('驗證碼第 6 位')).toBeVisible()

  // 錯的碼：同一處報錯、清空重填。
  const otp = await latestOtp(email)
  const wrong = otp === '000000' ? '111111' : '000000'
  await box.getByLabel('驗證碼第 1 位').fill(wrong)
  await box.getByRole('button', { name: '確認驗證碼' }).click()
  await expect(box.getByRole('alert')).toBeVisible()
  expect(await sql(`select email_verified from users where id = $1`, [userId])).toEqual([{ email_verified: false }])

  await box.getByLabel('驗證碼第 1 位').fill(otp)
  await box.getByRole('button', { name: '確認驗證碼' }).click()
  await expect(page).toHaveURL(/\/account\?verified=email$/)
  await expect(page.getByTestId('account-notice')).toContainText('Email 已驗證')
  await expect(page.getByTestId('verify-email')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '驗證 Email' })).toHaveCount(0)
  expect(await sql(`select email_verified from users where id = $1`, [userId])).toEqual([{ email_verified: true }])
  // 登入方式列表照舊兩列（連結 Google 之後兩種都會顯示「已連結」／「更改密碼」）。
  await expect(page.getByTestId('method-google')).toBeVisible()
  await expect(page.getByTestId('method-password')).toContainText('更改密碼')
})

test('AC-VI-62：登入超過 10 分鐘按「驗證 Email」→ 請重新登入確認，不寄信', async ({ browser }) => {
  const page = await freshPage(browser)
  const { email, userId } = await legacyStudent(page)
  await passwordLogin(page, email)
  await sql(`update sessions set created_at = now() - interval '11 minutes' where user_id = $1`, [userId])

  await page.goto('/account')
  const box = page.getByTestId('verify-email')
  await box.getByRole('button', { name: '驗證 Email' }).click()
  await expect(box.getByRole('alert')).toContainText('請重新登入確認')
  await expect(box.getByLabel('驗證碼第 1 位')).toHaveCount(0)
  expect(await sql(`select count(*)::int as n from mail_outbox where to_email = $1`, [email])).toEqual([{ n: 0 }])
  await box.getByRole('button', { name: '重新登入確認身分' }).click()
  await expect(page).toHaveURL(/\/login\?next=%2Faccount$/)
})

test('已驗證的人在 /account 看不到「驗證 Email」', async ({ browser }) => {
  const page = await freshPage(browser)
  const session = await createTestSession(page.request, 'student')
  await sql(`update users set email_verified = true where id = $1`, [session.userId])
  await page.context().addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
  await page.goto('/account')
  await expect(page.getByTestId('login-email')).toContainText(session.email)
  await expect(page.getByTestId('verify-email')).toHaveCount(0)
})

test('AC-VI-50 首頁段：還沒驗證 Email、還沒送申請的人開 / → /register/verify；驗證過的待審者與訪客照常看首頁', async ({ browser }) => {
  const anonymous = await freshPage(browser)
  await anonymous.goto('/')
  await expect(anonymous).toHaveURL(`${BASE_URL}/`)

  const page = await freshPage(browser)
  const session = await createTestSession(page.request, null)
  await page.context().addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
  await page.goto('/')
  await expect(page).toHaveURL(/\/register\/verify$/)

  await sql(`update users set email_verified = true where id = $1`, [session.userId])
  await page.goto('/')
  await expect(page).toHaveURL(`${BASE_URL}/`)
})

test('AC-VI-51 待審段＋52：三步進度、說明句、帶學生證；修改後只說「已編輯・時間」，整頁沒有「第 N 版」', async ({ browser }) => {
  const page = await freshPage(browser)
  const session = await createTestSession(page.request, null)
  await sql(`update users set email_verified = true where id = $1`, [session.userId])
  await page.context().addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])

  const suffix = String(Date.now()).slice(-5)
  await page.goto('/register/apply')
  await page.getByLabel('姓名').fill(`待審${suffix}`)
  await page.getByLabel('學號').fill(`4${suffix}051`)
  await page.getByLabel('系級').fill('資管二甲')
  await page.getByLabel('手機').fill('0912-345-678')
  await page.getByRole('button', { name: '送出申請' }).click()

  await expect(page).toHaveURL(/\/register\/pending/)
  await expect(page.getByRole('heading', { name: '等待系辦審核' })).toBeVisible()
  const progress = page.getByRole('list', { name: '審核進度' })
  const steps = progress.getByRole('listitem')
  await expect(steps).toHaveCount(3)
  await expect(steps.nth(0)).toHaveAttribute('data-state', 'done')
  await expect(steps.nth(0)).toContainText('已送出')
  await expect(steps.nth(1)).toHaveAttribute('aria-current', 'step')
  await expect(steps.nth(1)).toContainText('系辦審核中')
  await expect(steps.nth(1)).toContainText('通常 1～3 個工作天')
  await expect(steps.nth(2)).toContainText('已開通／被退回')
  await expect(steps.nth(2)).toContainText('結果會寄到你的 Email')
  await expect(page.getByTestId('application-status')).toContainText('由系辦核對，通常 1～3 個工作天。')
  await expect(page.getByTestId('application-status')).toContainText('用 Google 註冊且 Email 與名單相同會立即開通；其他由系辦核對，通常 1～3 個工作天。')
  await expect(page.getByTestId('bring-id')).toContainText('請帶學生證到系辦核對身分')
  await expect(page.getByTestId('bring-id')).toContainText('利瑪竇大樓 LM306')
  await expect(page.getByTestId('bring-id')).toContainText('02-2905-2666')
  const submitted = page.locator('dl[aria-label="目前送出的資料"]')
  await expect(submitted).toContainText(`待審${suffix}`)
  await expect(submitted).toContainText(`4${suffix}051`)
  await expect(submitted).toContainText('送出時間')
  for (const leak of ['名單符合', '未命中', 'Email 相同', 'Email 不同', '第 1 版']) await expect(page.getByText(leak)).toHaveCount(0)
  expect(await sql(`select state, verification_method from registration_applications where user_id = $1`, [session.userId])).toEqual([
    { state: 'pending', verification_method: null },
  ])
  if (SHOT_DIR) await page.screenshot({ path: `${SHOT_DIR}/pending.png`, fullPage: true })

  // AC-VI-52：改手機。
  await page.getByLabel('手機').fill('0922-222-222')
  await page.getByRole('button', { name: '儲存修改' }).click()
  await expect(page.getByRole('status').filter({ hasText: '資料已更新' })).toHaveText('資料已更新，狀態仍是待審核；系辦會看到最新的資料。')
  await expect(submitted).toContainText(/已編輯・\d{4}\/\d{1,2}\/\d{1,2} \d{2}:\d{2}/)
  const history = page.getByRole('list', { name: '修改紀錄' })
  await expect(history.getByRole('listitem')).toHaveCount(2)
  await expect(history.getByRole('listitem').nth(0)).toHaveText(/^\d{4}\/\d{1,2}\/\d{1,2} \d{2}:\d{2}・編輯$/)
  await expect(history.getByRole('listitem').nth(1)).toHaveText(/^\d{4}\/\d{1,2}\/\d{1,2} \d{2}:\d{2}・送出$/)
  await expect(page.getByText(/第 \d+ 版/)).toHaveCount(0)
  if (SHOT_DIR) await page.screenshot({ path: `${SHOT_DIR}/pending-edited.png`, fullPage: true })
})

test('AC-VI-64：Google 回來說同 Email 已有帳號 → 共用 N2 的句子', async ({ page }) => {
  await page.goto('/login?error=account_not_linked')
  await expect(page.getByTestId('google-error')).toHaveText(
    '這個 Email 已經有帳號。請先用 Email 與密碼登入，到「我的帳號」驗證 Email 或連結 Google，之後就可以直接用 Google 登入。',
  )
})
