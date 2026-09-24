import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { sharedTestSession, toPlaywrightCookie } from './session'

/**
 * 票 7：學生註冊與審核，用**真的畫面**走完「做完的樣子」五條。
 *
 * 1. 學生填表註冊 → 等待審核頁；只看得到等待審核與「修改資料」；改了重新比對、仍是待審。
 * 2. 系辦待審清單並列比對結果；學生剛改過資料 → 舊畫面核准被擋、要重新核對。
 * 3. 核准必選核實方式；未命中要指定屆別；退回必填理由。
 * 4. 核准後學生登入進學生首頁；退回的看得到理由。
 * 5. 同一 IP 一小時超過 30 次註冊被擋。
 *
 * 每個學生用自己的 `X-Real-IP`（CI 直連 app、沒有 Caddy，所以這個標頭會被採用），
 * 註冊限速的桶彼此獨立，不會跟其他 e2e 檔搶同一個「沒有來源 IP」的額度。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER
const PASSWORD = 'Student-Password-2026'

test.describe.configure({ mode: 'serial' })

const run = Date.now().toString(36)
const cohortCode = `r${run}`.slice(0, 20)
const cohortName = `E2E 註冊測試屆 ${cohortCode}`
/** 這一輪專用的學號前綴（9 碼），避免跟別的測試或重跑撞號。 */
const prefix = String(Date.now()).slice(-5)
const S01 = { name: `王小明${prefix}`, studentNo: `4${prefix}001`, email: `t07-s01-${run}@example.com`, dept: '資管二甲' }
const S13 = { name: `沒在名單${prefix}`, studentNo: `4${prefix}013`, email: `t07-s13-${run}@example.com`, dept: '資管二乙' }

let ipCounter = 0
function uniqueIp(): string {
  ipCounter += 1
  return `10.${(Number(prefix) % 200) + 20}.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`
}

async function studentContext(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ extraHTTPHeaders: { 'x-real-ip': uniqueIp() } })
  return { context, page: await context.newPage() }
}

async function adminPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext()
  const page = await context.newPage()
  const session = await sharedTestSession(page.request, 'admin')
  await context.addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
  return page
}

async function fillRegistration(page: Page, s: { name: string; studentNo: string; email: string; dept: string }) {
  await page.goto('/register')
  await page.getByLabel('姓名').fill(s.name)
  await page.getByLabel('學號').fill(s.studentNo)
  await page.getByLabel('系級').fill(s.dept)
  await page.getByLabel('手機').fill('0912-345-678')
  await page.getByLabel('登入 Email').fill(s.email)
  await page.getByLabel('密碼', { exact: true }).fill(PASSWORD)
  await page.getByLabel('確認密碼').fill(PASSWORD)
  await page.getByRole('button', { name: '送出註冊' }).click()
}

async function signIn(page: Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('密碼', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: '登入', exact: true }).click()
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 10_000 })
}

function pendingRow(page: Page, name: string) {
  return page.getByRole('row').filter({ has: page.getByText(name, { exact: true }) })
}

async function openReview(page: Page, name: string) {
  await page.goto('/dashboard/admin/accounts')
  await page.getByRole('button', { name: `審核 ${name}` }).click()
  const dialog = page.getByRole('dialog', { name: `審核 ${name}` })
  await expect(dialog).toBeVisible()
  return dialog
}

test.beforeAll(async () => {
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能種屆別與名單')
  // 屆別（票 5）與名單匯入（票 6）的畫面各有自己的 e2e；這裡直接種資料，只測註冊與審核。
  const pool = new Pool({ connectionString: ownerUrl, max: 1 })
  try {
    const cohort = await pool.query<{ id: string }>(
      `insert into cohorts (id, code, name, created_by_kind) values (gen_random_uuid(), $1, $2, 'system') returning id`,
      [cohortCode, cohortName],
    )
    const importer = await pool.query<{ id: string }>(
      `insert into users (id, name, email, email_verified, updated_at, status)
       values (gen_random_uuid(), '名單匯入者', $1, false, now(), 'active') returning id`,
      [`t07-importer-${run}@example.com`],
    )
    const version = await pool.query<{ id: string }>(
      `insert into roster_versions (id, cohort_id, imported_by_user_id, imported_real_at, summary)
       values (gen_random_uuid(), $1, $2, now(), $3::jsonb) returning id`,
      [
        cohort.rows[0]!.id,
        importer.rows[0]!.id,
        // 名單版本列表（票 6）會讀 summary 的計數；照真的匯入寫一份。
        JSON.stringify({
          counts: { total: 1, valid: 1, duplicate: 0, missing: 0, conflict: 0, cohortMismatch: 0, invalidEmail: 0 },
          columns: { cohort: false, email: true, departmentClass: true },
          fileName: 'seeded.csv',
          checksum: '',
          issues: [],
          issuesTotal: 0,
        }),
      ],
    )
    // S01 在名單上，名單 Email 與他註冊用的不同。
    await pool.query(
      `insert into roster_entries (id, roster_version_id, student_no, name_raw, name_normalized, department_class, email)
       values (gen_random_uuid(), $1, $2, $3, $3, '資管二甲', 'roster-copy@example.com')`,
      [version.rows[0]!.id, S01.studentNo, S01.name],
    )
  } finally {
    await pool.end()
  }
})

test('1＋2＋3＋4：註冊 → 待審只看得到自己的申請 → 修改重新比對 → 舊畫面核准被擋 → 核實後核准 → 進學生首頁', async ({
  browser,
}) => {
  const { context: studentCtx, page: student } = await studentContext(browser)
  await fillRegistration(student, S01)

  // 送出後直接登入（受限 session）並停在等待審核頁。
  await expect(student).toHaveURL(/\/register\/pending$/)
  await expect(student.getByRole('heading', { name: '等待系辦審核' })).toBeVisible()
  const submitted = student.getByRole('definition').filter({ hasText: S01.studentNo })
  await expect(submitted).toBeVisible()
  // 名單比對結果只給系辦看：申請人頁面上不會出現命中與否。
  const body = await student.locator('body').innerText()
  for (const leak of ['名單符合', '未命中', '資料不符', 'roster-copy@example.com']) expect(body).not.toContain(leak)

  // 待審的人開其他頁一律被帶回來。
  for (const route of ['/dashboard/student', '/account', '/dashboard/admin/accounts']) {
    await student.goto(route)
    await expect(student).toHaveURL(/\/register\/pending$/)
  }

  // 修改資料 → 第 2 版，狀態仍是待審。
  await student.getByLabel('手機').fill('0922-222-222')
  await student.getByRole('button', { name: '儲存修改' }).click()
  await expect(student.getByRole('status')).toContainText('資料已更新為第 2 版，狀態仍是待審核')
  await expect(student.getByRole('list', { name: '修改紀錄' })).toContainText('第 2 版（修改）')

  // 系辦：待審清單並列比對結果。
  const admin = await adminPage(browser)
  await admin.goto('/dashboard/admin/accounts')
  const row = pendingRow(admin, S01.name)
  await expect(row).toContainText('名單符合')
  await expect(row).toContainText('Email 不同')
  await expect(row).toContainText('第 2 版')

  const dialog = await openReview(admin, S01.name)
  const evidence = dialog.getByRole('table', { name: '申請資料與名冊並列' })
  await expect(evidence).toContainText(S01.email)
  await expect(evidence).toContainText('roster-copy@example.com')
  await expect(evidence).toContainText('不同')
  // 命中一屆：屆別由名單決定，不能改。
  await expect(dialog.getByTestId('locked-cohort')).toContainText(cohortName)

  // 核實方式必選。
  await dialog.getByRole('button', { name: '核准' }).click()
  await expect(dialog.getByRole('alert')).toHaveText('請選擇核實方式。')

  // 系辦畫面還開著（第 2 版），學生又改了一次（第 3 版）。
  await student.getByLabel('系級').fill('資管二乙')
  await student.getByRole('button', { name: '儲存修改' }).click()
  await expect(student.getByRole('status')).toContainText('第 3 版')

  await dialog.getByLabel('當面核對學生證或其他身分證件').check()
  await dialog.getByRole('button', { name: '核准' }).click()
  await expect(dialog.getByRole('alert')).toContainText('學生剛修改過申請資料（現在是第 3 版')
  await dialog.getByRole('button', { name: '重新載入清單' }).click()

  // 重新打開、核對新資料後核准。
  const fresh = await openReview(admin, S01.name)
  await expect(fresh).toContainText('申請資料第 3 版')
  await expect(fresh.getByRole('table', { name: '申請資料與名冊並列' })).toContainText('資管二乙')
  await fresh.getByLabel('當面核對學生證或其他身分證件').check()
  await fresh.getByRole('button', { name: '核准' }).click()
  await expect(fresh.getByRole('status')).toContainText('已核准')
  await expect(fresh.getByRole('status')).toContainText(cohortName)
  await fresh.getByRole('button', { name: '關閉' }).click()
  await expect(pendingRow(admin, S01.name)).toHaveCount(0)

  // 學生：重新整理就進學生首頁；登出再用密碼登入也一樣。
  await student.goto('/register/pending')
  await expect(student).toHaveURL(/\/dashboard\/student$/)
  await studentCtx.clearCookies()
  await signIn(student, S01.email)
  await expect(student).toHaveURL(/\/dashboard\/student$/)
  await expect(student.getByRole('heading', { name: '我的專題' })).toBeVisible()
  await studentCtx.close()
})

test('3＋4：退回必填理由、學生看得到理由並修改重送；未命中要指定屆別、其他方式要說明', async ({ browser }) => {
  const { context: studentCtx, page: student } = await studentContext(browser)
  await fillRegistration(student, S13)
  await expect(student).toHaveURL(/\/register\/pending$/)

  const admin = await adminPage(browser)
  await admin.goto('/dashboard/admin/accounts')
  await expect(pendingRow(admin, S13.name)).toContainText('未命中')

  let dialog = await openReview(admin, S13.name)
  await expect(dialog.getByRole('table', { name: '申請資料與名冊並列' })).toContainText('未命中名單')
  // 退回沒寫理由：擋下。
  await dialog.getByRole('button', { name: '退回' }).click()
  await expect(dialog.getByRole('alert')).toContainText('退回一定要寫理由')
  await dialog.getByLabel(/^理由/).fill('學號與學生證不符，請確認後重新送出')
  await dialog.getByRole('button', { name: '退回' }).click()
  await expect(dialog.getByRole('status')).toContainText('已退回')
  await dialog.getByRole('button', { name: '關閉' }).click()

  // 學生重新整理：看得到退回理由，修改後重送。
  await student.reload()
  await expect(student.getByRole('heading', { name: '申請被退回' })).toBeVisible()
  await expect(student.getByTestId('rejection-reason')).toContainText('學號與學生證不符，請確認後重新送出')
  await student.getByLabel('手機').fill('0933-333-333')
  await student.getByRole('button', { name: '送出申請' }).click()
  await expect(student.getByRole('heading', { name: '等待系辦審核' })).toBeVisible()
  await expect(student.getByRole('status')).toContainText('申請已送出')

  // 未命中：要選屆別；選了「其他核實方式」卻沒寫說明 → 伺服器擋。
  dialog = await openReview(admin, S13.name)
  const cohortSelect = dialog.getByLabel('核准進哪一屆')
  await expect(cohortSelect).toBeVisible()
  await cohortSelect.selectOption({ label: `${cohortName}（${cohortCode}）` })
  await dialog.getByLabel('其他核實方式').check()
  await dialog.getByRole('button', { name: '核准' }).click()
  await expect(dialog.getByRole('alert')).toContainText('選「其他核實方式」時要說明')
  await dialog.getByLabel(/^核實說明/).fill('系主任當面確認為轉學生')
  await dialog.getByRole('button', { name: '核准' }).click()
  await expect(dialog.getByRole('status')).toContainText('已核准')
  await expect(dialog.getByRole('status')).toContainText(cohortName)

  await student.reload()
  await expect(student).toHaveURL(/\/dashboard\/student$/)
  await studentCtx.close()
})

test('5：同一個 IP 一小時註冊超過 30 次就被擋（直接打 API 與表單同一個桶）', async ({ browser }) => {
  const ip = uniqueIp()
  const context = await browser.newContext({ extraHTTPHeaders: { 'x-real-ip': ip } })
  const page = await context.newPage()
  for (let i = 0; i < 30; i += 1) {
    // 每次都清掉上一次註冊帶回來的 cookie：帶著 cookie 的請求會被 Better Auth 的來源檢查擋成 403。
    await context.clearCookies()
    const response = await page.request.post('/api/auth/sign-up/email', {
      headers: { 'x-real-ip': ip },
      data: { email: `t07-rate-${run}-${i}@example.com`, password: PASSWORD, name: `限速 ${i}` },
    })
    expect(response.status(), `第 ${i + 1} 次應該放行`).toBe(200)
  }
  await context.clearCookies()

  await fillRegistration(page, { name: '第三十一位', studentNo: `4${prefix}031`, email: `t07-rate-${run}-31@example.com`, dept: '資管二甲' })
  await expect(page.locator('form p[role="alert"]')).toContainText('一小時內的註冊次數已達上限')
  await expect(page).toHaveURL(/\/register$/)
  // 填過的資料還在（密碼除外），不用整份重打。
  await expect(page.getByLabel('學號')).toHaveValue(`4${prefix}031`)
  await context.close()
})
