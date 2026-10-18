import { expect, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { sharedTestSession, toPlaywrightCookie, type TestRole } from './session'

/**
 * 票 36：系辦「操作紀錄」頁（原型 `/dashboard/admin/audit`；模組 10「依角色篩選，每筆有時間、人、動作、對象、理由；不可修改」）。
 *
 * 1. 管理員做一件會留紀錄的事（新增屆別），操作紀錄最上面看得到：動作「新增屆別」、對象是那一屆、操作者有名字。
 * 2. 依角色分頁：「管理員」分頁看得到、「學生」分頁沒有這一筆；網址帶著分頁，重新整理不會丟。
 * 3. 頁面沒有任何修改入口（只讀）。
 * 4. 核准一個學生後，最上面那列看得到學生姓名與核實方式（系辦審核）；各分頁數字加起來等於「全部」（2026-10-08 系2、系3）。
 * 非管理員被擋在 `pages.spec` 逐條驗 `PROTECTED_ROUTES`（這一頁已登記）。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const stamp = Date.now().toString(36).toUpperCase()
const CODE = `E2E-AU-${stamp}`

/** 擷取模式下最新一封驗證碼信的 6 碼（VB-3 三步註冊的第 2 步）。 */
async function latestOtp(email: string): Promise<string> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 1 })
  try {
    for (let i = 0; i < 50; i += 1) {
      const row = await pool.query<{ body_text: string | null }>(
        `select body_text from mail_outbox where to_email = $1 and template = 'email_otp' order by created_at desc limit 1`,
        [email],
      )
      const otp = /(\d{6})/.exec(row.rows[0]?.body_text ?? '')?.[1]
      if (otp) return otp
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    throw new Error(`mail_outbox 沒有 ${email} 的驗證碼（e2e 要 MAIL_CAPTURE=1）`)
  } finally {
    await pool.end()
  }
}

async function signIn(page: Page, role: TestRole) {
  const session = await sharedTestSession(page.request, role)
  await page.context().addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
}

test('管理員新增屆別後，操作紀錄看得到；角色分頁照網址篩選；頁面只讀', async ({ page }) => {
  await signIn(page, 'admin')
  await page.goto('/dashboard/admin/cohorts')
  // C2-06：「新增屆別」開視窗填。
  await page.getByRole('button', { name: '新增屆別' }).click()
  const create = page.getByRole('dialog', { name: '新增屆別' })
  await create.getByLabel('代碼').fill(CODE)
  await create.getByLabel('名稱').fill(`${CODE} 操作紀錄測試`)
  await create.getByRole('button', { name: '確定新增' }).click()
  await expect(page.getByRole('main').getByRole('status')).toContainText(CODE)

  await page.goto('/dashboard/admin/audit')
  await expect(page.getByRole('heading', { name: '設定', exact: true })).toBeVisible()
  // 屆別顯示「名稱（代碼）」（系1），所以只比對代碼。
  const entry = page.getByTestId('audit-entry').filter({ hasText: CODE })
  await expect(entry).toHaveCount(1)
  await expect(entry).toContainText('新增屆別')

  const tabs = page.getByRole('navigation', { name: '依角色篩選' })
  await tabs.getByRole('link', { name: /^管理員/ }).click()
  await expect(page).toHaveURL(/\/dashboard\/admin\/audit\?role=admin$/)
  await expect(tabs.getByRole('link', { name: /^管理員/ })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('audit-entry').filter({ hasText: CODE })).toHaveCount(1)

  await page.goto('/dashboard/admin/audit?role=student')
  await expect(page.getByTestId('audit-entry').filter({ hasText: CODE })).toHaveCount(0)

  // 只讀：清單區塊裡唯一的按鈕與表單是搜尋（A-11：GET 表單、不改資料），沒有任何修改入口。
  const events = page.getByRole('region', { name: '操作清單' })
  await expect(events.getByRole('button')).toHaveCount(1)
  await expect(events.getByRole('button', { name: '搜尋' })).toHaveCount(1)
  await expect(events.locator('form')).toHaveCount(1)
  await expect(events.locator('form')).toHaveAttribute('method', 'get')
})

test('學生與老師打開操作紀錄被擋，拿不到任何一筆', async ({ page }) => {
  for (const role of ['student', 'teacher'] as const) {
    await page.context().clearCookies()
    await signIn(page, role)
    await page.goto('/dashboard/admin/audit')
    await expect(page.getByTestId('audit-entry')).toHaveCount(0)
    await expect(page.getByRole('heading', { name: '設定', exact: true })).toHaveCount(0)
  }
})

test('核准學生後，操作紀錄最上面那列看得到學生姓名與核實方式；分頁數字加起來等於全部', async ({ browser }) => {
  const ownerUrl = process.env.DATABASE_URL_OWNER
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能種屆別')
  const cohortCode = `au${stamp}`.slice(0, 20)
  const cohortName = `E2E 操作紀錄屆 ${cohortCode}`
  const prefix = String(Date.now()).slice(-5)
  const student = { name: `紀錄生${prefix}`, studentNo: `5${prefix}001`, email: `audit-s-${stamp.toLowerCase()}@example.com` }
  const password = 'Student-Password-2026'

  // 屆別畫面有自己的 e2e；這裡直接種，只測「核准 → 操作紀錄」。
  const pool = new Pool({ connectionString: ownerUrl, max: 1 })
  try {
    await pool.query(`insert into cohorts (id, code, name, created_by_kind) values (gen_random_uuid(), $1, $2, 'system')`, [
      cohortCode,
      cohortName,
    ])
  } finally {
    await pool.end()
  }

  // 學生用自己的來源 IP 註冊（跟 registration.spec 一樣，避免跟別的檔搶同一個註冊限速桶）。
  const studentContext = await browser.newContext({ extraHTTPHeaders: { 'x-real-ip': `10.250.${Number(prefix) % 250}.7` } })
  const reg = await studentContext.newPage()
  await reg.goto('/register')
  await reg.getByLabel('Email', { exact: true }).fill(student.email)
  await reg.getByLabel('密碼', { exact: true }).fill(password)
  await reg.getByLabel('確認密碼').fill(password)
  await reg.getByRole('button', { name: '建立帳號' }).click()
  // VB-3：註冊改三步。第 2 步的驗證碼從擷取模式的 mail_outbox 讀（MAIL_CAPTURE=1）。
  await expect(reg).toHaveURL(/\/register\/verify$/)
  await reg.getByLabel('驗證碼第 1 位').fill(await latestOtp(student.email))
  await expect(reg).toHaveURL(/\/register\/apply$/)
  await reg.getByLabel('姓名').fill(student.name)
  await reg.getByLabel('學號').fill(student.studentNo)
  await reg.getByLabel('系級').fill('資管二甲')
  await reg.getByLabel('手機').fill('0912-345-678')
  await reg.getByRole('button', { name: '送出申請' }).click()
  await expect(reg).toHaveURL(/\/register\/pending$/)
  await studentContext.close()

  const adminContext = await browser.newContext()
  const page = await adminContext.newPage()
  await signIn(page, 'admin')
  await page.goto('/dashboard/admin/accounts/pending')
  // 學生不在名單上：核准開小視窗，只選屆別。
  await page.getByRole('button', { name: `核准 ${student.name}` }).click()
  const dialog = page.getByRole('dialog', { name: `核准 ${student.name}` })
  await dialog.getByLabel('核准進哪一屆').selectOption({ label: `${cohortName}（${cohortCode}）` })
  await dialog.getByRole('button', { name: '核准', exact: true }).click()
  await expect(dialog.getByRole('status')).toContainText('已核准')

  await page.goto('/dashboard/admin/audit')
  // e2e 平行跑，別的檔可能剛好插進新紀錄，所以用學生姓名找那一列，不假設它在第一列。
  const top = page.getByTestId('audit-entry').filter({ hasText: '核准註冊' }).filter({ hasText: student.name })
  await expect(top).toHaveCount(1)
  await expect(top).toContainText('系辦審核')

  // 學生送出申請那筆沒有角色，落在「本人申請」。
  await page.goto('/dashboard/admin/audit?role=other')
  await expect(page.getByTestId('audit-entry').filter({ hasText: '送出註冊申請' }).filter({ hasText: student.name })).toHaveCount(1)

  // 系3：除了「全部」，各分頁數字加起來等於「全部」。
  const tabs = page.getByRole('navigation', { name: '依角色篩選' }).getByRole('link')
  const numbers = (await tabs.allInnerTexts()).map((t) => Number(t.match(/(\d+)\s*$/)?.[1] ?? Number.NaN))
  const [all, ...rest] = numbers
  expect(rest).toHaveLength(5)
  expect(rest.reduce((sum, n) => sum + n, 0)).toBe(all)
  await adminContext.close()
})
