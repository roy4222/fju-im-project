import { randomUUID } from 'node:crypto'
import { expect, request as playwrightRequest, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { sharedTestSession, toPlaywrightCookie } from './session'

/**
 * B 階段 A-13（AD-B7；設計方案 §11）：系辦「公告與作業」清單的「逾期」篩選，走真的畫面。
 *
 * AC-A-36：兩份已截止的文件繳交，一份 2 人未繳、一份全繳 →「逾期」只列前者，列上寫「逾期 2 人」。
 * 另外放一份還沒截止、沒人交的（不算逾期）與一則公告（不是收件），證明篩選不是只看「有沒有人沒交」或種類。
 *
 * 清單用網址的 `?cohort=` 指到這支自己建的屆別，不動全域的預設工作屆別。
 * 收件、名單、正式送出都用 owner 連線直接種好（流程本身各有自己的 e2e），畫面全程照真的操作。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()
const CODE = `B7-${stamp}`
const DAY = 86_400_000
const OVERDUE = `${CODE} 期中心得（有人沒交）`
const DONE = `${CODE} 期初問卷（全交）`
const OPEN = `${CODE} 期末心得（還沒截止）`
const NEWS = `${CODE} 公告`

let pool: Pool
let adminId: string
let cohortId: string

function ymd(date: Date): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}

function minute(offsetMs: number): Date {
  return new Date(Math.floor((Date.now() + offsetMs) / 60_000) * 60_000)
}

let seq = 0
async function insertStudent(): Promise<string> {
  seq += 1
  const studentNo = `42${String(Date.now()).slice(-6)}${seq}`
  const user = await pool.query<{ id: string }>(
    `insert into users (id, name, email, email_verified, updated_at, status)
     values (gen_random_uuid(), $1, $2, true, now(), 'active') returning id`,
    [`逾期學生${seq}`, `b7-${stamp.toLowerCase()}-${seq}@example.com`],
  )
  const id = user.rows[0]!.id
  await pool.query(
    `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at) values (gen_random_uuid(), $1, 'student', $2, now())`,
    [id, adminId],
  )
  await pool.query(
    `insert into user_profiles (user_id, display_name, name_normalized, student_no, cohort_id, contact_email)
     values ($1, $2, $2, $3, $4, $5)`,
    [id, `逾期學生${seq}`, studentNo, cohortId, `b7-${seq}@contact.example.com`],
  )
  await pool.query(`insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)`, [cohortId, studentNo, id])
  return id
}

/** 建一份「已發布」的收件或公告（內容版本、欄位版本、名單），回項目 id 與欄位版本 id。 */
async function publishedItem(options: {
  stage: string
  title: string
  placement: 'submission' | 'news'
  dueAt: Date | null
  roster: readonly string[]
}) {
  const fields = [{ key: 'note', type: 'text', label: '說明', required: true }]
  const submission = options.placement === 'submission'
  const item = await pool.query<{ id: string }>(
    `insert into managed_items
       (id, cohort_id, placement, audience_kind, receiver_unit, stage_id, status, opens_at, actual_opened_at, due_at,
        title, summary, body_html, draft_schema, created_by_kind, created_by_user_id, updated_by_user_id)
     values (gen_random_uuid(), $1, $2, 'cohort_students', $3, $4, 'draft', null, $5, $6,
             $7, '一句話摘要', '<p>請在截止前交。</p>', $8::jsonb, 'user', $9, $9)
     returning id`,
    [
      cohortId,
      options.placement,
      submission ? 'individual' : 'none',
      submission ? options.stage : null,
      minute(-10 * DAY),
      options.dueAt,
      options.title,
      JSON.stringify({ fields: submission ? fields : [] }),
      adminId,
    ],
  )
  const itemId = item.rows[0]!.id
  const content = await pool.query<{ id: string }>(
    `insert into item_versions (id, item_id, version_no, title, summary, body_html, created_by_user_id)
     values (gen_random_uuid(), $1, 1, $2, '一句話摘要', '<p>請在截止前交。</p>', $3) returning id`,
    [itemId, options.title, adminId],
  )
  const schemaId = (
    await pool.query<{ id: string }>(
      `insert into form_schema_versions (id, item_id, version_no, schema, created_by_user_id)
       values (gen_random_uuid(), $1, 1, $2::jsonb, $3) returning id`,
      [itemId, JSON.stringify({ fields: submission ? fields : [] }), adminId],
    )
  ).rows[0]!.id
  await pool.query(`update managed_items set status = 'published', current_content_version_id = $2, current_schema_version_id = $3 where id = $1`, [
    itemId,
    content.rows[0]!.id,
    schemaId,
  ])
  for (const receiverId of options.roster) {
    await pool.query(
      `insert into response_rosters
         (id, item_id, cohort_id, receiver_kind, receiver_id, eligible_from_business_at, source, created_by_kind, created_by_user_id)
       values (gen_random_uuid(), $1, $2, 'user', $3, now() - interval '10 days', 'auto', 'user', $4)`,
      [itemId, cohortId, receiverId, adminId],
    )
  }
  return { itemId, schemaId }
}

/** 本人個人一份的正式送出（截止前兩天）。 */
async function submit(itemId: string, schemaId: string, userId: string) {
  const at = new Date(Date.now() - 3 * DAY)
  await pool.query(
    `insert into submission_versions (id, item_id, receiver_kind, receiver_id, version_no, schema_version_id, answers,
                                      submitted_by_user_id, received_real_at, received_business_at, request_id, deadline_version_at_submit)
     values (gen_random_uuid(), $1, 'user', $2, 1, $3, $4::jsonb, $2, $5, $5, $6, 1)`,
    [itemId, userId, schemaId, JSON.stringify({ note: '已交' }), at, randomUUID()],
  )
}

test.beforeAll(async () => {
  test.setTimeout(240_000)
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備與核對資料')
  pool = new Pool({ connectionString: ownerUrl, max: 2 })

  const adminContext = await playwrightRequest.newContext({ baseURL: BASE_URL })
  adminId = (await sharedTestSession(adminContext, 'admin')).userId
  await adminContext.dispose()

  // 逾期要照真實時間算：業務鐘拉回現在（別的測試可能把它撥到未來）。
  await pool.query(
    `insert into business_clock_overrides (id, environment, business_at, real_at, set_by_user_id, reason)
     values (gen_random_uuid(), 'staging', now(), now(), $1, 'e2e A-13：回到真實時間')`,
    [adminId],
  )

  const now = new Date()
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

  const students = [await insertStudent(), await insertStudent()]
  await publishedItem({ stage: stageId, title: OVERDUE, placement: 'submission', dueAt: minute(-DAY), roster: students })
  const done = await publishedItem({ stage: stageId, title: DONE, placement: 'submission', dueAt: minute(-DAY), roster: students })
  for (const s of students) await submit(done.itemId, done.schemaId, s)
  await publishedItem({ stage: stageId, title: OPEN, placement: 'submission', dueAt: minute(20 * DAY), roster: students })
  await publishedItem({ stage: stageId, title: NEWS, placement: 'news', dueAt: null, roster: [] })
})

test.afterAll(async () => {
  await pool?.end()
})

async function asAdmin(page: Page) {
  const session = await sharedTestSession(page.request, 'admin')
  await page.context().clearCookies()
  await page.context().addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
}

test('AC-A-36：「逾期」篩選只列已截止、還有人沒交的那份，列上寫「逾期 2 人」', async ({ page }) => {
  await asAdmin(page)
  await page.goto(`/dashboard/admin/affairs?cohort=${cohortId}`)
  const rows = page.getByTestId('affair-row')
  // 全部：四筆都在，沒有逾期標籤（其他篩選不讀名單）。
  await expect(rows).toHaveCount(4)
  await expect(page.getByTestId('overdue-pill')).toHaveCount(0)

  // 「逾期」排在種類篩選最後，點下去網址帶 placement=overdue、屆別不變。
  const kinds = page.getByRole('navigation', { name: '種類' }).first()
  await expect(kinds.getByRole('link').last()).toHaveText('逾期')
  await kinds.getByRole('link', { name: '逾期' }).click()
  await expect(page).toHaveURL(new RegExp(`placement=overdue`))
  await expect(page).toHaveURL(new RegExp(`cohort=${cohortId}`))
  await expect(kinds.getByRole('link', { name: '逾期' })).toHaveAttribute('aria-current', 'page')

  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText(OVERDUE)
  await expect(rows.first().getByTestId('overdue-pill')).toHaveText('逾期 2 人')
  for (const other of [DONE, OPEN, NEWS]) await expect(page.getByText(other)).toHaveCount(0)
})

test('AC-A-36：全部交齊後「逾期」篩選變空，寫明沒有逾期未繳', async ({ page }) => {
  const overdue = await pool.query<{ id: string; schema: string }>(
    'select id, current_schema_version_id as schema from managed_items where cohort_id = $1 and title = $2',
    [cohortId, OVERDUE],
  )
  const { id, schema } = overdue.rows[0]!
  const roster = await pool.query<{ receiver_id: string }>('select receiver_id from response_rosters where item_id = $1', [id])
  for (const r of roster.rows) await submit(id, schema, r.receiver_id)

  await asAdmin(page)
  await page.goto(`/dashboard/admin/affairs?cohort=${cohortId}&placement=overdue`)
  await expect(page.getByTestId('affair-row')).toHaveCount(0)
  await expect(page.getByText('這一屆目前沒有逾期未繳的文件繳交。')).toBeVisible()
})
