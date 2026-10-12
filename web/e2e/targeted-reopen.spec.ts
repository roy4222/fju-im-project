import { expect, request as playwrightRequest, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, sharedTestSession, toPlaywrightCookie, type TestSession } from './session'

/**
 * 第三波 W10（AC-35）：系辦讓單一學生補交。
 *
 * 一份已截止的個人收件、兩位都沒交的學生：系辦在其中一位的名單畫面按「讓他補交」填明天 17:00 與理由；
 * 那一位收到通知、看到「系辦已開放你補交到…」、交得出去，版本標「補交」；另一位仍被擋「已截止」。
 *
 * 第三波 W10b：兩位學生同組、主指導已開閱覽；老師名單上補交中的那一位是「未繳」＋「系辦開放補交到…」、
 * 另一位仍逾期，老師的版本表也標「補交」。
 *
 * 收件用 owner 連線直接建成「已發布、已截止」的樣子（發布流程由 affairs.spec 走過）；系辦與學生全程用真的畫面。
 * 業務鐘拉回真實時間，截止與補交期限用相對今天的時間。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()
const CODE = `W10-${stamp}`
const TITLE = `${CODE} 說明會出席登記`
const DAY = 86_400_000

type Student = TestSession & { name: string }

let pool: Pool
let adminId: string
let admin: TestSession
let cohortId: string
let itemId: string
let s1: Student
let s2: Student
let teacher: TestSession

const FIELDS = [
  { key: 'topic', type: 'text', label: '想做的題目', required: true },
  { key: 'kind', type: 'radio', label: '專題類型', required: true, options: ['一般專題', '產學合作'] },
]

function ymd(date: Date): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}

/** 截止只到分鐘。 */
function minute(offsetMs: number): Date {
  return new Date(Math.floor((Date.now() + offsetMs) / 60_000) * 60_000)
}

/** 明天 17:00（臺灣時間），`datetime-local` 的格式。 */
function tomorrowFive(): string {
  return `${ymd(new Date(Date.now() + DAY))}T17:00`
}

async function newStudent(cohort: string, i: number): Promise<Student> {
  const context = await playwrightRequest.newContext({ baseURL: BASE_URL })
  const session = await createTestSession(context, 'student')
  await context.dispose()
  const studentNo = `410${String(Date.now()).slice(-5)}${i}`
  const name = `補交學生${i}`
  await pool.query(
    `insert into user_profiles (user_id, display_name, name_normalized, student_no, cohort_id, contact_email)
     values ($1, $2, $2, $3, $4, $5)
     on conflict (user_id) do update set display_name = excluded.display_name, student_no = excluded.student_no,
       cohort_id = excluded.cohort_id`,
    [session.userId, name, studentNo, cohort, `w10-${i}-${stamp.toLowerCase()}@contact.example.com`],
  )
  await pool.query('insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)', [cohort, studentNo, session.userId])
  return { ...session, name }
}

test.beforeAll(async () => {
  test.setTimeout(240_000)
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備與核對資料')
  pool = new Pool({ connectionString: ownerUrl, max: 2 })

  const now = new Date()
  const adminContext = await playwrightRequest.newContext({ baseURL: BASE_URL })
  admin = await sharedTestSession(adminContext, 'admin')
  await adminContext.dispose()
  adminId = admin.userId
  // 業務鐘拉回真實時間（別的 spec 可能把模擬鐘推到別處）。
  await pool.query(
    `insert into business_clock_overrides (id, environment, business_at, real_at, set_by_user_id, reason)
     values (gen_random_uuid(), 'staging', now(), now(), $1, 'e2e W10：回到真實時間')`,
    [adminId],
  )
  cohortId = (
    await pool.query<{ id: string }>(
      `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
       values (gen_random_uuid(), $1, $1, 'active', $2, 'system') returning id`,
      [CODE, ymd(new Date(now.getTime() + 300 * DAY))],
    )
  ).rows[0]!.id
  const stageId = (
    await pool.query<{ id: string }>(
      `insert into cohort_stages (id, cohort_id, seq, name, start_date, created_by_kind)
       values (gen_random_uuid(), $1, 1, '成組期', $2, 'system') returning id`,
      [cohortId, ymd(new Date(now.getTime() - 30 * DAY))],
    )
  ).rows[0]!.id

  s1 = await newStudent(cohortId, 1)
  s2 = await newStudent(cohortId, 2)

  // 兩位同組，主指導是這位老師（W10b：老師視角）。
  const teacherContext = await playwrightRequest.newContext({ baseURL: BASE_URL })
  teacher = await createTestSession(teacherContext, 'teacher')
  await teacherContext.dispose()
  const groupId = (
    await pool.query<{ id: string }>(
      `insert into groups (id, cohort_id, code, group_type, established_real_at, established_business_at, created_by_kind)
       values (gen_random_uuid(), $1, $2, 'general', now(), now(), 'system') returning id`,
      [cohortId, `${CODE}-G1`],
    )
  ).rows[0]!.id
  for (const s of [s1, s2]) {
    await pool.query(
      `insert into group_memberships (id, group_id, cohort_id, user_id, valid_from, added_by_kind)
       values (gen_random_uuid(), $1, $2, $3, now(), 'system')`,
      [groupId, cohortId, s.userId],
    )
  }
  await pool.query(
    `insert into group_leaders (id, group_id, user_id, valid_from, changed_by_user_id) values (gen_random_uuid(), $1, $2, now(), $2)`,
    [groupId, s1.userId],
  )
  await pool.query(
    `insert into advisor_assignments (id, group_id, teacher_user_id, source, valid_from, assigned_by_user_id, reason)
     values (gen_random_uuid(), $1, $2, 'admin', now(), $3, 'e2e W10b 指派')`,
    [groupId, teacher.userId, adminId],
  )

  // 已發布、昨天截止的個人收件，兩位都在名單上、都沒交。
  itemId = (
    await pool.query<{ id: string }>(
      `insert into managed_items
         (id, cohort_id, placement, audience_kind, receiver_unit, stage_id, status, opens_at, actual_opened_at, due_at,
          title, summary, body_html, draft_schema, created_by_kind, created_by_user_id, updated_by_user_id)
       values (gen_random_uuid(), $1, 'submission', 'cohort_students', 'individual', $2, 'draft', null, $3, $4,
               $5, '一句話摘要', '<p>請在截止前填好。</p>', $6::jsonb, 'user', $7, $7)
       returning id`,
      [cohortId, stageId, minute(-10 * DAY), minute(-DAY), TITLE, JSON.stringify({ fields: FIELDS }), adminId],
    )
  ).rows[0]!.id
  const content = await pool.query<{ id: string }>(
    `insert into item_versions (id, item_id, version_no, title, summary, body_html, created_by_user_id)
     values (gen_random_uuid(), $1, 1, $2, '一句話摘要', '<p>請在截止前填好。</p>', $3) returning id`,
    [itemId, TITLE, adminId],
  )
  const schema = await pool.query<{ id: string }>(
    `insert into form_schema_versions (id, item_id, version_no, schema, created_by_user_id)
     values (gen_random_uuid(), $1, 1, $2::jsonb, $3) returning id`,
    [itemId, JSON.stringify({ fields: FIELDS }), adminId],
  )
  await pool.query(
    `update managed_items set status = 'published', current_content_version_id = $2, current_schema_version_id = $3 where id = $1`,
    [itemId, content.rows[0]!.id, schema.rows[0]!.id],
  )
  // 系辦開了主指導閱覽（欄位第 1 版起），老師才看得到這份個人收件。
  await pool.query(
    `insert into advisor_visibility_settings (id, item_id, enabled, effective_from_version_no, set_by_user_id, set_at)
     values (gen_random_uuid(), $1, true, 1, $2, now())`,
    [itemId, adminId],
  )
  for (const s of [s1, s2]) {
    await pool.query(
      `insert into response_rosters
         (id, item_id, cohort_id, receiver_kind, receiver_id, eligible_from_business_at, source, created_by_kind, created_by_user_id)
       values (gen_random_uuid(), $1, $2, 'user', $3, now(), 'auto', 'user', $4)`,
      [itemId, cohortId, s.userId, adminId],
    )
  }
})

test.afterAll(async () => {
  await pool?.end()
})

async function signIn(page: Page, session: TestSession) {
  await page.context().clearCookies()
  await page.context().addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
}

async function notificationCount(userId: string): Promise<string> {
  return (await pool.query(`select count(*) as n from notifications where recipient_user_id = $1 and source_ref->>'id' = $2`, [userId, itemId]))
    .rows[0]!.n
}

/** 名單列表上某一位的那一列。 */
function rosterRow(page: Page, s: Student) {
  return page.getByTestId('roster-current').getByTestId('roster-row').filter({ hasText: s.name })
}

/** 老師名單上某一位的那一列。 */
function teacherRow(page: Page, s: Student) {
  return page.getByTestId('teacher-entry').filter({ hasText: s.name })
}

/** 收件進度的「逾期未繳」數字。 */
function overdueCount(page: Page) {
  return page.getByTestId('completion').getByText('逾期未繳', { exact: true }).locator('xpath=following-sibling::dd')
}

test('1. 系辦在學生的名單畫面按「讓他補交」，填明天 17:00 與理由', async ({ page }) => {
  await signIn(page, admin)
  // 開補交前：兩位都是逾期未繳。
  await page.goto(`/dashboard/admin/affairs/${itemId}`)
  await expect(rosterRow(page, s1).getByTestId('roster-status')).toHaveText('逾期未繳')
  await expect(overdueCount(page)).toHaveText('2')

  await page.goto(`/dashboard/admin/affairs/${itemId}?person=${s1.userId}`)
  await expect(page.getByTestId('receiver-status')).toContainText('逾期未繳')
  const section = page.getByTestId('reopen-section')
  await expect(section).toContainText('已經截止')

  await section.getByRole('button', { name: '讓他補交' }).click()
  await section.getByLabel('補交期限（臺灣時間，含這一分鐘）').fill(tomorrowFive())
  await section.getByLabel('理由（學生會看到，200 字內）').fill('住院請假，已附診斷證明')
  await section.getByRole('button', { name: '開放補交' }).click()

  await expect(section.getByTestId('reopen-result')).toContainText('已開放補交到')
  await expect(section.getByTestId('reopen-result')).toContainText('其他人仍是已截止')
  await expect(section.getByRole('list', { name: '補交紀錄' })).toContainText('住院請假，已附診斷證明')
  await expect(page.getByTestId('receiver-status')).toContainText('未繳')

  const rows = (await pool.query(`select receiver_id, reason from submission_reopens where item_id = $1`, [itemId])).rows
  expect(rows).toEqual([{ receiver_id: s1.userId, reason: '住院請假，已附診斷證明' }])

  // 名單列表與完成率：補交中、期限未到的那一位不算逾期未繳；另一位照舊。
  await page.goto(`/dashboard/admin/affairs/${itemId}`)
  await expect(rosterRow(page, s1).getByTestId('roster-status')).toHaveText('未繳')
  await expect(rosterRow(page, s1)).toContainText('系辦開放補交到')
  await expect(rosterRow(page, s2).getByTestId('roster-status')).toHaveText('逾期未繳')
  await expect(overdueCount(page)).toHaveText('1')

  // 另一位的畫面還是逾期，沒有補交紀錄。
  await page.goto(`/dashboard/admin/affairs/${itemId}?person=${s2.userId}`)
  await expect(page.getByTestId('receiver-status')).toContainText('逾期未繳')
  await expect(page.getByRole('list', { name: '補交紀錄' })).toHaveCount(0)

  // 老師（主指導）看同一份名單：補交中的那一位不是逾期，另一位照舊（W10b）。
  await signIn(page, teacher)
  await page.goto(`/dashboard/teacher/affairs/${itemId}`)
  await expect(teacherRow(page, s1)).toContainText('未繳')
  await expect(teacherRow(page, s1)).not.toContainText('逾期未繳')
  await expect(teacherRow(page, s1)).toContainText('系辦開放補交到')
  await expect(teacherRow(page, s2)).toContainText('逾期未繳')
  await expect(overdueCount(page)).toHaveText('1')
})

test('2. 只有被開放的學生收到通知、能交，版本標「補交」', async ({ page }) => {
  await expect.poll(() => notificationCount(s1.userId), { timeout: 45_000 }).toBe('1')
  expect(await notificationCount(s2.userId)).toBe('0')

  await signIn(page, s1)
  await page.goto('/dashboard/student/affairs')
  await expect(page.getByTestId(`affair-${itemId}`)).toContainText('系辦開放補交到')

  await page.goto(`/dashboard/student/affairs/${itemId}`)
  await expect(page.getByTestId('affair-banner')).toContainText('系辦已開放你補交到')
  await page.getByLabel('想做的題目').fill('補交的題目')
  await page.getByRole('radio', { name: '一般專題' }).check()
  await page.getByRole('button', { name: '正式送出' }).click()
  const receipt = page.getByTestId('receipt')
  await expect(receipt).toContainText('已送出')
  await expect(receipt).toContainText('v1')
  await receipt.getByRole('button', { name: '關閉' }).click()

  await page.goto(`/dashboard/student/affairs/${itemId}?tab=history`)
  await expect(page.getByRole('table', { name: '繳交歷史' }).getByTestId('late-badge')).toHaveText('補交')

  const versions = (await pool.query(`select receiver_id from submission_versions where item_id = $1`, [itemId])).rows
  expect(versions).toEqual([{ receiver_id: s1.userId }])

  await page.goto('/dashboard/student/inbox')
  await expect(page.getByText(`系辦開放你補交「${TITLE}」`)).toBeVisible()
})

test('3. 另一位沒拿到補交期限的學生仍被擋「已截止」；系辦看到那一版標補交', async ({ page }) => {
  await signIn(page, s2)
  await page.goto(`/dashboard/student/affairs/${itemId}`)
  await expect(page.getByTestId('affair-banner')).toContainText('逾期未繳')
  await expect(page.getByText('已截止・唯讀；需要補交請聯絡系辦重新開放。')).toBeVisible()
  await expect(page.getByRole('button', { name: '儲存草稿' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '正式送出' })).toHaveCount(0)

  await signIn(page, admin)
  await page.goto(`/dashboard/admin/affairs/${itemId}?person=${s1.userId}`)
  await expect(page.getByRole('table', { name: '正式送出的版本' }).getByTestId('late-badge')).toHaveText('補交')

  // 老師的版本表與版本內容也標「補交」（W10b）。
  await signIn(page, teacher)
  await page.goto(`/dashboard/teacher/affairs/${itemId}?person=${s1.userId}`)
  await expect(page.getByTestId('receiver-status')).toContainText('已繳')
  await expect(page.getByRole('table', { name: '正式送出的版本' }).getByTestId('late-badge')).toHaveText('補交')
  await page.goto(`/dashboard/teacher/affairs/${itemId}?person=${s1.userId}&version=1`)
  await expect(page.getByTestId('version-view').getByTestId('late-badge')).toHaveText('補交')
})
