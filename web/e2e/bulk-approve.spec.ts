import { expect, test, type Browser, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { sharedTestSession, toPlaywrightCookie } from './session'

/**
 * 第三波 W6：待審註冊一次核准多位（AC-24）；操作紀錄新增老師那筆用老師的核實文字（AC-25）。
 *
 * 1. 名單上 3 位，其中第 3 位的學號已被別人（先核准的同學號申請）占用：
 *    勾 3 位 →「核准勾選的 3 位」→ 預覽標出第 3 位會略過及原因 → 選怎麼確認是本人 → 確認
 *    → 結果「成功 2、略過 1」（學號已被使用）；2 位可以登入進學生首頁；操作紀錄 2 筆核准。
 * 2. 新增一位老師後，操作紀錄那筆的確認本人方式寫「教職員證、身分證」，不提學生證。
 *
 * 待審清單是全站共用的（別的 e2e 檔平行跑時也會有待審的人），所以逐一勾這一輪的人，不按「全選」。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER
const PASSWORD = 'Student-Password-2026'

test.describe.configure({ mode: 'serial' })

const run = Date.now().toString(36)
const cohortCode = `ba${run}`.slice(0, 20)
const cohortName = `E2E 批次核准屆 ${cohortCode}`
const prefix = String(Date.now()).slice(-5)
const student = (n: number, studentNo = `6${prefix}10${n}`) => ({
  name: `批次生${prefix}${n}`,
  studentNo,
  email: `w6-s${n}-${run}@example.com`,
})
const S1 = student(1)
const S2 = student(2)
const S3 = student(3)
/** 跟 S3 同學號、同姓名，先被個別核准：S3 的學號就「已被使用」。 */
const HOLDER = { ...student(4, S3.studentNo), name: S3.name }

let ipCounter = 0
function uniqueIp(): string {
  ipCounter += 1
  return `10.${(Number(prefix) % 200) + 30}.${Math.floor(ipCounter / 250) + 100}.${(ipCounter % 250) + 1}`
}

async function adminPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext()
  const page = await context.newPage()
  const session = await sharedTestSession(page.request, 'admin')
  await context.addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
  return page
}

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

async function register(browser: Browser, s: { name: string; studentNo: string; email: string }) {
  const context = await browser.newContext({ extraHTTPHeaders: { 'x-real-ip': uniqueIp() } })
  const page = await context.newPage()
  await page.goto('/register')
  await page.getByLabel('Email', { exact: true }).fill(s.email)
  await page.getByLabel('密碼', { exact: true }).fill(PASSWORD)
  await page.getByLabel('確認密碼').fill(PASSWORD)
  await page.getByRole('button', { name: '建立帳號' }).click()
  // VB-3：註冊改三步。第 2 步的驗證碼從擷取模式的 mail_outbox 讀（MAIL_CAPTURE=1）。
  await expect(page).toHaveURL(/\/register\/verify$/)
  await page.getByLabel('驗證碼第 1 位').fill(await latestOtp(s.email))
  await expect(page).toHaveURL(/\/register\/apply$/)
  await page.getByLabel('姓名').fill(s.name)
  await page.getByLabel('學號').fill(s.studentNo)
  await page.getByLabel('系級').fill('資管二甲')
  await page.getByLabel('手機').fill('0912-345-678')
  await page.getByRole('button', { name: '送出申請' }).click()
  await expect(page).toHaveURL(/\/register\/pending$/)
  await context.close()
}

/** 名單版本的 summary：帳號頁的名單版本列表會讀這些計數（照真的匯入寫）。 */
function rosterSummary(valid: number): string {
  return JSON.stringify({
    counts: { total: valid, valid, duplicate: 0, missing: 0, conflict: 0, cohortMismatch: 0, invalidEmail: 0 },
    columns: { cohort: false, email: false, departmentClass: false },
    fileName: 'seeded.csv',
    checksum: '',
    issues: [],
    issuesTotal: 0,
  })
}

test.beforeAll(async () => {
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能種屆別與名單')
  // 屆別與名單匯入的畫面各有自己的 e2e；這裡直接種資料，只測批次核准。
  const pool = new Pool({ connectionString: ownerUrl, max: 1 })
  try {
    const cohort = await pool.query<{ id: string }>(
      `insert into cohorts (id, code, name, created_by_kind) values (gen_random_uuid(), $1, $2, 'system') returning id`,
      [cohortCode, cohortName],
    )
    const importer = await pool.query<{ id: string }>(
      `insert into users (id, name, email, email_verified, updated_at, status)
       values (gen_random_uuid(), '名單匯入者', $1, false, now(), 'active') returning id`,
      [`w6-importer-${run}@example.com`],
    )
    const version = await pool.query<{ id: string }>(
      `insert into roster_versions (id, cohort_id, imported_by_user_id, imported_real_at, summary)
       values (gen_random_uuid(), $1, $2, now(), $3::jsonb) returning id`,
      [cohort.rows[0]!.id, importer.rows[0]!.id, rosterSummary(3)],
    )
    for (const s of [S1, S2, S3]) {
      await pool.query(
        `insert into roster_entries (id, roster_version_id, student_no, name_raw, name_normalized, department_class)
         values (gen_random_uuid(), $1, $2, $3, $3, '資管二甲')`,
        [version.rows[0]!.id, s.studentNo, s.name],
      )
    }
  } finally {
    await pool.end()
  }
})

function pendingRow(page: Page, name: string) {
  // 待審核清單（C2-07 起在「待審核」分頁；不看帳號列表）。
  return page.locator('table:not([aria-label="帳號列表"])').getByRole('row').filter({ has: page.getByText(name, { exact: true }) })
}

test('AC-24：勾 3 位一起核准，學號已被使用的那位自動略過並寫原因', async ({ browser }) => {
  for (const s of [HOLDER, S1, S2, S3]) await register(browser, s)
  const admin = await adminPage(browser)

  // 先個別核准同學號的另一位，讓 S3 的學號變成「已被使用」。單筆核准照舊（第一個同名的列）。
  await admin.goto('/dashboard/admin/accounts/pending')
  await admin.getByRole('button', { name: `審核 ${HOLDER.name}` }).first().click()
  const review = admin.getByRole('dialog', { name: `審核 ${HOLDER.name}` })
  await review.getByLabel('當面核對學生證或其他身分證件').check()
  await review.getByRole('button', { name: '核准' }).click()
  await expect(review.getByRole('status')).toContainText('已核准')
  await review.getByRole('button', { name: '關閉' }).click()
  await expect(pendingRow(admin, S3.name)).toHaveCount(1)

  // 沒勾任何人時沒有批次按鈕。
  await admin.goto('/dashboard/admin/accounts/pending')
  const pending = admin.getByRole('region', { name: '待審核' })
  await expect(pending.getByRole('button', { name: /^核准勾選的/ })).toHaveCount(0)
  for (const s of [S1, S2, S3]) await pending.getByLabel(`勾選待審 ${s.name}`).check()
  await pending.getByRole('button', { name: '核准勾選的 3 位' }).click()

  const dialog = admin.getByRole('dialog', { name: '批次核准' })
  await expect(dialog.getByRole('heading', { name: '批次核准預覽' })).toBeVisible()
  const rows = dialog.getByTestId('bulk-approve-row')
  await expect(rows).toHaveCount(3)
  await expect(rows.filter({ hasText: S1.name })).toContainText(`會核准，進 ${cohortName}`)
  await expect(rows.filter({ hasText: S2.name })).toContainText(S2.studentNo)
  await expect(rows.filter({ hasText: S3.name })).toContainText('略過：學號已被使用')
  await admin.screenshot({ path: 'test-results/w6-bulk-approve-preview.png' })

  // 沒選怎麼確認是本人不送。
  await dialog.getByRole('button', { name: '核准 2 位' }).click()
  await expect(dialog.getByRole('alert')).toHaveText('請選擇怎麼確認是本人。')
  await dialog.getByLabel('當面核對學生證或其他身分證件').check()
  await dialog.getByRole('button', { name: '核准 2 位' }).click()

  const result = dialog.getByRole('status')
  await expect(result).toContainText('成功 2、略過 1')
  await expect(result.getByRole('region', { name: '略過的人' })).toContainText(S3.name)
  await expect(result.getByRole('region', { name: '略過的人' })).toContainText('學號已被使用')
  await admin.screenshot({ path: 'test-results/w6-bulk-approve-done.png' })
  await dialog.getByRole('button', { name: '關閉' }).click()

  // 關掉後清單刷新：核准的兩位離開待審，略過的那位還在。
  await expect(pendingRow(admin, S1.name)).toHaveCount(0)
  await expect(pendingRow(admin, S2.name)).toHaveCount(0)
  await expect(pendingRow(admin, S3.name)).toHaveCount(1)

  // 操作紀錄：這兩位各一筆核准。
  await admin.goto('/dashboard/admin/audit')
  for (const s of [S1, S2]) {
    await expect(admin.getByTestId('audit-entry').filter({ hasText: '核准註冊' }).filter({ hasText: s.name })).toHaveCount(1)
  }
  // S3 跟 HOLDER 同名：那一筆是 HOLDER 的個別核准；被略過的 S3 沒有多一筆。
  await expect(admin.getByTestId('audit-entry').filter({ hasText: '核准註冊' }).filter({ hasText: S3.name })).toHaveCount(1)

  // 核准的人可以登入、進學生首頁。
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto('/login')
  await page.getByLabel('Email').fill(S1.email)
  await page.getByLabel('密碼', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: '登入', exact: true }).click()
  await expect(page).toHaveURL(/\/dashboard\/student$/)
  await context.close()
})

test('預覽後才補齊名單：按「核准 1 位」只核准預覽時那一位，另一位照樣略過並寫原因', async ({ browser }) => {
  const code = `bb${run}`.slice(0, 20)
  const X = student(7)
  const Y = student(8)
  const pool = new Pool({ connectionString: ownerUrl, max: 1 })
  /** 這一屆匯入一版名單（每次都是最新版本）。 */
  const importRoster = async (cohortId: string, people: readonly { studentNo: string; name: string }[]) => {
    const version = await pool.query<{ id: string }>(
      `insert into roster_versions (id, cohort_id, imported_by_user_id, imported_real_at, summary)
       select gen_random_uuid(), $1, id, clock_timestamp(), $3::jsonb from users where email = $2 returning id`,
      // 帳號頁的名單版本列表會讀 summary 的計數；空的 `{}` 會讓整個帳號頁壞掉，照真的匯入寫一份。
      [cohortId, `w6-importer-${run}@example.com`, rosterSummary(people.length)],
    )
    for (const p of people) {
      await pool.query(
        `insert into roster_entries (id, roster_version_id, student_no, name_raw, name_normalized)
         values (gen_random_uuid(), $1, $2, $3, $3)`,
        [version.rows[0]!.id, p.studentNo, p.name],
      )
    }
  }
  try {
    const cohortId = (
      await pool.query<{ id: string }>(
        `insert into cohorts (id, code, name, created_by_kind) values (gen_random_uuid(), $1, $2, 'system') returning id`,
        [code, `E2E 批次核准屆 ${code}`],
      )
    ).rows[0]!.id
    await importRoster(cohortId, [X])
    for (const s of [X, Y]) await register(browser, s)

    const admin = await adminPage(browser)
    await admin.goto('/dashboard/admin/accounts/pending')
    const pending = admin.getByRole('region', { name: '待審核' })
    for (const s of [X, Y]) await pending.getByLabel(`勾選待審 ${s.name}`).check()
    await pending.getByRole('button', { name: '核准勾選的 2 位' }).click()
    const dialog = admin.getByRole('dialog', { name: '批次核准' })
    await expect(dialog.getByTestId('bulk-approve-row').filter({ hasText: Y.name })).toContainText('略過：名單比對不到')

    // 系辦還沒按確認，名單補了 Y：現在兩位都符合，但執行只能照預覽時的範圍。
    await importRoster(cohortId, [X, Y])
    await dialog.getByLabel('當面核對學生證或其他身分證件').check()
    await dialog.getByRole('button', { name: '核准 1 位' }).click()
    const result = dialog.getByRole('status')
    await expect(result).toContainText('成功 1、略過 1')
    await expect(result.getByRole('region', { name: '略過的人' })).toContainText(Y.name)
    await expect(result.getByRole('region', { name: '略過的人' })).toContainText('預覽時不在可核准名單')
    await dialog.getByRole('button', { name: '關閉' }).click()
    await expect(pendingRow(admin, X.name)).toHaveCount(0)
    await expect(pendingRow(admin, Y.name)).toHaveCount(1)
  } finally {
    await pool.end()
  }
})

test('AC-25：新增老師後，操作紀錄那筆寫老師的核實文字，不提學生證', async ({ browser }) => {
  const admin = await adminPage(browser)
  const teacher = { name: `批次老師${prefix}`, email: `w6-t-${run}@example.com` }
  await admin.goto('/dashboard/admin/accounts')
  await admin.getByRole('button', { name: '新增成員', exact: true }).click()
  const dialog = admin.getByRole('dialog', { name: '新增老師' })
  await dialog.getByLabel('登入 Email').fill(teacher.email)
  await dialog.getByLabel('姓名').fill(teacher.name)
  await dialog.getByLabel('當面核對身分證件（教職員證、身分證）').check()
  await dialog.getByRole('button', { name: '建立並產生臨時密碼' }).click()
  await expect(dialog.getByRole('status')).toContainText('只顯示這一次')
  await dialog.getByRole('button', { name: '關閉' }).click()

  await admin.goto('/dashboard/admin/audit')
  const entry = admin.getByTestId('audit-entry').filter({ hasText: '新增老師' }).filter({ hasText: teacher.name })
  await expect(entry).toHaveCount(1)
  await expect(entry).toContainText('怎麼確認是本人：當面核對身分證件（教職員證、身分證）')
  await expect(entry).not.toContainText('學生證')
})

test('N-03：勾了兩位又逐一個別核准，批次按鈕只算仍在待審的人，都核准完就不出現', async ({ browser }) => {
  const code = `bc${run}`.slice(0, 20)
  const A = student(5)
  const B = student(6)
  const pool = new Pool({ connectionString: ownerUrl, max: 1 })
  try {
    const cohortId = (
      await pool.query<{ id: string }>(
        `insert into cohorts (id, code, name, created_by_kind) values (gen_random_uuid(), $1, $2, 'system') returning id`,
        [code, `E2E 批次核准屆 ${code}`],
      )
    ).rows[0]!.id
    const version = await pool.query<{ id: string }>(
      `insert into roster_versions (id, cohort_id, imported_by_user_id, imported_real_at, summary)
       select gen_random_uuid(), $1, id, clock_timestamp(), $3::jsonb from users where email = $2 returning id`,
      [cohortId, `w6-importer-${run}@example.com`, rosterSummary(2)],
    )
    for (const s of [A, B]) {
      await pool.query(
        `insert into roster_entries (id, roster_version_id, student_no, name_raw, name_normalized)
         values (gen_random_uuid(), $1, $2, $3, $3)`,
        [version.rows[0]!.id, s.studentNo, s.name],
      )
    }
  } finally {
    await pool.end()
  }
  for (const s of [A, B]) await register(browser, s)

  const admin = await adminPage(browser)
  await admin.goto('/dashboard/admin/accounts/pending')
  const pending = admin.getByRole('region', { name: '待審核' })
  for (const s of [A, B]) await pending.getByLabel(`勾選待審 ${s.name}`).check()
  await expect(pending.getByRole('button', { name: '核准勾選的 2 位' })).toBeVisible()

  const approveOne = async (name: string) => {
    await pendingRow(admin, name).getByRole('button', { name: `審核 ${name}` }).click()
    const review = admin.getByRole('dialog', { name: `審核 ${name}` })
    await review.getByLabel('當面核對學生證或其他身分證件').check()
    await review.getByRole('button', { name: '核准' }).click()
    await expect(review.getByRole('status')).toContainText('已核准')
    await review.getByRole('button', { name: '關閉' }).click()
    await expect(pendingRow(admin, name)).toHaveCount(0)
  }

  // 核准完一位：按鈕只算還在待審、還勾著的那一位。
  await approveOne(A.name)
  await expect(pending.getByRole('button', { name: '核准勾選的 1 位' })).toBeVisible()

  // 兩位都核准完：勾選裡已沒有待審的人，批次按鈕不出現（跟沒勾任何人一樣）。
  await approveOne(B.name)
  await expect(pending.getByRole('button', { name: /^核准勾選的/ })).toHaveCount(0)
  await admin.screenshot({ path: 'test-results/n03-bulk-approve-after-single.png' })
})
