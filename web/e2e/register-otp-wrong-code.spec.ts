import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession } from './session'

/**
 * Roy 10/18 回報：註冊第 2 步輸入錯誤的驗證碼仍進到下一步（測試站 main 69116fc）。
 *
 * 原本是重現用 spec（repro 分支 `claude/fix-register-otp`），C ⑤-01 搬進來當回歸測試：每個情境一條，
 * 斷言規格（錯碼要被拒、不得進下一步；已驗證時明講＋「到第 3 步」連結；成功轉址是 replace），
 * 同時把「情境｜輸入｜預期｜實際」印成 `[OTP-REPRO]` 行。情境 E、H 依設計方案⑤ §1.2 改寫，
 * AC-3a／AC-3b／AC-6／AC-6a 是「不能誤說已驗證」的反例（驗收案例⑤ AC-1～AC-10）。
 * 要擷取模式（`MAIL_CAPTURE=1`）：驗證碼從 `mail_outbox.body_text` 讀。每個 context 自己的 `x-real-ip`。
 */

const ownerUrl = process.env.DATABASE_URL_OWNER
const run = Date.now().toString(36)
const P1 = 'Repro-Password-One-2026'
const P2 = 'Repro-Password-Two-2026'
const COOLDOWN_MS = 122_000

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
  return `10.233.${(Number(run.slice(-3).replace(/\D/g, '') || 0) % 200) + 1}.${ipCounter}`
}

async function fresh(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ extraHTTPHeaders: { 'x-real-ip': uniqueIp() } })
  return { context, page: await context.newPage() }
}

async function otpMails(email: string) {
  return (await pool.query<{ body_text: string | null }>(`select body_text from mail_outbox where to_email = $1 and template = 'email_otp' order by created_at`, [email])).rows
}

async function latestOtp(email: string, atLeast = 1): Promise<string> {
  for (let i = 0; i < 50; i += 1) {
    const mails = await otpMails(email)
    const otp = /(\d{6})/.exec(mails.at(-1)?.body_text ?? '')?.[1]
    if (otp && mails.length >= atLeast) return otp
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`mail_outbox 沒有 ${email} 的驗證碼`)
}

async function stepOne(page: Page, email: string, password: string) {
  await page.goto('/register')
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByLabel('密碼', { exact: true }).fill(password)
  await page.getByLabel('確認密碼').fill(password)
  await page.getByRole('button', { name: '建立帳號' }).click()
}

async function verified(email: string): Promise<boolean | undefined> {
  return (await pool.query<{ email_verified: boolean }>('select email_verified from users where email = $1', [email])).rows[0]?.email_verified
}

async function otpRows(email: string) {
  return (await pool.query<{ value: string }>(`select value from verifications where identifier = 'email-verification-otp-' || $1 order by created_at`, [email])).rows
}

/** 錯碼：跟正確碼每一位都不同，避免剛好撞上。 */
function wrongFor(otp: string): string {
  return otp
    .split('')
    .map((d) => String((Number(d) + 1) % 10))
    .join('')
}

const otpBox = (page: Page) => page.getByLabel('驗證碼第 1 位')
const mainAlert = (page: Page) => page.getByRole('main').getByRole('alert')
const nextStepLink = (page: Page) => page.getByRole('main').getByRole('link', { name: '到第 3 步' })
const ALREADY_VERIFIED = '這個 Email 已經驗證，請到第 3 步。'
const RESUME_DONE_ELSEWHERE = '這個驗證碼已經用過或換過新的；如果你在另一個分頁已經驗證完成，請直接到第 3 步。'
const RESUME_EXPIRED = '這次續辦已經失效（逾時或有更新的驗證信），請回第 1 步重新填一次。'
const ACCOUNT_ALREADY_VERIFIED = '這個 Email 已經驗證，不用再輸入驗證碼。'
const RESUME_COOKIE = 'fju_signup_resume'

/**
 * 只為了把續辦頁的表單畫出來：頁面只看 cookie 能不能解開（`decodeResume`），票本身要到送碼時才查。
 * AC-6／AC-6a 測的是「票不在」那條路，這張假票在送碼前就被刪掉，不會被拿去驗證。
 */
function placeholderResumeCookie(baseURL: string, email: string) {
  // 跟伺服器設的一樣是 path=/register，伺服器的 `jar.delete({ path: '/register' })` 才刪得到。
  const value = `placeholder.${Buffer.from(email, 'utf8').toString('base64url')}`
  return { name: RESUME_COOKIE, value, domain: new URL(baseURL).hostname, path: '/register', httpOnly: true, sameSite: 'Lax' as const }
}

async function mailCount(email: string): Promise<number> {
  return (await otpMails(email)).length
}

/** 真的「貼上」（走 OtpInput 的 onPaste）：前後空白要經過 fillOtp 的清理。 */
async function pasteOtp(page: Page, text: string) {
  await otpBox(page).evaluate((el, value) => {
    const data = new DataTransfer()
    data.setData('text', value)
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  }, text)
}

/** 目前畫面上的錯誤訊息；沒有就回空字串（`textContent()` 會等元素出現，沒有 alert 時會等到測試逾時）。 */
async function alertText(page: Page): Promise<string> {
  const alert = mainAlert(page)
  if ((await alert.count()) === 0) return ''
  return (await alert.first().textContent({ timeout: 2_000 }).catch(() => ''))?.trim() ?? ''
}

type Outcome = { outcome: 'apply' | 'error' | 'none'; alert: string }

/**
 * 做一個會送出表單的動作，等這一次 POST（Server Action 打目前頁面）回來，再看是導去第 3 步、還是畫面出錯。
 * 不能只看畫面上有沒有 alert：上一輪的錯誤訊息會留在畫面上，直接看會把舊訊息當成這一輪的結果。
 */
async function submitOtp(page: Page, act: () => Promise<void>, pathname = '/register/verify'): Promise<Outcome> {
  const before = await alertText(page)
  const responded = page
    .waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === pathname, { timeout: 15_000 })
    .then(() => true)
    .catch(() => false)
  await act()
  if (!(await responded)) return { outcome: 'none', alert: '（沒有送出 POST）' }
  const navigated = await page.waitForURL(/\/register\/apply/, { timeout: 8_000 }).then(() => true).catch(() => false)
  if (navigated) return { outcome: 'apply', alert: '' }
  // 同一句錯誤會原地不動（文字一樣），等一小段讓新狀態畫上去。
  await page.waitForTimeout(400)
  const alert = await alertText(page)
  return { outcome: alert ? 'error' : 'none', alert: alert === before && alert ? `${alert}（與上一輪同句）` : alert }
}

function row(scenario: string, input: string, expected: string, actual: string) {
  console.log(`[OTP-REPRO] ${scenario} | ${input} | ${expected} | ${actual}`)
}

function trackPosts(page: Page, pathname: string): string[] {
  const posts: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === pathname) posts.push(request.url())
  })
  return posts
}

test('情境 A：全新 Email——錯碼、少一位、空白、前後空白、改網址、上一步再下一步', async ({ browser }) => {
  test.setTimeout(180_000)
  const email = `otp-a-${run}@example.com`
  const { context, page } = await fresh(browser)
  await stepOne(page, email, P1)
  await expect(page).toHaveURL(/\/register\/verify$/)
  const otp = await latestOtp(email)
  const wrong = wrongFor(otp)
  const posts = trackPosts(page, '/register/verify')
  const attempts = async () => (await otpRows(email)).at(-1)?.value.split(':').at(-1) ?? '（沒有列）'

  // A1 六位但錯
  let r = await submitOtp(page, () => otpBox(page).fill(wrong))
  row('A1 全新 Email 錯碼', `${wrong}（正確 ${otp}）`, '拒絕、留在第 2 步', `${r.outcome}「${r.alert}」URL ${new URL(page.url()).pathname}、verified=${await verified(email)}、attempts=${await attempts()}`)
  expect(r.outcome).toBe('error')
  expect(r.alert).toContain('驗證碼不正確')
  await expect(otpBox(page)).toHaveValue('')
  expect(posts).toHaveLength(1)

  // A2 少一位：不會自動送；按「驗證」→ 伺服器回「請輸入完整」
  await otpBox(page).fill(wrong.slice(0, 5))
  await page.waitForTimeout(800)
  expect(posts, '5 位不該自動送出').toHaveLength(1)
  r = await submitOtp(page, () => page.getByRole('button', { name: '驗證', exact: true }).click())
  row('A2 少一位＋按驗證', wrong.slice(0, 5), '拒絕', `${r.outcome}「${r.alert}」URL ${new URL(page.url()).pathname}、attempts=${await attempts()}`)
  expect(r.outcome).toBe('error')
  expect(r.alert).toContain('請輸入完整的 6 位數驗證碼')

  // A3 全空白＋按驗證
  await otpBox(page).fill('')
  r = await submitOtp(page, () => page.getByRole('button', { name: '驗證', exact: true }).click())
  row('A3 空白＋按驗證', '（空）', '拒絕', `${r.outcome}「${r.alert}」`)
  expect(r.outcome).toBe('error')
  expect(await verified(email)).toBe(false)

  // A4 錯碼前後空白（貼上）：fillOtp 只留數字 → 六位錯碼 → 伺服器拒絕
  r = await submitOtp(page, () => pasteOtp(page, `  ${wrong}  `))
  row('A4 錯碼前後空白（貼上）', `"  ${wrong}  "`, '拒絕', `${r.outcome}「${r.alert}」URL ${new URL(page.url()).pathname}、attempts=${await attempts()}`)
  expect(r.outcome).toBe('error')
  expect(await verified(email)).toBe(false)

  // A5 改網址直接進第 3 步／等待審核／學生首頁
  for (const route of ['/register/apply', '/register/pending', '/dashboard/student']) {
    await page.goto(route)
    const landed = new URL(page.url()).pathname
    row('A5 未驗證改網址', route, '帶回 /register/verify', landed)
    await expect(page, route).toHaveURL(/\/register\/verify$/)
  }

  // A6 錯碼後按上一頁再下一頁，再填錯碼
  await page.goBack()
  await page.waitForLoadState('networkidle')
  const backPath = new URL(page.url()).pathname + new URL(page.url()).search
  await page.goForward()
  await page.waitForLoadState('networkidle')
  const forwardPath = new URL(page.url()).pathname
  await expect(page.getByRole('heading', { name: '驗證 Email', level: 1 })).toBeVisible()
  r = await submitOtp(page, () => otpBox(page).fill(wrong))
  row('A6 錯碼後上一頁→下一頁→再錯碼', `back=${backPath}，forward=${forwardPath}，碼 ${wrong}`, '拒絕', `${r.outcome}「${r.alert}」URL ${new URL(page.url()).pathname}、verified=${await verified(email)}、attempts=${await attempts()}`)
  expect(r.outcome).toBe('error')
  expect(await verified(email)).toBe(false)

  // A7 對碼前後空白（貼上）：預期接受（清掉空白後就是正確碼）——對照組
  r = await submitOtp(page, () => pasteOtp(page, ` ${otp} `))
  row('A7 對碼前後空白（貼上，對照）', `" ${otp} "`, '接受（空白被清掉）', `${r.outcome}、verified=${await verified(email)}`)
  expect(r.outcome).toBe('apply')
  expect(await verified(email)).toBe(true)
  await context.close()
})

test('情境 E（改寫，AC-1／AC-2）：正確碼過關到第 3 步 → 上一頁不會回到驗證碼畫面；手動開驗證頁也被導去第 3 步', async ({ browser }) => {
  test.setTimeout(120_000)
  const email = `otp-e-${run}@example.com`
  const { context, page } = await fresh(browser)
  await stepOne(page, email, P1)
  await expect(page).toHaveURL(/\/register\/verify$/)
  const otp = await latestOtp(email)

  // AC-1
  await otpBox(page).fill(otp)
  await expect(page).toHaveURL(/\/register\/apply$/)
  expect(await verified(email)).toBe(true)

  // AC-2：成功轉址是 replace，歷史裡沒有驗證頁那一筆；上一頁落在第 1 步（或更前面）。
  await page.goBack()
  await page.waitForLoadState('networkidle')
  const afterBack = new URL(page.url()).pathname
  const otpVisible = await otpBox(page).isVisible().catch(() => false)
  row('E1 正確碼過關後按上一頁', '（goBack）', '不再看到驗證碼畫面', `URL ${afterBack}、驗證碼格可見=${otpVisible}`)
  expect(afterBack, '上一頁不該回到驗證頁').not.toBe('/register/verify')
  await expect(otpBox(page)).toHaveCount(0)

  await page.goto('/register/verify')
  row('E2 已驗證後手動開驗證頁', '/register/verify', '導去 /register/apply', new URL(page.url()).pathname)
  await expect(page).toHaveURL(/\/register\/apply$/)
  await context.close()
})

test('情境 F（AC-3／AC-4）：兩個分頁——A 填對碼，B 停在舊的驗證碼畫面填錯碼、按重寄 → 明講已驗證＋到第 3 步', async ({ browser }) => {
  test.setTimeout(300_000)
  const email = `otp-f-${run}@example.com`
  const { context, page: a } = await fresh(browser)
  await stepOne(a, email, P1)
  await expect(a).toHaveURL(/\/register\/verify$/)
  const b = await context.newPage()
  await b.goto('/register/verify')
  await expect(b).toHaveURL(/\/register\/verify$/)
  await expect(otpBox(b)).toBeVisible()
  // B 的重寄鈕載入時就倒數 120 秒；等它可按，AC-4 才是真的「按重寄」。
  await new Promise((resolve) => setTimeout(resolve, COOLDOWN_MS))
  const resend = b.getByRole('button', { name: /重寄驗證碼/ })
  await expect(resend).toBeEnabled({ timeout: 60_000 })

  const otp = await latestOtp(email)
  const wrong = wrongFor(otp)
  await otpBox(a).fill(otp)
  await expect(a).toHaveURL(/\/register\/apply$/)
  expect(await verified(email)).toBe(true)

  // AC-3
  const posts = trackPosts(b, '/register/verify')
  const r = await submitOtp(b, () => otpBox(b).fill(wrong))
  row('F 分頁 B 用舊畫面填錯碼', `${wrong}（正確 ${otp}，A 已驗證）`, '錯誤行：已驗證＋到第 3 步', `${r.outcome}「${r.alert}」URL ${new URL(b.url()).pathname}、POST ×${posts.length}`)
  expect(r.outcome, '錯碼不得前進到第 3 步').toBe('error')
  await expect(b).toHaveURL(/\/register\/verify$/)
  await expect(mainAlert(b).first()).toHaveText(ALREADY_VERIFIED)
  await expect(nextStepLink(b)).toHaveAttribute('href', '/register/apply')
  await expect(b.getByText('已重新寄出新的驗證碼')).toHaveCount(0)
  await b.screenshot({ path: test.info().outputPath('ac-3-already-verified.png') })
  await test.info().attach('AC-3 錯誤行', { path: test.info().outputPath('ac-3-already-verified.png'), contentType: 'image/png' })

  // AC-4：重寄 → 同一句＋連結，沒有新信。
  const mailsBefore = await mailCount(email)
  const resendPost = b.waitForResponse((res) => res.request().method() === 'POST' && new URL(res.url()).pathname === '/register/verify')
  await resend.click()
  await resendPost
  const resendLine = b.locator('form').filter({ has: resend }).getByRole('alert')
  await expect(resendLine).toHaveText(ALREADY_VERIFIED)
  await expect(b.locator('form').filter({ has: resend }).getByRole('link', { name: '到第 3 步' })).toHaveAttribute('href', '/register/apply')
  await expect(b).toHaveURL(/\/register\/verify$/)
  await new Promise((resolve) => setTimeout(resolve, 1_000))
  row('F2 分頁 B 按重寄', '（重寄）', '同一句、沒有新信', `信 ${mailsBefore}→${await mailCount(email)}`)
  expect(await mailCount(email)).toBe(mailsBefore)

  // 連結真的帶到第 3 步。
  await nextStepLink(b).first().click()
  await expect(b).toHaveURL(/\/register\/apply$/)
  await context.close()
})

test('AC-3a：分頁 B 開著表單，但這個瀏覽器的 session 已不在 → 不說已驗證，照舊導去登入', async ({ browser }) => {
  test.setTimeout(120_000)
  const email = `otp-3a-${run}@example.com`
  const { context, page: a } = await fresh(browser)
  await stepOne(a, email, P1)
  await expect(a).toHaveURL(/\/register\/verify$/)
  const b = await context.newPage()
  await b.goto('/register/verify')
  await expect(otpBox(b)).toBeVisible()
  const otp = await latestOtp(email)
  await otpBox(a).fill(otp)
  await expect(a).toHaveURL(/\/register\/apply$/)
  expect(await verified(email)).toBe(true)

  // session 不在（例如在 A 登出、或 session 被撤銷）：清掉這個瀏覽器的 cookie。
  await context.clearCookies()
  await otpBox(b).fill(wrongFor(otp))
  await expect(b).toHaveURL(/\/login/)
  row('AC-3a 沒有 session 的舊分頁送碼', wrongFor(otp), '不說已驗證、導去登入', new URL(b.url()).pathname)
  await expect(b.getByText(ALREADY_VERIFIED)).toHaveCount(0)
  await expect(nextStepLink(b)).toHaveCount(0)
  await context.close()
})

test('AC-3b：有本人 session、Email 沒驗證、但已有學生角色 → 送碼與重寄都不說已驗證', async ({ browser }) => {
  test.setTimeout(300_000)
  const email = `otp-3b-${run}@example.com`
  const { context, page: a } = await fresh(browser)
  await stepOne(a, email, P1)
  await expect(a).toHaveURL(/\/register\/verify$/)
  const b = await context.newPage()
  await b.goto('/register/verify')
  await expect(otpBox(b)).toBeVisible()
  const otp = await latestOtp(email)
  // B 的重寄鈕載入就倒數 120 秒；等它可按，再把帳號變成「已核准（有角色）、Email 沒驗證」的舊帳號。
  await new Promise((resolve) => setTimeout(resolve, COOLDOWN_MS))
  const resend = b.getByRole('button', { name: /重寄驗證碼/ })
  await expect(resend).toBeEnabled({ timeout: 60_000 })
  await pool.query(
    `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at)
     select gen_random_uuid(), id, 'student', id, now() from users where email = $1`,
    [email],
  )

  // 送碼：照舊導向（離開驗證頁），不說已驗證。
  await otpBox(a).fill(wrongFor(otp))
  await a.waitForURL((url) => url.pathname !== '/register/verify', { timeout: 15_000 })
  row('AC-3b 有角色未驗證送碼', wrongFor(otp), '不說已驗證、照舊導向', new URL(a.url()).pathname)
  await expect(a.getByText(ALREADY_VERIFIED)).toHaveCount(0)
  await expect(nextStepLink(a)).toHaveCount(0)
  expect(await verified(email)).toBe(false)

  // 重寄：照舊導向，不說已驗證、不寄信。
  const mailsBefore = await mailCount(email)
  await resend.click()
  await b.waitForURL((url) => url.pathname !== '/register/verify', { timeout: 15_000 })
  row('AC-3b 有角色未驗證按重寄', '（重寄）', '不說已驗證、照舊導向、沒有新信', `${new URL(b.url()).pathname}、信 ${mailsBefore}→${await mailCount(email)}`)
  await expect(b.getByText(ALREADY_VERIFIED)).toHaveCount(0)
  await expect(nextStepLink(b)).toHaveCount(0)
  expect(await mailCount(email)).toBe(mailsBefore)
  await context.close()
})

test('情境 B：同 Email 第二次註冊（續辦）——舊碼、錯碼、新碼；完成後上一頁再填錯碼', async ({ browser }) => {
  test.setTimeout(300_000)
  const email = `otp-b-${run}@example.com`
  const { context, page } = await fresh(browser)
  await stepOne(page, email, P1)
  await expect(page).toHaveURL(/\/register\/verify$/)
  const firstOtp = await latestOtp(email)
  await page.getByRole('button', { name: 'Email 打錯了？回上一步修改' }).click()
  await expect(page).toHaveURL(/\/register\?dir=back&email=/)
  await new Promise((resolve) => setTimeout(resolve, COOLDOWN_MS))

  await stepOne(page, email, P2)
  await expect(page).toHaveURL(/\/register\/verify\?resume=1$/)
  const secondOtp = await latestOtp(email, 2)
  expect(secondOtp).not.toBe(firstOtp)
  const here = () => new URL(page.url()).pathname + new URL(page.url()).search

  // B1 舊碼（第一次註冊那封）
  let r = await submitOtp(page, () => otpBox(page).fill(firstOtp))
  row('B1 續辦填第一封的舊碼', `${firstOtp}（新碼 ${secondOtp}）`, '拒絕', `${r.outcome}「${r.alert}」URL ${here()}、verified=${await verified(email)}`)
  expect(r.outcome).toBe('error')
  expect(await verified(email)).toBe(false)

  // B2 錯碼
  const wrong = wrongFor(secondOtp)
  r = await submitOtp(page, () => otpBox(page).fill(wrong))
  row('B2 續辦填錯碼', wrong, '拒絕', `${r.outcome}「${r.alert}」URL ${here()}、verified=${await verified(email)}`)
  expect(r.outcome).toBe('error')
  expect(await verified(email)).toBe(false)

  // B3 新碼 → 第 3 步
  r = await submitOtp(page, () => otpBox(page).fill(secondOtp))
  row('B3 續辦填新碼', secondOtp, '接受 → 第 3 步', `${r.outcome}、URL ${here()}、verified=${await verified(email)}`)
  expect(r.outcome).toBe('apply')
  expect(await verified(email)).toBe(true)

  // B4 續辦完成後上一頁
  await page.goBack()
  await page.waitForTimeout(1500)
  const afterBack = here()
  const otpVisible = await otpBox(page).isVisible().catch(() => false)
  row('B4 續辦完成後按上一頁', '（goBack）', '不該再看到可填的驗證碼畫面', `URL ${afterBack}、驗證碼格可見=${otpVisible}`)
  if (otpVisible) {
    r = await submitOtp(page, () => otpBox(page).fill(wrong))
    row('B5 過期的續辦畫面填錯碼', wrong, '拒絕或明講', `${r.outcome}「${r.alert}」URL ${here()}`)
    expect(r.outcome, '錯碼不得前進到第 3 步').toBe('error')
  }
  await context.close()
})

test('情境 C：重寄後——第一封的碼、錯碼、第二封的碼', async ({ browser }) => {
  test.setTimeout(300_000)
  const email = `otp-c-${run}@example.com`
  const { context, page } = await fresh(browser)
  await stepOne(page, email, P1)
  await expect(page).toHaveURL(/\/register\/verify$/)
  const firstOtp = await latestOtp(email)
  await new Promise((resolve) => setTimeout(resolve, COOLDOWN_MS))
  const resend = page.getByRole('button', { name: /重寄驗證碼/ })
  // 倒數是瀏覽器端的 setTimeout；headless 分頁的計時器會被節流、倒數比牆鐘慢，所以多等到按鈕真的可按。
  await expect(resend).toBeEnabled({ timeout: 60_000 })
  await resend.click()
  await expect(page.getByText('已重新寄出新的驗證碼')).toBeVisible()
  const secondOtp = await latestOtp(email, 2)
  expect(secondOtp).not.toBe(firstOtp)
  const rowsBefore = (await otpRows(email)).length

  // C1 第一封的碼
  let r = await submitOtp(page, () => otpBox(page).fill(firstOtp))
  row('C1 重寄後填第一封的碼', `${firstOtp}（第二封 ${secondOtp}）`, '拒絕（舊碼作廢）', `${r.outcome}「${r.alert}」verified=${await verified(email)}、verifications 列 ${rowsBefore}→${(await otpRows(email)).length}`)
  expect(r.outcome).toBe('error')
  expect(await verified(email)).toBe(false)

  // C2 錯碼
  const wrong = wrongFor(secondOtp)
  r = await submitOtp(page, () => otpBox(page).fill(wrong))
  row('C2 重寄後填錯碼', wrong, '拒絕', `${r.outcome}「${r.alert}」verified=${await verified(email)}`)
  expect(r.outcome).toBe('error')

  // C3 第二封的碼
  r = await submitOtp(page, () => otpBox(page).fill(secondOtp))
  row('C3 重寄後填第二封的碼', secondOtp, '接受 → 第 3 步', `${r.outcome}、verified=${await verified(email)}`)
  expect(r.outcome).toBe('apply')
  expect(await verified(email)).toBe(true)
  await context.close()
})

async function loginAsUnverifiedStudent(page: Page, email: string): Promise<string> {
  const session = await createTestSession(page.request, 'student')
  await pool.query('update users set email = $2, email_verified = false where id = $1', [session.userId, email])
  await pool.query('delete from sessions where user_id = $1', [session.userId])
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('密碼', { exact: true }).fill('E2e-Password-Correct-9')
  await page.getByRole('button', { name: '登入', exact: true }).click()
  await expect(page).toHaveURL(/\/dashboard\/student$/)
  return session.userId
}

test('情境 G（AC-7／AC-8）：「我的帳號」驗證 Email——帳號已在別處驗證，舊畫面填錯碼、按驗證 Email → 明講已驗證', async ({ browser }) => {
  test.setTimeout(120_000)
  const { context, page } = await fresh(browser)
  const email = `otp-g-${run}@example.com`
  const userId = await loginAsUnverifiedStudent(page, email)

  await page.goto('/account')
  const box = page.getByTestId('verify-email')
  await box.getByRole('button', { name: '驗證 Email' }).click()
  await expect(box.getByLabel('驗證碼第 6 位')).toBeVisible()
  const otp = await latestOtp(email)
  const wrong = wrongFor(otp)
  // 另一個分頁還停在沒按過「驗證 Email」的帳號頁（AC-8 用）。
  const other = await context.newPage()
  await other.goto('/account')
  const otherBox = other.getByTestId('verify-email')
  await expect(otherBox.getByRole('button', { name: '驗證 Email' })).toBeVisible()

  // 模擬「別處已驗證」（另一個分頁／裝置用正確碼驗過）：直接把 email_verified 設成 true，驗證碼列清掉。
  await pool.query('update users set email_verified = true where id = $1', [userId])
  await pool.query(`delete from verifications where identifier = 'email-verification-otp-' || $1`, [email])

  // AC-7
  await box.getByLabel('驗證碼第 1 位').fill(wrong)
  await box.getByRole('button', { name: '確認驗證碼' }).click()
  const result = await Promise.race([
    page.waitForURL(/\/account\?verified=email/, { timeout: 15_000 }).then(() => 'verified-banner' as const),
    box.getByRole('alert').waitFor({ timeout: 15_000 }).then(() => 'error' as const),
  ]).catch(() => 'none' as const)
  row('G 我的帳號：舊畫面填錯碼（帳號已在別處驗證）', `${wrong}（正確 ${otp}）`, '錯誤行：已驗證、不用再輸入', `${result}、URL ${new URL(page.url()).pathname}${new URL(page.url()).search}`)
  expect(result, '錯碼不得得到「Email 已驗證」的成功畫面').toBe('error')
  await expect(box.getByRole('alert')).toHaveText(ACCOUNT_ALREADY_VERIFIED)
  await expect(page.getByTestId('account-notice')).toHaveCount(0)
  await page.reload()
  await expect(page.getByTestId('verify-email')).toHaveCount(0)
  await expect(page.getByTestId('account-notice')).toHaveCount(0)

  // AC-8：舊分頁按「驗證 Email」（寄碼）→ 同一句、沒有新信。
  const mailsBefore = await mailCount(email)
  await otherBox.getByRole('button', { name: '驗證 Email' }).click()
  await expect(otherBox.getByRole('alert')).toHaveText(ACCOUNT_ALREADY_VERIFIED)
  await expect(other).toHaveURL(/\/account$/)
  row('G2 我的帳號：舊分頁按驗證 Email', '（寄碼）', '同一句、沒有新信', `信 ${mailsBefore}→${await mailCount(email)}`)
  expect(await mailCount(email)).toBe(mailsBefore)
  await context.close()
})

test('AC-9：「我的帳號」正常驗證 → 通知；上一頁不會回到含驗證表單的帳號頁', async ({ browser }) => {
  test.setTimeout(120_000)
  const { context, page } = await fresh(browser)
  const email = `otp-9-${run}@example.com`
  await loginAsUnverifiedStudent(page, email)
  await page.goto('/account')
  const box = page.getByTestId('verify-email')
  await box.getByRole('button', { name: '驗證 Email' }).click()
  await expect(box.getByLabel('驗證碼第 6 位')).toBeVisible()
  await box.getByLabel('驗證碼第 1 位').fill(await latestOtp(email))
  await box.getByRole('button', { name: '確認驗證碼' }).click()
  await expect(page).toHaveURL(/\/account\?verified=email$/)
  await expect(page.getByTestId('account-notice')).toBeVisible()
  expect(await verified(email)).toBe(true)

  await page.goBack()
  await page.waitForLoadState('networkidle')
  row('AC-9 帳號頁驗證後按上一頁', '（goBack）', '不回到含驗證表單的帳號頁', `${new URL(page.url()).pathname}${new URL(page.url()).search}`)
  await expect(page.getByTestId('verify-email')).toHaveCount(0)
  await context.close()
})

test('情境 H：續辦模式兩個分頁——A 填新碼完成續辦，B 停在舊的續辦畫面填錯碼', async ({ browser }) => {
  test.setTimeout(300_000)
  const email = `otp-h-${run}@example.com`
  const { context, page: a } = await fresh(browser)
  await stepOne(a, email, P1)
  await expect(a).toHaveURL(/\/register\/verify$/)
  await a.getByRole('button', { name: 'Email 打錯了？回上一步修改' }).click()
  await expect(a).toHaveURL(/\/register\?dir=back&email=/)
  await new Promise((resolve) => setTimeout(resolve, COOLDOWN_MS))
  await stepOne(a, email, P2)
  await expect(a).toHaveURL(/\/register\/verify\?resume=1$/)
  const secondOtp = await latestOtp(email, 2)
  const wrong = wrongFor(secondOtp)

  const b = await context.newPage()
  await b.goto('/register/verify?resume=1')
  await expect(b).toHaveURL(/\/register\/verify\?resume=1$/)
  await expect(otpBox(b)).toBeVisible()

  await otpBox(a).fill(secondOtp)
  await expect(a).toHaveURL(/\/register\/apply$/)
  expect(await verified(email)).toBe(true)

  const posts = trackPosts(b, '/register/verify')
  const r = await submitOtp(b, () => otpBox(b).fill(wrong))
  const cookies = (await context.cookies()).map((c) => c.name)
  row('H 續辦分頁 B 用舊畫面填錯碼', `${wrong}（新碼 ${secondOtp}，A 已完成續辦）`, '錯誤行：可能已在另一個分頁完成＋到第 3 步', `${r.outcome}「${r.alert}」URL ${new URL(b.url()).pathname}${new URL(b.url()).search}、POST ×${posts.length}、cookie=${JSON.stringify(cookies)}`)
  expect(r.outcome, '錯碼不得前進到第 3 步').toBe('error')
  await expect(mainAlert(b).first()).toHaveText(RESUME_DONE_ELSEWHERE)
  await expect(nextStepLink(b)).toHaveAttribute('href', '/register/apply')
  await context.close()
})

test('AC-6／AC-6a：續辦票不在——沒有本人 session、或有 session 但沒驗證 → 維持「回第 1 步」原句、沒有到第 3 步連結', async ({ browser, baseURL }) => {
  test.setTimeout(120_000)
  if (!baseURL) throw new Error('需要 baseURL')

  // AC-6：沒有任何 session。
  const plainEmail = `otp-6-${run}@example.com`
  const { context, page } = await fresh(browser)
  await context.addCookies([placeholderResumeCookie(baseURL, plainEmail)])
  await page.goto('/register/verify?resume=1')
  await expect(otpBox(page)).toBeVisible()
  await context.clearCookies({ name: RESUME_COOKIE })
  let r = await submitOtp(page, () => otpBox(page).fill('123456'))
  row('AC-6 續辦票不在、沒有 session', '123456', '原句（回第 1 步）', `${r.outcome}「${r.alert}」`)
  expect(r.outcome).toBe('error')
  await expect(mainAlert(page).first()).toHaveText(RESUME_EXPIRED)
  await expect(nextStepLink(page)).toHaveCount(0)
  await context.close()

  // AC-6a：同一個瀏覽器有本人 session（剛註冊、還沒驗證），續辦票不在。
  const email = `otp-6a-${run}@example.com`
  const { context: ctx2, page: tab } = await fresh(browser)
  await ctx2.addCookies([placeholderResumeCookie(baseURL, email)])
  const resumeTab = await ctx2.newPage()
  await resumeTab.goto('/register/verify?resume=1')
  await expect(otpBox(resumeTab)).toBeVisible()
  // 在另一個分頁走第 1 步：拿到受限 session（Email 未驗證），一般註冊也會刪掉續辦票。
  await stepOne(tab, email, P1)
  await expect(tab).toHaveURL(/\/register\/verify$/)
  expect((await ctx2.cookies()).map((c) => c.name)).not.toContain(RESUME_COOKIE)
  expect(await verified(email)).toBe(false)
  r = await submitOtp(resumeTab, () => otpBox(resumeTab).fill('123456'))
  row('AC-6a 續辦票不在、有 session 但沒驗證', '123456', '原句（回第 1 步）', `${r.outcome}「${r.alert}」`)
  expect(r.outcome).toBe('error')
  await expect(mainAlert(resumeTab).first()).toHaveText(RESUME_EXPIRED)
  await expect(nextStepLink(resumeTab)).toHaveCount(0)
  await ctx2.close()
})
