import { expect, request as playwrightRequest, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, sharedTestSession, toPlaywrightCookie, type TestSession } from './session'

/**
 * 票 23（#234）：評分方案、指派與老師評分。「做完的樣子」逐條走：
 *
 * 1. 管理員建評分方案版本（階段、項目、滿分、權重）；權重不合 100 不能建立、不能發布。
 * 2. 管理員設每組每階段要幾份評分並指派老師，老師收到通知；票 19 重派對話框列出原老師在本組的評分指派。
 * 3. 老師工作台只看到自己的指派；填 0–100 暫存（只有本人與管理員看得到）；正式送出後鎖定。
 *    方案在第一位老師開始填（第一份暫存）時鎖定結構（產品 06 §4「7.5」）。
 * 4. 學生的「成績」頁只有一句說明；學生零可見的全面掃描在 student-zero-visibility.spec.ts。
 *
 * 併發只一筆採計、同請求編號重送、學生呼叫任何評分用例 FORBIDDEN、資料庫 trigger 由整合測試證明
 * （pg-grading.integration.test.ts、s10-grading.integration.test.ts）。
 *
 * 組別與主指導直接用 owner 連線建好（成組、指派指導是票 13、19 的事）；票 23 的動作全程用真的畫面與按鈕。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()
const CODE = `T23-${stamp}`

let pool: Pool
let cohortId: string
let adminId: string
let t1: TestSession
let t2: TestSession
let t3: TestSession
let student: TestSession
const NAME_1 = `評一老師${stamp.slice(-3)}`
const NAME_2 = `評二老師${stamp.slice(-3)}`
const NAME_3 = `評三老師${stamp.slice(-3)}`
const groupIds = new Map<string, string>()

function ymd(date: Date): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}

let seq = 0
async function insertStudent(userId: string | null): Promise<string> {
  seq += 1
  const studentNo = `423${String(Date.now()).slice(-5)}${seq}`
  let id = userId
  if (!id) {
    const user = await pool.query<{ id: string }>(
      `insert into users (id, name, email, email_verified, updated_at, status)
       values (gen_random_uuid(), $1, $2, true, now(), 'active') returning id`,
      [`組員${seq}`, `t23-${stamp.toLowerCase()}-${seq}@example.com`],
    )
    id = user.rows[0]!.id
    await pool.query(
      `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at) values (gen_random_uuid(), $1, 'student', $2, now())`,
      [id, adminId],
    )
  }
  await pool.query(
    `insert into user_profiles (user_id, display_name, name_normalized, student_no, cohort_id, phone, contact_email)
     values ($1, $2, $2, $3, $4, '0912000000', $5)
     on conflict (user_id) do update set display_name = excluded.display_name, student_no = excluded.student_no, cohort_id = excluded.cohort_id`,
    [id, `組員${seq}`, studentNo, cohortId, `t23-${seq}@contact.example.com`],
  )
  await pool.query(`insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)`, [cohortId, studentNo, id])
  return id
}

async function insertGroup(code: string, firstMember: string | null, advisor: string | null) {
  const members = [await insertStudent(firstMember), await insertStudent(null)]
  const at = new Date(Date.now() - 86_400_000)
  const group = await pool.query<{ id: string }>(
    `insert into groups (id, cohort_id, code, group_type, status, established_real_at, established_business_at, created_by_kind)
     values (gen_random_uuid(), $1, $2, 'general', 'active', $3, $3, 'system') returning id`,
    [cohortId, code, at],
  )
  const id = group.rows[0]!.id
  await pool.query(
    `insert into group_memberships (id, group_id, cohort_id, user_id, valid_from, added_by_kind)
     select gen_random_uuid(), $1, $2, u, $3, 'system' from unnest($4::uuid[]) as u`,
    [id, cohortId, at, members],
  )
  await pool.query(`insert into group_leaders (id, group_id, user_id, valid_from, changed_by_user_id) values (gen_random_uuid(), $1, $2, $3, $2)`, [
    id,
    members[0],
    at,
  ])
  if (advisor) {
    await pool.query(
      `insert into advisor_assignments (id, group_id, teacher_user_id, source, valid_from, assigned_by_user_id, reason)
       values (gen_random_uuid(), $1, $2, 'admin', $3, $4, '抽籤結果')`,
      [id, advisor, at, adminId],
    )
  }
  groupIds.set(code, id)
}

test.beforeAll(async () => {
  test.setTimeout(240_000)
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備與核對資料')
  pool = new Pool({ connectionString: ownerUrl, max: 2 })

  const adminContext = await playwrightRequest.newContext({ baseURL: BASE_URL })
  adminId = (await sharedTestSession(adminContext, 'admin')).userId
  await adminContext.dispose()
  const fresh = async (role: 'teacher' | 'student') => {
    const context = await playwrightRequest.newContext({ baseURL: BASE_URL })
    try {
      return await createTestSession(context, role)
    } finally {
      await context.dispose()
    }
  }
  t1 = await fresh('teacher')
  t2 = await fresh('teacher')
  t3 = await fresh('teacher')
  student = await fresh('student')
  for (const [session, name] of [
    [t1, NAME_1],
    [t2, NAME_2],
    [t3, NAME_3],
  ] as const) {
    await pool.query(`update user_profiles set display_name = $2 where user_id = $1`, [session.userId, name])
  }

  const cohort = await pool.query<{ id: string }>(
    `insert into cohorts (id, code, name, status, year_end_date, is_default_working, created_by_kind)
     values (gen_random_uuid(), $1, $2, 'active', $3, false, 'system') returning id`,
    [CODE, `${CODE} 評分測試`, ymd(new Date(Date.now() + 300 * 86_400_000))],
  )
  cohortId = cohort.rows[0]!.id
  await insertGroup('G01', student.userId, t1.userId)
  await insertGroup('G02', null, null)
})

test.afterAll(async () => {
  await pool?.end()
})

async function signIn(page: Page, session: TestSession) {
  await page.context().clearCookies()
  await page.context().addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
}

async function openAdminGrading(page: Page) {
  await signIn(page, await sharedTestSession(page.request, 'admin'))
  await page.goto(`/dashboard/admin/grading?cohort=${cohortId}`)
  await expect(page.getByRole('heading', { name: '成績管理', exact: true })).toBeVisible()
}

const row = (page: Page, code: string) => page.getByTestId(`grading-row-${code}`)

test('管理員建方案：階段 60／50 被擋、沒有建立任何版本；改成 60／40、項目 50／50 建成 v1 草稿，發布後重新整理仍是已發布', async ({ page }) => {
  await openAdminGrading(page)
  await expect(page.getByTestId('scheme-status')).toHaveText('還沒有發布的方案')

  await page.getByRole('button', { name: '建立新方案版本' }).click()
  const dialog = page.getByRole('dialog', { name: '建立評分方案版本' })
  await dialog.getByLabel('占總成績 %').nth(1).fill('50')
  await expect(dialog.getByTestId('weight-sum').first()).toContainText('階段合計 110%（要 100%）')
  await dialog.getByRole('button', { name: '建立草稿' }).click()
  await expect(dialog.getByRole('alert')).toContainText('各階段占總成績的合計是 110%，要剛好 100% 才能建立')
  const versions = await pool.query(
    `select count(*)::int as n from grading_scheme_versions v join grading_schemes s on s.id = v.scheme_id where s.cohort_id = $1`,
    [cohortId],
  )
  expect(versions.rows[0]!.n).toBe(0)

  await dialog.getByLabel('占總成績 %').nth(1).fill('40')
  await dialog.getByLabel('第 1 階段第 1 項權重').fill('50')
  await expect(dialog.getByTestId('weight-sum').nth(1)).toContainText('項目合計 50%（要 100%）')
  await dialog.getByRole('button', { name: '＋ 新增項目' }).first().click()
  await dialog.getByLabel('第 1 階段第 2 項名稱').fill('文件')
  await dialog.getByLabel('第 1 階段第 2 項權重').fill('50')
  await expect(dialog.getByTestId('weight-sum').nth(1)).toContainText('項目合計 100%')
  await dialog.getByRole('button', { name: '建立草稿' }).click()
  await expect(page.getByRole('status').filter({ hasText: '已建立方案 v1（草稿）' })).toBeVisible()

  const table = page.getByRole('table', { name: '方案版本' })
  await expect(table.getByRole('row').filter({ hasText: 'v1' })).toContainText('草稿')
  await table.getByRole('button', { name: '發布 v1' }).click()
  await expect(page.getByTestId('scheme-status')).toHaveText('v1・已發布')
  await expect(page.getByTestId('scheme-formula')).toContainText('系統驗收 × 60% ＋ 專題發表 × 40%')

  await page.reload()
  await expect(page.getByTestId('scheme-status')).toHaveText('v1・已發布')
})

test('設要求份數並指派：G01「系統驗收」要 2 份、指派評一與評二；G02 指派評三；老師收到評分指派通知', async ({ page }) => {
  await openAdminGrading(page)
  await expect(page.getByRole('navigation', { name: '選擇階段' }).getByRole('link', { name: '系統驗收' })).toHaveAttribute('aria-current', 'page')

  await row(page, 'G01').getByLabel('G01「系統驗收」要求份數').fill('2')
  await row(page, 'G01').getByRole('button', { name: '儲存' }).click()
  await expect(row(page, 'G01')).toContainText('已正式送出 0／2 份')

  for (const name of [NAME_1, NAME_2]) {
    await row(page, 'G01').getByLabel('G01「系統驗收」評分老師').selectOption({ label: name })
    await row(page, 'G01').getByRole('button', { name: '指派' }).click()
    await expect(row(page, 'G01').getByRole('status')).toContainText(`已指派 ${name} 老師評 G01「系統驗收」`)
  }
  await row(page, 'G02').getByLabel('G02「系統驗收」評分老師').selectOption({ label: NAME_3 })
  await row(page, 'G02').getByRole('button', { name: '指派' }).click()
  await expect(row(page, 'G02').getByRole('status')).toContainText(`已指派 ${NAME_3} 老師評 G02「系統驗收」`)

  await page.reload()
  await expect(row(page, 'G01').getByTestId('evaluator')).toHaveCount(2)
  await expect(row(page, 'G01')).toContainText(`${NAME_1}未開始`)
  // 已指派的老師不在下拉裡，不能重複指派（伺服器另外也擋，見整合測試）。
  await expect(row(page, 'G01').getByLabel('G01「系統驗收」評分老師').locator('option', { hasText: NAME_1 })).toHaveCount(0)

  const events = await pool.query<{ recipients: string[] }>(
    `select e.recipients from domain_events e join evaluator_assignments a on a.id = e.source_id
      where e.type = 'grading.assigned' and a.group_id = $1 order by e.occurred_real_at`,
    [groupIds.get('G01')],
  )
  expect(events.rows.map((r) => r.recipients)).toEqual([[t1.userId], [t2.userId]])

  // 老師的通知匣（背景工作投影）。
  await signIn(page, t1)
  await expect(async () => {
    await page.goto('/dashboard/teacher/inbox')
    await expect(page.getByText('你被指派評分：G01「系統驗收」')).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 45_000 })
})

test('重派對話框：列出原老師（評一）在 G01 的評分指派，只列不移轉', async ({ page }) => {
  await signIn(page, await sharedTestSession(page.request, 'admin'))
  await page.goto(`/dashboard/admin/groups?cohort=${cohortId}`)
  const groupRow = page.getByRole('region', { name: '全部組別' }).getByRole('row').filter({ hasText: 'G01' })
  await groupRow.getByRole('button', { name: '重派指導老師：G01' }).click()
  const dialog = page.getByRole('dialog', { name: '重派 G01 的指導老師' })
  const grading = dialog.getByRole('region', { name: '原老師在本組的評分指派' })
  await expect(grading.getByTestId('grading-assignments')).toContainText('系統驗收')
  await expect(grading.getByTestId('grading-assignments')).toContainText('未填')
  await expect(grading.getByRole('checkbox')).toHaveCount(0)
  await expect(grading).toContainText('新老師不會自動取得評分權限')
})

test('老師工作台只看到自己的指派；101 標紅擋住；合法分數暫存後重新整理還在；管理員看到「未正式」、方案鎖定；評三開 G01 被拒', async ({ page }) => {
  await signIn(page, t1)
  await page.goto('/dashboard/teacher/grading')
  const queue = page.getByRole('list', { name: '評分佇列' })
  await expect(queue).toContainText('G01')
  await expect(queue).not.toContainText('G02')

  await queue.getByRole('link', { name: /G01/ }).click()
  const bench = page.getByRole('region', { name: 'G01「系統驗收」評分表' })
  await bench.getByLabel('1. 功能完整度').fill('101')
  await expect(bench).toContainText('第 1 項要填 0–100 的數字')
  await bench.getByRole('button', { name: '暫存' }).click()
  await expect(bench.getByRole('alert')).toContainText('修正後才能暫存')
  await expect(bench.getByRole('button', { name: '正式送出' })).toBeDisabled()

  await bench.getByLabel('1. 功能完整度').fill('80')
  await expect(bench.getByTestId('score-preview')).toContainText('40.00')
  await expect(bench).toContainText('還差 1 項')
  await bench.getByRole('button', { name: '暫存' }).click()
  await expect(bench.getByTestId('save-status')).toContainText('已儲存')
  await expect(bench.getByTestId('save-status')).toContainText('伺服器時間')

  await page.reload()
  await expect(page.getByRole('region', { name: 'G01「系統驗收」評分表' }).getByLabel('1. 功能完整度')).toHaveValue('80')

  // 管理員：這一格是暫存、未正式；第一位老師開始填，方案就鎖定（產品 7.5）。
  await openAdminGrading(page)
  await expect(page.getByTestId('scheme-status')).toHaveText('v1・已鎖定')
  await expect(row(page, 'G01')).toContainText('暫存中（未正式）・1／2 項')
  await expect(row(page, 'G01')).toContainText('40.00（未正式）')
  await expect(row(page, 'G01')).toContainText('已正式送出 0／2 份')

  // 評三沒有被指派 G01：直接開網址只看到「沒有被指派」，沒有任何分數。
  await signIn(page, t3)
  await page.goto(`/dashboard/teacher/grading/${groupIds.get('G01')}`)
  await expect(page.getByRole('heading', { name: '你沒有被指派評這一組' })).toBeVisible()
  await expect(page.locator('body')).not.toContainText('40.00')
})

test('正式送出：收件章回執、欄位鎖定；重新整理仍鎖定；方案 v1 已鎖定，新版本不能直接發布', async ({ page }) => {
  await signIn(page, t1)
  await page.goto(`/dashboard/teacher/grading/${groupIds.get('G01')}`)
  const bench = page.getByRole('region', { name: 'G01「系統驗收」評分表' })
  await bench.getByLabel('2. 文件').fill('88.58')
  await expect(bench.getByTestId('score-preview')).toContainText('84.29')
  await bench.getByRole('button', { name: '正式送出' }).click()
  const confirm = page.getByRole('dialog', { name: '確認正式送出' })
  await expect(confirm).toContainText('84.29')
  await confirm.getByRole('button', { name: '確認送出' }).click()
  const receipt = page.getByRole('dialog', { name: '已收件' })
  await expect(receipt).toContainText('G01・系統驗收')
  await expect(receipt).toContainText('84.29')
  await expect(receipt).toContainText('已鎖定')
  await receipt.getByRole('button', { name: '知道了' }).click()
  await expect(bench.getByLabel('1. 功能完整度')).toBeDisabled()

  await page.reload()
  const locked = page.getByRole('region', { name: 'G01「系統驗收」評分表' })
  await expect(locked.getByTestId('save-status')).toContainText('已正式送出')
  await expect(locked.getByLabel('2. 文件')).toBeDisabled()
  await expect(locked.getByRole('button', { name: '正式送出' })).toHaveCount(0)
  const counted = await pool.query(
    `select count(*)::int as n from evaluation_status s join evaluator_assignments a on a.id = s.assignment_id
      where a.group_id = $1 and a.teacher_user_id = $2 and s.state = 'counted'`,
    [groupIds.get('G01'), t1.userId],
  )
  expect(counted.rows[0]!.n).toBe(1)

  await openAdminGrading(page)
  await expect(page.getByTestId('scheme-status')).toHaveText('v1・已鎖定')
  await expect(row(page, 'G01')).toContainText('已正式送出 1／2 份')
  await expect(row(page, 'G01')).toContainText(`${NAME_1}已正式送出84.29`)

  // 鎖定後建新版本可以（草稿），但不能直接發布換掉。
  await page.getByRole('button', { name: '建立新方案版本' }).click()
  const dialog = page.getByRole('dialog', { name: '建立評分方案版本' })
  await expect(dialog).toContainText('從 v1 複製起草')
  await dialog.getByRole('button', { name: '建立草稿' }).click()
  await expect(page.getByRole('status').filter({ hasText: '已建立方案 v2（草稿）' })).toBeVisible()
  const v2 = page.getByRole('table', { name: '方案版本' }).getByRole('row').filter({ hasText: 'v2' })
  // 票 24：鎖定後的新版本不能直接發布，只能「看影響並套用」（先看重算預覽再確認）。
  await expect(v2.getByRole('button', { name: '發布 v2' })).toHaveCount(0)
  await expect(v2.getByRole('link', { name: '看影響並套用 v2' })).toBeVisible()
})

test('學生：「成績」頁只有一句說明；直接開評分管理、工作台網址都被擋', async ({ page }) => {
  await signIn(page, student)
  await page.goto('/dashboard/student/grading')
  await expect(page.getByRole('heading', { name: '評分由老師與系辦處理，學生不會看到分數' })).toBeVisible()
  await expect(page.locator('body')).not.toContainText('84.29')

  for (const path of ['/dashboard/admin/grading', '/dashboard/teacher/grading', `/dashboard/teacher/grading/${groupIds.get('G01')}`]) {
    const response = await page.request.get(path, { maxRedirects: 0 })
    expect([302, 303, 307, 308], path).toContain(response.status())
    expect(response.headers()['location'], path).toContain('/403')
    expect(await response.text(), path).not.toContain('84.29')
  }
})
