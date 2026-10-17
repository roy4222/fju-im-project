import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, toPlaywrightCookie } from './session'

/**
 * VB-3 註冊三步（visitor-r3 §3.3；AC-VI-45、46、48、49、50、51 第 3 步段、54 畫面段）。
 *
 * 要擷取模式（`MAIL_CAPTURE=1`）：第 2 步的驗證碼從 `mail_outbox.body_text` 讀。
 * 每個瀏覽器 context 用自己的 `X-Real-IP`，註冊與寄碼的 IP 桶不跟其他 spec 搶。
 * Turnstile widget 的有無由 `turnstile.spec.ts` 驗（CI 不設金鑰，這裡看不到 widget）。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER
const run = Date.now().toString(36)
const P1 = 'Step-Password-One-2026'
const P2 = 'Step-Password-Two-2026'

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
  return `10.231.${(Number(run.slice(-3).replace(/\D/g, '') || 0) % 200) + 1}.${ipCounter}`
}

async function fresh(browser: Browser, viewport = { width: 1280, height: 900 }): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ extraHTTPHeaders: { 'x-real-ip': uniqueIp() }, viewport })
  return { context, page: await context.newPage() }
}

async function otpMails(email: string) {
  return (
    await pool.query<{ subject: string; body_text: string | null; status: string }>(
      `select subject, body_text, status from mail_outbox where to_email = $1 and template = 'email_otp' order by created_at`,
      [email],
    )
  ).rows
}

async function latestOtp(email: string): Promise<string> {
  for (let i = 0; i < 50; i += 1) {
    const otp = /(\d{6})/.exec((await otpMails(email)).at(-1)?.body_text ?? '')?.[1]
    if (otp) return otp
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

async function userRow(email: string) {
  return (
    await pool.query<{ id: string; email_verified: boolean; status: string }>(
      'select id, email_verified, status from users where email = $1',
      [email],
    )
  ).rows[0]
}

const progress = (page: Page) => page.getByRole('list', { name: '註冊進度' })

test('AC-VI-45：第 1 步只有 Email、密碼、確認密碼；桌機左圖右卡、手機沒有圖；11 字密碼在瀏覽器就擋下', async ({ browser }) => {
  const { context, page } = await fresh(browser)
  await page.goto('/register')
  await expect(page.getByRole('heading', { name: '建立帳號', level: 1 })).toBeVisible()
  const steps = progress(page).getByRole('listitem')
  await expect(steps).toHaveCount(3)
  await expect(steps.nth(0)).toContainText('建立帳號')
  await expect(steps.nth(1)).toContainText('驗證 Email')
  await expect(steps.nth(2)).toContainText('填學生資料')
  await expect(steps.nth(0)).toHaveAttribute('aria-current', 'step')
  await expect(page.getByRole('button', { name: '使用 Google 帳號註冊' })).toBeVisible()
  await expect(page.getByLabel('Email', { exact: true })).toHaveAttribute('placeholder', 'name@mail.fju.edu.tw')
  await expect(page.getByRole('button', { name: '顯示密碼' })).toHaveCount(2)
  await expect(page.getByLabel('確認密碼')).toBeVisible()
  await expect(page.getByText('繼續即表示你同意本站的隱私權政策')).toBeVisible()
  await expect(page.getByRole('main').getByRole('link', { name: '隱私權政策' })).toHaveAttribute('href', '/privacy')
  await expect(page.getByRole('button', { name: '建立帳號' })).toBeVisible()
  for (const label of ['姓名', '學號', '系級', '手機']) await expect(page.getByLabel(label)).toHaveCount(0)
  // ≥1024px：左邊校園照片看得到。
  await expect(page.getByRole('img', { name: '輔仁大學校園' })).toBeVisible()
  await page.screenshot({ path: 'e2e/.artifacts/vb3-step1-desktop.png', fullPage: true })

  // 11 字：欄位下紅字，沒有送出（沒有任何 POST）。
  const posts: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST') posts.push(request.url())
  })
  await page.getByLabel('Email', { exact: true }).fill(`vb3-short-${run}@example.com`)
  await page.getByLabel('密碼', { exact: true }).fill('a'.repeat(11))
  await page.getByLabel('確認密碼').fill('a'.repeat(11))
  await page.getByRole('button', { name: '建立帳號' }).click()
  await expect(page.getByText('密碼至少 12 字')).toBeVisible()
  await page.waitForTimeout(500)
  expect(posts).toEqual([])
  expect(await userRow(`vb3-short-${run}@example.com`)).toBeUndefined()
  await context.close()

  // 手機寬度（390）：沒有左圖，只有卡片。
  const mobile = await fresh(browser, { width: 390, height: 844 })
  await mobile.page.goto('/register')
  await expect(mobile.page.getByRole('img', { name: '輔仁大學校園' })).toBeHidden()
  await expect(mobile.page.getByRole('button', { name: '建立帳號' })).toBeVisible()
  const overflows = await mobile.page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)
  expect(overflows).toBe(false)
  await mobile.page.screenshot({ path: 'e2e/.artifacts/vb3-step1-mobile.png', fullPage: true })
  await mobile.context.close()
})

test('AC-VI-46／48／51／50：建立帳號 → 驗證碼由伺服器寄出 → 填碼 → 填學生資料 → 等待審核；未驗證時其他頁都帶回第 2 步', async ({
  browser,
}) => {
  const email = `vb3-s1-${run}@example.com`
  const { context, page } = await fresh(browser)
  const otpRequests: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('/api/auth/email-otp/')) otpRequests.push(request.url())
  })

  await stepOne(page, email, P1)
  await expect(page).toHaveURL(/\/register\/verify$/)
  await expect(page.getByText(`驗證碼已寄到 ${email}，10 分鐘內有效`)).toBeVisible()
  await expect(page.getByRole('group', { name: '6 位數驗證碼' }).getByRole('textbox')).toHaveCount(6)
  const resend = page.getByRole('button', { name: /重寄驗證碼/ })
  await expect(resend).toContainText(/1[12]\d 秒後可重寄/)
  await expect(resend).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Email 打錯了？回上一步修改' })).toBeVisible()
  await expect(progress(page).getByRole('listitem').nth(1)).toHaveAttribute('aria-current', 'step')
  await page.screenshot({ path: 'e2e/.artifacts/vb3-step2-desktop.png', fullPage: true })
  // 首封由 sign-up 在伺服器內寄：瀏覽器沒有打任何寄碼端點。
  expect(otpRequests).toEqual([])

  const user = await userRow(email)
  expect(user).toMatchObject({ email_verified: false, status: 'pending' })
  const mails = await otpMails(email)
  expect(mails).toHaveLength(1)
  expect(mails[0]).toMatchObject({ status: 'captured', subject: '【專題管理平台】Email 驗證碼' })
  expect(mails[0]!.subject).not.toMatch(/\d{6}/)
  const otp = await latestOtp(email)
  // storeOTP: 'hashed'：資料庫裡沒有明文碼。
  const stored = await pool.query<{ value: string }>(`select value from verifications where identifier like '%' || $1 || '%'`, [email])
  expect(stored.rows.length).toBeGreaterThan(0)
  for (const row of stored.rows) expect(row.value).not.toContain(otp)
  const apps = await pool.query('select 1 from registration_applications where user_id = $1', [user!.id])
  expect(apps.rowCount).toBe(0)

  // AC-VI-50：還沒驗證，開第 3 步、等待審核頁、學生首頁都被帶回第 2 步。
  for (const route of ['/register/apply', '/register/pending', '/dashboard/student']) {
    await page.goto(route)
    await expect(page, route).toHaveURL(/\/register\/verify$/)
  }

  // 錯的碼：同一句、欄位清空；**只送一次**（Review：清空與自動送出曾在同一輪各跑一次，一次錯碼變兩次 POST）。
  const verifyPosts: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/register/verify') verifyPosts.push(request.url())
  })
  const wrong = otp === '000000' ? '111111' : '000000'
  await page.getByLabel('驗證碼第 1 位').fill(wrong)
  await expect(page.getByRole('main').getByRole('alert')).toContainText('驗證碼不正確')
  await expect(page.getByLabel('驗證碼第 1 位')).toHaveValue('')
  await page.waitForTimeout(1000)
  expect(verifyPosts).toHaveLength(1)
  // 套件把錯誤次數記在驗證碼那一列（`<hash>:<次數>`）：一次錯碼只算一次。
  const attempts = await pool.query<{ value: string }>(
    `select value from verifications where identifier = 'email-verification-otp-' || $1 order by created_at desc limit 1`,
    [email],
  )
  expect(attempts.rows[0]?.value.split(':').at(-1)).toBe('1')

  // AC-VI-48：正確的碼 → 第 3 步；第 2 格打勾、第 3 格 current；驗證碼那列被刪。
  await page.getByLabel('驗證碼第 1 位').fill(otp)
  await expect(page).toHaveURL(/\/register\/apply$/)
  const steps = progress(page).getByRole('listitem')
  await expect(steps.nth(1)).toHaveAttribute('data-state', 'done')
  await expect(steps.nth(2)).toHaveAttribute('aria-current', 'step')
  expect((await userRow(email))!.email_verified).toBe(true)
  const left = await pool.query(`select 1 from verifications where identifier like 'email-verification-otp-%' || $1`, [email])
  expect(left.rowCount).toBe(0)

  // AC-VI-51 第 3 步段：沒有密碼欄、聯絡 Email 預填登入 Email。
  await expect(page.getByLabel('密碼', { exact: true })).toHaveCount(0)
  await expect(page.getByLabel('聯絡 Email')).toHaveValue(email)
  await page.screenshot({ path: 'e2e/.artifacts/vb3-step3-desktop.png', fullPage: true })
  await page.getByLabel('姓名').fill(`王小明${run}`)
  await page.getByLabel('學號').fill(`4${String(Date.now()).slice(-8)}`)
  await page.getByLabel('系級').fill('資管二甲')
  await page.getByLabel('手機').fill('0912-345-678')
  await page.getByRole('button', { name: '送出申請' }).click()
  await expect(page).toHaveURL(/\/register\/pending$/)
  await expect(page.getByRole('heading', { name: '等待系辦審核' })).toBeVisible()
  const app = await pool.query<{ state: string; verification_method: string | null }>(
    'select state, verification_method from registration_applications where user_id = $1',
    [user!.id],
  )
  expect(app.rows).toEqual([{ state: 'pending', verification_method: null }])
  // 已送出：再開第 2、3 步都到等待審核頁。
  for (const route of ['/register/verify', '/register/apply']) {
    await page.goto(route)
    await expect(page, route).toHaveURL(/\/register\/pending$/)
  }
  await context.close()
})

test('AC-VI-50：未驗證的人直接送第 3 步 → 「請先完成 Email 驗證。」、沒有申請列', async ({ browser }) => {
  const email = `vb3-unverified-${run}@example.com`
  const { context, page } = await fresh(browser)
  await stepOne(page, email, P1)
  await expect(page).toHaveURL(/\/register\/verify$/)
  // 先當作已驗證讓第 3 步的頁面打得開，再改回未驗證後送出：伺服器那一層要自己擋。
  await pool.query('update users set email_verified = true where email = $1', [email])
  await page.goto('/register/apply')
  await expect(page).toHaveURL(/\/register\/apply$/)
  await pool.query('update users set email_verified = false where email = $1', [email])
  await page.getByLabel('姓名').fill('未驗證')
  await page.getByLabel('學號').fill('411499100')
  await page.getByLabel('系級').fill('資管二甲')
  await page.getByLabel('手機').fill('0912-345-678')
  await page.getByRole('button', { name: '送出申請' }).click()
  await expect(page.getByRole('main').getByRole('alert')).toHaveText('請先完成 Email 驗證。')
  const user = await userRow(email)
  const apps = await pool.query('select 1 from registration_applications where user_id = $1', [user!.id])
  expect(apps.rowCount).toBe(0)
  await context.close()
})

test('AC-VI-50（Review P1）：未驗證的人經等待審核頁舊的「送出申請資料」入口送第一份申請 → 擋下、不建申請', async ({ browser }) => {
  const email = `vb3-legacy-${run}@example.com`
  const { context, page } = await fresh(browser)
  await stepOne(page, email, P1)
  await expect(page).toHaveURL(/\/register\/verify$/)
  // 讓等待審核頁打得開（那頁對沒申請的人顯示舊的送出表單），再改回未驗證後送出：舊 Action 自己要擋。
  await pool.query('update users set email_verified = true where email = $1', [email])
  await page.goto('/register/pending')
  await expect(page.getByRole('heading', { name: '還沒送出申請資料' })).toBeVisible()
  await pool.query('update users set email_verified = false where email = $1', [email])
  await page.getByLabel('姓名').fill('舊入口')
  await page.getByLabel('學號').fill('411499101')
  await page.getByLabel('系級').fill('資管二甲')
  await page.getByLabel('手機').fill('0912-345-678')
  await page.getByRole('button', { name: '送出申請' }).click()
  await expect(page.getByRole('main').getByRole('alert')).toHaveText('請先完成 Email 驗證。')
  const user = await userRow(email)
  expect((await pool.query('select 1 from registration_applications where user_id = $1', [user!.id])).rowCount).toBe(0)
  await context.close()
})

test('AC-VI-49：回上一步只登出不刪資料；同 Email 新密碼續辦；舊 session 失效；既有帳號一律同一句、不寄信', async ({ browser, playwright }) => {
  test.setTimeout(240_000)
  const email = `vb3-resume-${run}@example.com`
  const a = await fresh(browser)
  await stepOne(a.page, email, P1)
  await expect(a.page).toHaveURL(/\/register\/verify$/)
  const before = await userRow(email)

  // 另一個 context B 用第一次的密碼登入，停在第 2 步。
  const b = await fresh(browser)
  await b.page.goto('/login')
  await b.page.getByLabel('Email').fill(email)
  await b.page.getByLabel('密碼', { exact: true }).fill(P1)
  await b.page.getByRole('button', { name: '登入', exact: true }).click()
  await expect(b.page).toHaveURL(/\/register\/verify$/)

  const counts = async () =>
    (await pool.query<{ users: string; accounts: string }>('select (select count(*) from users) as users, (select count(*) from accounts) as accounts')).rows[0]!
  const countsBefore = await counts()

  // 1) 回上一步：登出、Email 預填、資料一列都沒刪。
  await a.page.getByRole('button', { name: 'Email 打錯了？回上一步修改' }).click()
  await expect(a.page).toHaveURL(new RegExp(`/register\\?email=${encodeURIComponent(email).replace(/[.]/g, '\\.')}$`))
  await expect(a.page.getByLabel('Email', { exact: true })).toHaveValue(email)
  expect(await a.context.cookies()).not.toContainEqual(expect.objectContaining({ name: expect.stringMatching(/session_token/) }))
  expect(await userRow(email)).toEqual(before)

  // 第一封的 120 秒冷卻過了才能續辦寄碼（伺服器擋，不是畫面）。
  await new Promise((resolve) => setTimeout(resolve, 122_000))

  // 2) 同 Email、新密碼 P2 → 續辦：寄一封新的碼、帶去第 2 步續辦模式。
  const mailsBefore = (await otpMails(email)).length
  await stepOne(a.page, email, P2)
  await expect(a.page).toHaveURL(/\/register\/verify\?resume=1$/)
  await expect(a.page.getByText('這個 Email 有一筆還沒完成的註冊。驗證碼已寄到這個信箱，填入後就能繼續。')).toBeVisible()
  expect((await otpMails(email)).length).toBe(mailsBefore + 1)

  // 3) 填碼 → 第 3 步；同一列、id 不變、已驗證。
  await a.page.getByLabel('驗證碼第 1 位').fill(await latestOtp(email))
  await expect(a.page).toHaveURL(/\/register\/apply$/)
  const after = await userRow(email)
  expect(after).toMatchObject({ id: before!.id, email_verified: true })
  expect((await pool.query('select 1 from users where email = $1', [email])).rowCount).toBe(1)

  // 4) context B 的舊 session 失效。
  await b.page.goto('/register/verify')
  await expect(b.page).toHaveURL(/\/login/)

  // P2 能登入、P1 不能。
  const c = await fresh(browser)
  for (const [password, ok] of [
    [P1, false],
    [P2, true],
  ] as const) {
    await c.context.clearCookies()
    await c.page.goto('/login')
    await c.page.getByLabel('Email').fill(email)
    await c.page.getByLabel('密碼', { exact: true }).fill(password)
    await c.page.getByRole('button', { name: '登入', exact: true }).click()
    if (ok) await expect(c.page).toHaveURL(/\/register\/apply$|\/register\/pending$/)
    else await expect(c.page.getByText('Email 或密碼不正確')).toBeVisible()
  }

  // 5) 預授權老師（active＋teacher、沒有登入方式）、已核准學生、停用帳號：同一句、不寄信、不進續辦。
  const teacherEmail = `vb3-t-${run}@example.com`
  await pool.query(
    `with u as (insert into users (id, name, email, email_verified, updated_at, status)
                values (gen_random_uuid(), '預授權老師', $1, false, now(), 'active') returning id)
     insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at) select gen_random_uuid(), id, 'teacher', id, now() from u`,
    [teacherEmail],
  )
  // 一個 request context 只註冊一個帳號：帶著前一個的 cookie 再註冊會被 Better Auth 的 Origin 檢查擋。
  const mint = async (role: 'student' | null) => {
    const request = await playwright.request.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { 'x-real-ip': uniqueIp() } })
    return createTestSession(request, role).finally(() => request.dispose())
  }
  const student = await mint('student')
  const disabled = await mint(null)
  await pool.query(`update users set status = 'disabled' where id = $1`, [disabled.userId])
  for (const target of [teacherEmail, student.email, disabled.email]) {
    const mailsFor = (await pool.query('select 1 from mail_outbox where to_email = $1', [target])).rowCount
    const d = await fresh(browser)
    await stepOne(d.page, target, P2)
    await expect(d.page.getByRole('main').getByRole('alert')).toHaveText('這個 Email 無法用來註冊。如果你已經有帳號，請直接登入。')
    await expect(d.page).toHaveURL(/\/register$/)
    expect((await pool.query('select 1 from mail_outbox where to_email = $1', [target])).rowCount, target).toBe(mailsFor)
    await d.context.close()
  }
  const countsAfter = await counts()
  expect(Number(countsAfter.users)).toBeGreaterThanOrEqual(Number(countsBefore.users))
  expect(Number(countsAfter.accounts)).toBeGreaterThanOrEqual(Number(countsBefore.accounts))
  for (const x of [a, b, c]) await x.context.close()
})

test('AC-VI-49（Review P3）＋第 3 輪：續辦頁有重寄；冷卻內送出被伺服器擋；10 分鐘視窗過了、冷卻後重寄照常收到新碼（視窗復活）、用新碼完成', async ({ browser }) => {
  test.setTimeout(420_000)
  const email = `vb3-resume-resend-${run}@example.com`
  const { context, page } = await fresh(browser)
  await stepOne(page, email, P1)
  await expect(page).toHaveURL(/\/register\/verify$/)
  await page.getByRole('button', { name: 'Email 打錯了？回上一步修改' }).click()
  await expect(page).toHaveURL(/\/register\?email=/)
  // 第一封的冷卻過了才能開始續辦。
  await new Promise((resolve) => setTimeout(resolve, 122_000))
  await stepOne(page, email, P2)
  await expect(page).toHaveURL(/\/register\/verify\?resume=1$/)
  const firstOtp = await latestOtp(email)

  // 續辦頁有重寄鈕，剛寄過所以倒數中、disabled。
  const resend = page.getByRole('button', { name: /重寄驗證碼/ })
  await expect(resend).toContainText(/秒後可重寄/)
  await expect(resend).toBeDisabled()

  // 冷卻內硬送（拿掉 disabled）：伺服器擋下、不寄信。
  const mails = (await otpMails(email)).length
  await resend.evaluate((el) => el.removeAttribute('disabled'))
  await resend.click()
  await expect(page.getByRole('main').getByRole('alert')).toContainText('驗證碼剛寄出')
  expect((await otpMails(email)).length).toBe(mails)

  // 這封碼的 10 分鐘視窗過了（只改伺服器存的 windowEndAt；截止 30 分鐘未到）：截止內的重寄要照常寄、把視窗重開（主腦裁定）。
  // 續辦票 cookie 活到截止＋10 分鐘，所以瀏覽器這時還帶得回票。
  const pendingRow = await pool.query<{ value: string }>('select value from verifications where identifier = $1', [`signup-resume:${email}`])
  await pool.query('update verifications set value = $2 where identifier = $1', [
    `signup-resume:${email}`,
    JSON.stringify({ ...(JSON.parse(pendingRow.rows[0]!.value) as object), windowEndAt: Date.now() - 1_000 }),
  ])
  // 冷卻過後重寄：多一封新碼。
  await new Promise((resolve) => setTimeout(resolve, 122_000))
  await expect(resend).toBeEnabled()
  await resend.click()
  await expect(page.getByText('已重新寄出新的驗證碼')).toBeVisible()
  await expect.poll(async () => (await otpMails(email)).length).toBe(mails + 1)
  const newOtp = await latestOtp(email)
  expect(newOtp).not.toBe(firstOtp)

  // 視窗重開：windowEndAt 變回未來、截止不變；用新碼完成續辦 → 第 3 步；P2 是新密碼。
  const revived = JSON.parse(
    (await pool.query<{ value: string }>('select value from verifications where identifier = $1', [`signup-resume:${email}`])).rows[0]!.value,
  ) as { windowEndAt: number; deadlineAt: number }
  expect(revived.windowEndAt).toBeGreaterThan(Date.now())
  expect(revived.deadlineAt).toBe((JSON.parse(pendingRow.rows[0]!.value) as { deadlineAt: number }).deadlineAt)
  await page.getByLabel('驗證碼第 1 位').fill(newOtp)
  await expect(page).toHaveURL(/\/register\/apply$/)
  expect((await userRow(email))!.email_verified).toBe(true)
  await context.close()
})

test('主腦裁定（VB-3 Review 第 3 輪）：續辦過了絕對截止再重寄 → 「續辦已逾時，請重新開始」、填碼回已失效、重新開始連結回第 1 步', async ({ browser }) => {
  test.setTimeout(300_000)
  const email = `vb3-resume-timeout-${run}@example.com`
  const { context, page } = await fresh(browser)
  await stepOne(page, email, P1)
  await expect(page).toHaveURL(/\/register\/verify$/)
  await page.getByRole('button', { name: 'Email 打錯了？回上一步修改' }).click()
  await expect(page).toHaveURL(/\/register\?email=/)
  // 第一封的冷卻過了才能開始續辦。
  await new Promise((resolve) => setTimeout(resolve, 122_000))
  await stepOne(page, email, P2)
  await expect(page).toHaveURL(/\/register\/verify\?resume=1$/)
  const mails = (await otpMails(email)).length
  // 續辦票 cookie 的壽命＝截止（30 分鐘）＋10 分鐘，跟伺服器的暫存列一樣長（視窗過了還能重寄；過了截止一定看得到逾時句）。
  const ticketCookie = (await context.cookies()).find((c) => c.name === 'fju_signup_resume')
  expect(ticketCookie).toBeDefined()
  expect(ticketCookie!.expires).toBeGreaterThan(Date.now() / 1000 + 39 * 60)
  expect(ticketCookie!.expires).toBeLessThanOrEqual(Date.now() / 1000 + 40 * 60 + 5)

  // 絕對截止只看伺服器存在暫存列的值：把它改成已過（不用真的等 30 分鐘）。
  const pending = await pool.query<{ value: string }>('select value from verifications where identifier = $1', [`signup-resume:${email}`])
  const parsed = JSON.parse(pending.rows[0]!.value) as { deadlineAt: number }
  await pool.query('update verifications set value = $2 where identifier = $1', [
    `signup-resume:${email}`,
    JSON.stringify({ ...parsed, deadlineAt: Date.now() - 1_000 }),
  ])

  // 剛寄過所以倒數中；硬送（拿掉 disabled）：逾時在看票那一步就回，不經冷卻、不寄信。
  const resend = page.getByRole('button', { name: /重寄驗證碼/ })
  await resend.evaluate((el) => el.removeAttribute('disabled'))
  await resend.click()
  await expect(page.getByRole('main').getByRole('alert')).toContainText('續辦已逾時，請重新開始')
  expect((await otpMails(email)).length).toBe(mails)

  // 票在伺服器已作廢：手上那封的碼也完成不了（完成交易看的是列上的截止）。
  await page.getByLabel('驗證碼第 1 位').fill(await latestOtp(email))
  await expect(page.locator('#otp-error')).toContainText('這次續辦已經失效')
  expect((await userRow(email))!.email_verified).toBe(false)

  // 「重新開始」連結回第 1 步、Email 帶著。
  await page.getByRole('link', { name: '重新開始' }).click()
  await expect(page).toHaveURL(/\/register\?email=/)
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue(email)
  await context.close()
})

test('AC-VI-54 畫面段：Google 新帳號到第 3 步，進度條第 1、2 格打勾、「Google 已驗證」', async ({ browser, playwright }) => {
  const { context, page } = await fresh(browser)
  const request = await playwright.request.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { 'x-real-ip': uniqueIp() } })
  const session = await createTestSession(request, null).finally(() => request.dispose())
  // session.ts 鑄的是密碼 session；改成 Google 登入方式的新帳號（Email 由 Google 證明）。
  await pool.query('update users set email_verified = true where id = $1', [session.userId])
  await pool.query(
    `insert into accounts (id, account_id, provider_id, user_id, created_at, updated_at)
     values (gen_random_uuid(), $2, 'google', $1, now(), now())`,
    [session.userId, `g-${run}`],
  )
  await pool.query(`update sessions set login_method = 'google' where user_id = $1`, [session.userId])
  await context.clearCookies()
  await context.addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
  await page.goto('/register/apply?via=google')
  await expect(page).toHaveURL(/\/register\/apply\?via=google$/)
  const steps = progress(page).getByRole('listitem')
  await expect(steps.nth(0)).toHaveAttribute('data-state', 'done')
  await expect(steps.nth(1)).toHaveAttribute('data-state', 'done')
  await expect(steps.nth(1)).toContainText('Google 已驗證')
  await expect(steps.nth(2)).toHaveAttribute('aria-current', 'step')
  await page.screenshot({ path: 'e2e/.artifacts/vb3-step3-google.png', fullPage: true })
  await context.close()
})
