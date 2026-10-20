import { expect, request as playwrightRequest, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, sharedTestSession, toPlaywrightCookie, type TestSession } from './session'

/**
 * 開站後：系辦解散組別（最小版）。走真的畫面：
 *
 * 1. 分組總覽 → 「全部組別」那一列的「解散」（A-19：從名單列動作開，不在組別詳情裡）：沒填理由不能下一步；
 *    下一步看後果、按「確定解散」才送出（二次確認）。
 * 2. 解散後這組離開「全部組別」、出現在「已解散的組別」（回執、時間、理由、解散時成員）；組員回到「未分組學生」。
 * 3. 資料庫：組別 dissolved、組員資格與組長列結束、一則 group.dissolved 通知給兩位組員。
 * 4. 學生的「我的組別」不再有這組。
 * 5. AC-A-45：三人組 G03（有指導老師、已送出一份分數）解散 → 三位組員與指導老師各一則通知；成績表 G03 標「已解散」、分數照舊。
 * 權限、同交易、凍結、評分與簽核連動、並發由整合測試 pg-group-dissolve.integration.test.ts 證明。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()
const CODE = `DIS-${stamp}`

type Member = { userId: string; name: string; studentNo: string }

let pool: Pool
let cohortId: string
let groupId: string
let adminId: string
const members: Member[] = []
let viewer: TestSession
let g03Id: string
let advisor: TestSession
const g03Members: Member[] = []

function ymd(date: Date): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}

const STAGES = [
  { key: 'mid', name: '期中', weight: 100, letterMap: null, items: [{ key: 'i1', name: '總分', type: 'number', max: 100, weight: 100 }] },
]

async function insertGroup(code: string, people: readonly Member[], at: Date): Promise<string> {
  const group = await pool.query<{ id: string }>(
    `insert into groups (id, cohort_id, code, group_type, status, established_real_at, established_business_at,
                         created_at, created_by_kind, created_by_user_id, updated_at, updated_by_user_id)
     values (gen_random_uuid(), $1, $4, 'general', 'active', $3, $3, $3, 'user', $2, $3, $2) returning id`,
    [cohortId, people[0]!.userId, at, code],
  )
  const id = group.rows[0]!.id
  await pool.query(
    `insert into group_memberships (id, group_id, cohort_id, user_id, valid_from, added_by_kind, added_by_user_id, created_at, updated_at)
     select gen_random_uuid(), $1, $2, u, $5, 'user', $3, $5, $5 from unnest($4::uuid[]) as u`,
    [id, cohortId, people[0]!.userId, people.map((m) => m.userId), at],
  )
  await pool.query(
    `insert into group_leaders (id, group_id, user_id, valid_from, changed_by_user_id, created_at)
     values (gen_random_uuid(), $1, $2, $3, $2, $3)`,
    [id, people[0]!.userId, at],
  )
  return id
}

async function insertStudent(userId: string | null, index: number): Promise<Member> {
  const studentNo = `415${String(Date.now()).slice(-5)}${index}`
  const name = `解散組員${index}號`
  let id = userId
  if (!id) {
    const user = await pool.query<{ id: string }>(
      `insert into users (id, name, email, email_verified, updated_at, status)
       values (gen_random_uuid(), $1, $2, true, now(), 'active') returning id`,
      [name, `dis-${stamp.toLowerCase()}-${index}@example.com`],
    )
    id = user.rows[0]!.id
    await pool.query(
      `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at)
       values (gen_random_uuid(), $1, 'student', $2, now())`,
      [id, adminId],
    )
  }
  await pool.query(
    `insert into user_profiles (user_id, display_name, name_normalized, student_no, cohort_id, phone, contact_email)
     values ($1, $2, $2, $3, $4, '0912000000', $5)
     on conflict (user_id) do update set display_name = excluded.display_name, student_no = excluded.student_no,
       cohort_id = excluded.cohort_id`,
    [id, name, studentNo, cohortId, `dis-${index}@contact.example.com`],
  )
  await pool.query(`insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)`, [cohortId, studentNo, id])
  return { userId: id, name, studentNo }
}

test.beforeAll(async () => {
  test.setTimeout(240_000)
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備與核對資料')
  pool = new Pool({ connectionString: ownerUrl, max: 2 })

  const now = new Date()
  const adminContext = await playwrightRequest.newContext({ baseURL: BASE_URL })
  const admin = await sharedTestSession(adminContext, 'admin')
  await adminContext.dispose()
  adminId = admin.userId
  await pool.query(
    `insert into business_clock_overrides (id, environment, business_at, real_at, set_by_user_id, reason)
     values (gen_random_uuid(), 'staging', now(), now(), $1, 'e2e 解散組別：回到真實時間')`,
    [adminId],
  )
  const cohort = await pool.query<{ id: string }>(
    `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
     values (gen_random_uuid(), $1, $2, 'active', $3, 'system') returning id`,
    [CODE, `${CODE} 解散組別測試`, ymd(new Date(now.getTime() + 300 * 86_400_000))],
  )
  cohortId = cohort.rows[0]!.id
  for (const [i, start] of [-10, 30, 90, 150].map((d) => ymd(new Date(now.getTime() + d * 86_400_000))).entries()) {
    await pool.query(
      `insert into cohort_stages (id, cohort_id, seq, name, start_date, created_by_kind)
       values (gen_random_uuid(), $1, $2, $3, $4, 'system')`,
      [cohortId, i + 1, ['成組期', '期中', '期末', '成果'][i], start],
    )
  }

  const context = await playwrightRequest.newContext({ baseURL: BASE_URL })
  viewer = await createTestSession(context, 'student')
  await context.dispose()
  members.push(await insertStudent(null, 1))
  members.push(await insertStudent(viewer.userId, 2))

  const establishedAt = new Date(now.getTime() - 86_400_000)
  groupId = await insertGroup('G01', members, establishedAt)

  // AC-A-45：G03 三人、指導老師兼期中評分老師，已正式送出 80 分。
  const teacherContext = await playwrightRequest.newContext({ baseURL: BASE_URL })
  advisor = await createTestSession(teacherContext, 'teacher')
  await teacherContext.dispose()
  for (const i of [3, 4, 5]) g03Members.push(await insertStudent(null, i))
  g03Id = await insertGroup('G03', g03Members, establishedAt)
  await pool.query(
    `insert into advisor_assignments (id, group_id, teacher_user_id, source, valid_from, assigned_by_user_id, reason)
     values (gen_random_uuid(), $1, $2, 'admin', $3, $4, '指派')`,
    [g03Id, advisor.userId, establishedAt, adminId],
  )
  const scheme = await pool.query<{ id: string }>(
    `insert into grading_schemes (id, cohort_id, name, created_by_kind) values (gen_random_uuid(), $1, $2, 'system') returning id`,
    [cohortId, `${CODE} 評分方案`],
  )
  const version = await pool.query<{ id: string }>(
    `insert into grading_scheme_versions (id, scheme_id, version_no, stages, status, locked_at, created_by_user_id)
     values (gen_random_uuid(), $1, 1, $2::jsonb, 'locked', now(), $3) returning id`,
    [scheme.rows[0]!.id, JSON.stringify(STAGES), adminId],
  )
  await pool.query('update grading_schemes set current_version_id = $2 where id = $1', [scheme.rows[0]!.id, version.rows[0]!.id])
  await pool.query(`insert into stage_requirements (group_id, stage_key, required_count, created_by_user_id) values ($1, 'mid', 1, $2)`, [g03Id, adminId])
  const assignment = await pool.query<{ id: string }>(
    `insert into evaluator_assignments (id, group_id, stage_key, teacher_user_id, valid_from, assigned_by_user_id)
     values (gen_random_uuid(), $1, 'mid', $2, now() - interval '1 hour', $3) returning id`,
    [g03Id, advisor.userId, adminId],
  )
  const evaluation = await pool.query<{ id: string }>(
    `insert into evaluations (id, assignment_id, kind, scheme_version_id, scores, submitted_real_at, submitted_business_at, request_id)
     values (gen_random_uuid(), $1, 'final', $2, '{"i1":"80"}'::jsonb, now(), now(), gen_random_uuid()) returning id`,
    [assignment.rows[0]!.id, version.rows[0]!.id],
  )
  await pool.query(`insert into evaluation_status (evaluation_id, assignment_id, state) values ($1, $2, 'counted')`, [
    evaluation.rows[0]!.id,
    assignment.rows[0]!.id,
  ])
})

test.afterAll(async () => {
  await pool?.end()
})

async function signIn(page: Page, session: TestSession) {
  await page.context().clearCookies()
  await page.context().addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
}

test('AC-C3-17：理由留空、二次確認刪除；已刪除篩選只有紀錄，成員回到未分組', async ({ page }) => {
  await signIn(page, await sharedTestSession(page.request, 'admin'))
  await page.goto(`/dashboard/admin/groups?cohort=${cohortId}`)
  const card = page.getByRole('article', { name: 'G01', exact: true })
  await card.locator('summary').click()
  await card.getByRole('button', { name: '刪除 G01', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '刪除 G01？' })
  await expect(dialog).toContainText(`${members[0]!.name}、${members[1]!.name}`)
  await expect(dialog.getByLabel('理由（可不填）')).toHaveValue('')
  const next = dialog.getByRole('button', { name: '下一步' })
  await expect(next).toBeEnabled()
  await next.click()
  await expect(dialog.getByRole('heading', { name: '確定刪除 G01？' })).toBeVisible()
  await expect(dialog).toContainText('刪除後不能復原')
  await dialog.getByRole('button', { name: '返回修改' }).click()
  await expect(dialog.getByLabel('理由（可不填）')).toHaveValue('')
  await next.click()
  await dialog.getByRole('button', { name: '確定刪除' }).click()
  await expect(page.getByRole('status').filter({ hasText: '已刪除' })).toHaveText('已刪除 G01：2 人回到未分組')
  await expect(page).toHaveURL(/status=deleted/)
  await expect(card.getByRole('button')).toHaveCount(0)
  await expect(card.getByRole('link')).toHaveText(['紀錄'])
  await card.getByRole('link', { name: '紀錄' }).click()
  await expect(page.getByRole('region', { name: '組員', exact: true })).toContainText(members[0]!.name)
  await expect(page.getByRole('main')).toContainText('已刪除，原組資料只能查看')
  await expect(page.getByRole('button', { name: /^移除：|^設為組長：|^刪除 / })).toHaveCount(0)

  await page.goto(`/dashboard/admin/groups/unassigned?cohort=${cohortId}`)
  const ungrouped = page.getByRole('region', { name: '未分組學生' })
  for (const member of members) await expect(ungrouped).toContainText(member.name)
  await page.goto(`/dashboard/admin/groups?cohort=${cohortId}`)
  await expect(card).toHaveCount(0)
  await page.getByRole('button', { name: '篩選狀態', exact: true }).click()
  await page.getByRole('menuitemradio', { name: '已刪除', exact: true }).click()
  await expect(card).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: '已刪除' })).toHaveCount(0)

  const head = await pool.query(`select status, dissolve_reason as reason from groups where id = $1`, [groupId])
  expect(head.rows[0]).toEqual({ status: 'dissolved', reason: '' })
  const open = await pool.query(`select (select count(*) from group_memberships where group_id = $1 and valid_to is null)::int
    + (select count(*) from group_leaders where group_id = $1 and valid_to is null)::int as n`, [groupId])
  expect(open.rows[0].n).toBe(0)
  const events = await pool.query(`select cardinality(recipients)::int as n from domain_events where type = 'group.dissolved' and source_id = $1`, [groupId])
  expect(events.rows.map((r) => r.n)).toEqual([2])
})

test('學生的「我的組別」不再有解散的組', async ({ page }) => {
  await signIn(page, viewer)
  await page.goto('/dashboard/student/groups')
  await expect(page.getByRole('region', { name: '我的組別狀態' })).toBeVisible()
  await expect(page.getByRole('region', { name: '我的組別狀態' })).not.toContainText('組別 G01')
})

test('AC-C3-17：有正式繳交的組，卡片及詳情都停用刪除並解釋原因', async ({ page }) => {
  const person = await insertStudent(null, 7)
  const id = await insertGroup('G04', [person], new Date())
  const item = await pool.query(`insert into managed_items
    (id, cohort_id, placement, audience_kind, receiver_unit, title, created_by_kind)
    values (gen_random_uuid(), $1, 'submission', 'cohort_students', 'group', '不可刪的正式繳交', 'system') returning id`, [cohortId])
  const schema = await pool.query(`insert into form_schema_versions (id, item_id, version_no, schema, created_by_user_id)
    values (gen_random_uuid(), $1, 1, '{"fields":[]}'::jsonb, $2) returning id`, [item.rows[0].id, adminId])
  await pool.query(`insert into submission_versions
    (id, item_id, receiver_kind, receiver_id, version_no, schema_version_id, answers, submitted_by_user_id,
     received_real_at, received_business_at, request_id, membership_snapshot, deadline_version_at_submit)
    values (gen_random_uuid(), $1, 'group', $2, 1, $3, '{}'::jsonb, $4, now(), now(), gen_random_uuid(), $5::jsonb, 1)`,
  [item.rows[0].id, id, schema.rows[0].id, person.userId, JSON.stringify([person.userId])])
  await signIn(page, await sharedTestSession(page.request, 'admin'))
  await page.goto(`/dashboard/admin/groups?cohort=${cohortId}`)
  const card = page.getByRole('article', { name: 'G04', exact: true })
  await card.locator('summary').click()
  await expect(card.getByRole('button', { name: '刪除 G04' })).toBeDisabled()
  await expect(card).toContainText('這組已有繳交紀錄，不能刪除')
  await card.getByRole('link', { name: '進入小組' }).click()
  await expect(page.getByRole('button', { name: '刪除 G04' })).toBeDisabled()
  await expect(page.getByRole('main')).toContainText('這組已有繳交紀錄，不能刪除')
  expect((await pool.query('select status, revision from groups where id = $1', [id])).rows[0]).toEqual({ status: 'active', revision: 1 })
})

async function gradebookRow(page: Page) {
  await page.goto(`/dashboard/admin/grading?cohort=${cohortId}`)
  await expect(page.getByRole('heading', { name: '成績', exact: true })).toBeVisible()
  return page.getByTestId('gradebook-row-G03')
}

test('AC-A-45：沒有正式繳交但有評分的 G03 仍可刪除；通知與已解散成績保留', async ({ page }) => {
  await signIn(page, await sharedTestSession(page.request, 'admin'))
  const before = await gradebookRow(page)
  await expect(before).toContainText('80.00')
  await expect(before).not.toContainText('已解散')

  await page.goto(`/dashboard/admin/groups?cohort=${cohortId}`)
  const roster = page.getByRole('region', { name: '全部組別' })
  await expect(roster.getByRole('article', { name: 'G03', exact: true })).toHaveCount(1)
  await roster.getByRole('article', { name: 'G03', exact: true }).locator('summary').click()
  await roster.getByRole('button', { name: '刪除 G03', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '刪除 G03？' })
  await dialog.getByLabel('理由（可不填）').fill('三人皆轉系')
  await dialog.getByRole('button', { name: '下一步' }).click()
  await dialog.getByRole('button', { name: '確定刪除' }).click()

  const dissolved = page.getByRole('main')
  await expect(dissolved.getByRole('status')).toContainText('已刪除 G03：3 人回到未分組')
  await expect(dissolved).toContainText('三人皆轉系')
  await expect(roster.getByRole('link', { name: '進入小組' })).toHaveCount(0)

  // 指導老師也是評分老師：去重後一人一則。
  const events = await pool.query<{ recipients: string[] }>(
    `select recipients from domain_events where type = 'group.dissolved' and source_id = $1`,
    [g03Id],
  )
  expect(events.rows).toHaveLength(1)
  expect([...events.rows[0]!.recipients].sort()).toEqual([...g03Members.map((m) => m.userId), advisor.userId].sort())

  const after = await gradebookRow(page)
  await expect(after).toContainText('已解散')
  await expect(after).toContainText('80.00')
})
