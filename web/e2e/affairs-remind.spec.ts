import { expect, request as playwrightRequest, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, sharedTestSession, toPlaywrightCookie, type TestSession } from './session'

/**
 * C 階段規格① C1-07：繳交狀況頁的「設免繳」「讓他補交」理由選填（AC-11）與頂部「催繳未繳（N 人）」（AC-12）。
 *
 * - AC-11：一份已截止的整組作業、兩組都沒交。系辦在名單列對 G1 按「設免繳」、理由留空送出；對 G2 按「讓他補交」、
 *   理由留空、期限明天 17:00 → 兩個都成功；名單狀態「免繳」「補交到 m/d」；稽核兩筆、reason 是空的。
 * - AC-12：一份已截止、3 人沒交的個人作業（`MAIL_CAPTURE=1`）。按「催繳未繳（3 人）」→ toast「已通知 3 人」、3 位學生各一則
 *   站內通知「{標題} 尚未繳交，截止 {時間}」、`mail_outbox` 3 封 `reminder`、稽核 `item.remind` 一筆；
 *   再看一次：按鈕停用，旁邊寫「上次催繳剛剛，{明天同一時間} 後可再催」。
 *
 * 作業用 owner 連線直接建成「已發布、已截止」的樣子（發布流程由 affairs.spec 走過）；系辦全程用真的畫面。
 * 業務鐘拉回真實時間，截止與補交期限用相對今天的時間。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()
const CODE = `C107-${stamp}`
const GROUP_TITLE = `${CODE} 期中簡報`
const PERSONAL_TITLE = `${CODE} 實習心得`
const DAY = 86_400_000
const FIELDS = [{ key: 'topic', type: 'text', label: '心得', required: true }]

type Student = TestSession & { name: string }

let pool: Pool
let admin: TestSession
let cohortId: string
let stageId: string
let groupItemId: string
let personalItemId: string
const students: Student[] = []
const groupIds: string[] = []

function ymd(date: Date): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}

/** 截止只到分鐘。 */
function minute(offsetMs: number): Date {
  return new Date(Math.floor((Date.now() + offsetMs) / 60_000) * 60_000)
}

/** 臺灣時間「2026/10/20 17:00」（同 `formatTaipeiMinute`）。 */
function taipeiMinute(instant: Date): string {
  return new Date(instant.getTime() + 8 * 3600_000).toISOString().slice(0, 16).replace(/-/g, '/').replace('T', ' ')
}

/** 明天 17:00（臺灣時間），`datetime-local` 的格式。 */
function tomorrowFive(): string {
  return `${ymd(new Date(Date.now() + DAY))}T17:00`
}

async function newStudent(i: number): Promise<Student> {
  const context = await playwrightRequest.newContext({ baseURL: BASE_URL })
  const session = await createTestSession(context, 'student')
  await context.dispose()
  const studentNo = `411${String(Date.now()).slice(-5)}${i}`
  const name = `催繳學生${i}`
  await pool.query(
    `insert into user_profiles (user_id, display_name, name_normalized, student_no, cohort_id, contact_email)
     values ($1, $2, $2, $3, $4, $5)
     on conflict (user_id) do update set display_name = excluded.display_name, student_no = excluded.student_no,
       cohort_id = excluded.cohort_id`,
    [session.userId, name, studentNo, cohortId, `c107-${i}-${stamp.toLowerCase()}@contact.example.com`],
  )
  await pool.query('insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)', [cohortId, studentNo, session.userId])
  return { ...session, name }
}

/** 已發布、昨天截止的作業；名單照給的收件者建好、都還沒交。 */
async function publishedOverdue(title: string, unit: 'individual' | 'group', receivers: readonly string[]): Promise<string> {
  const id = (
    await pool.query<{ id: string }>(
      `insert into managed_items
         (id, cohort_id, placement, audience_kind, receiver_unit, stage_id, status, opens_at, actual_opened_at, due_at,
          title, summary, body_html, draft_schema, created_by_kind, created_by_user_id, updated_by_user_id)
       values (gen_random_uuid(), $1, 'submission', 'cohort_students', $2, $3, 'draft', null, $4, $5,
               $6, '一句話摘要', '<p>請在截止前交。</p>', $7::jsonb, 'user', $8, $8)
       returning id`,
      [cohortId, unit, stageId, minute(-10 * DAY), minute(-DAY), title, JSON.stringify({ fields: FIELDS }), admin.userId],
    )
  ).rows[0]!.id
  const content = await pool.query<{ id: string }>(
    `insert into item_versions (id, item_id, version_no, title, summary, body_html, created_by_user_id)
     values (gen_random_uuid(), $1, 1, $2, '一句話摘要', '<p>請在截止前交。</p>', $3) returning id`,
    [id, title, admin.userId],
  )
  const schema = await pool.query<{ id: string }>(
    `insert into form_schema_versions (id, item_id, version_no, schema, created_by_user_id)
     values (gen_random_uuid(), $1, 1, $2::jsonb, $3) returning id`,
    [id, JSON.stringify({ fields: FIELDS }), admin.userId],
  )
  await pool.query(`update managed_items set status = 'published', current_content_version_id = $2, current_schema_version_id = $3 where id = $1`, [
    id,
    content.rows[0]!.id,
    schema.rows[0]!.id,
  ])
  for (const receiver of receivers) {
    await pool.query(
      `insert into response_rosters
         (id, item_id, cohort_id, receiver_kind, receiver_id, eligible_from_business_at, source, created_by_kind, created_by_user_id)
       values (gen_random_uuid(), $1, $2, $3, $4, now(), 'auto', 'user', $5)`,
      [id, cohortId, unit === 'group' ? 'group' : 'user', receiver, admin.userId],
    )
  }
  return id
}

test.beforeAll(async () => {
  test.setTimeout(240_000)
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備與核對資料')
  pool = new Pool({ connectionString: ownerUrl, max: 2 })

  const now = new Date()
  const adminContext = await playwrightRequest.newContext({ baseURL: BASE_URL })
  admin = await sharedTestSession(adminContext, 'admin')
  await adminContext.dispose()
  // 業務鐘拉回真實時間（別的 spec 可能把模擬鐘推到別處）。
  await pool.query(
    `insert into business_clock_overrides (id, environment, business_at, real_at, set_by_user_id, reason)
     values (gen_random_uuid(), 'staging', now(), now(), $1, 'e2e C1-07：回到真實時間')`,
    [admin.userId],
  )
  cohortId = (
    await pool.query<{ id: string }>(
      `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
       values (gen_random_uuid(), $1, $1, 'active', $2, 'system') returning id`,
      [CODE, ymd(new Date(now.getTime() + 300 * DAY))],
    )
  ).rows[0]!.id
  stageId = (
    await pool.query<{ id: string }>(
      `insert into cohort_stages (id, cohort_id, seq, name, start_date, created_by_kind)
       values (gen_random_uuid(), $1, 1, '成組期', $2, 'system') returning id`,
      [cohortId, ymd(new Date(now.getTime() - 30 * DAY))],
    )
  ).rows[0]!.id

  for (let i = 1; i <= 6; i += 1) students.push(await newStudent(i))

  // 兩組：G1（學生 1、2）、G2（學生 3）。
  for (const [code, members] of [
    ['G1', [students[0]!, students[1]!]],
    ['G2', [students[2]!]],
  ] as const) {
    const group = await pool.query<{ id: string }>(
      `insert into groups (id, cohort_id, code, group_type, established_real_at, established_business_at, created_by_kind)
       values (gen_random_uuid(), $1, $2, 'general', now(), now(), 'system') returning id`,
      [cohortId, `${CODE}-${code}`],
    )
    groupIds.push(group.rows[0]!.id)
    for (const m of members) {
      await pool.query(
        `insert into group_memberships (id, group_id, cohort_id, user_id, valid_from, added_by_kind)
         values (gen_random_uuid(), $1, $2, $3, now(), 'system')`,
        [group.rows[0]!.id, cohortId, m.userId],
      )
    }
  }

  groupItemId = await publishedOverdue(GROUP_TITLE, 'group', groupIds)
  personalItemId = await publishedOverdue(
    PERSONAL_TITLE,
    'individual',
    students.slice(3).map((s) => s.userId),
  )
})

test.afterAll(async () => {
  await pool?.end()
})

async function asAdmin(page: Page) {
  await page.context().clearCookies()
  await page.context().addCookies([toPlaywrightCookie(admin.cookie, BASE_URL)])
}

async function auditPayload(action: string, itemId: string): Promise<Record<string, unknown>[]> {
  return (
    await pool.query<{ payload: Record<string, unknown> }>(`select payload from audit_events where action = $1 and target_id = $2 order by real_at`, [
      action,
      itemId,
    ])
  ).rows.map((r) => r.payload)
}

test('AC-11：整組作業某組「設免繳」、另一組「讓他補交」，理由都留空也成功；名單寫「免繳」「補交到 m/d」；稽核兩筆、理由空', async ({ page }) => {
  await asAdmin(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`/dashboard/admin/affairs/${groupItemId}`)
  const current = page.getByTestId('roster-current')
  const g1 = current.getByTestId('roster-row').filter({ hasText: `${CODE}-G1 組` })
  const g2 = current.getByTestId('roster-row').filter({ hasText: `${CODE}-G2 組` })
  await expect(g1.getByTestId('roster-status')).toHaveText('逾期未繳')
  // 整組收件：列是組，旁邊是組員頭像。
  await expect(g1.getByRole('img', { name: `組員：${students[0]!.name}、${students[1]!.name}` })).toBeVisible()

  // G1：設免繳，理由留空。
  await g1.getByRole('button', { name: '設免繳' }).click()
  const exempt = page.getByRole('dialog', { name: `設 ${CODE}-G1 組 免繳` })
  await expect(exempt.getByLabel(/理由（選填/)).toHaveValue('')
  await exempt.getByRole('button', { name: '確定' }).click()
  const tabs = page.getByRole('navigation', { name: '名單分類' })
  await expect(tabs.getByRole('link', { name: /免繳\s*1/ })).toBeVisible()
  await page.keyboard.press('Escape')

  // G2：讓他補交，理由留空、期限明天 17:00。
  await g2.getByRole('button', { name: '讓他補交' }).click()
  const reopen = page.getByRole('dialog', { name: `讓 ${CODE}-G2 組 補交` })
  await reopen.getByLabel('補交期限（臺灣時間，含這一分鐘）').fill(tomorrowFive())
  await expect(reopen.getByLabel(/理由（選填/)).toHaveValue('')
  await reopen.getByRole('button', { name: '開放補交' }).click()
  await expect(reopen).toBeHidden()
  const [, month, day] = tomorrowFive().slice(0, 10).split('-')
  await expect(g2.getByTestId('roster-status')).toHaveText(`補交到 ${Number(month)}/${Number(day)}`)

  await tabs.getByRole('link', { name: /免繳/ }).click()
  await expect(page.getByTestId('roster-exempt').getByTestId('roster-row').filter({ hasText: `${CODE}-G1 組` }).getByTestId('roster-status')).toHaveText('免繳')

  // 稽核：兩筆，理由是空的。
  const exempted = await auditPayload('submission.exempt_set', groupItemId)
  expect(exempted).toHaveLength(1)
  expect(exempted[0]!.reason ?? null).toBeNull()
  const reopened = await auditPayload('submission.reopen', groupItemId)
  expect(reopened).toHaveLength(1)
  expect(reopened[0]!.reason ?? null).toBeNull()
})

test('AC-12：「催繳未繳（3 人）」→ 已通知 3 人；站內通知與 reminder 信各 3；稽核一筆；再看一次按鈕停用、寫下次可催的時間', async ({ page }, testInfo) => {
  await asAdmin(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`/dashboard/admin/affairs/${personalItemId}`)
  const button = page.getByTestId('remind-button')
  await expect(button).toHaveText('催繳未繳（3 人）')
  await expect(button).toBeEnabled()
  await button.click()
  await expect(page.getByTestId('remind-toast')).toHaveText('已通知 3 人')
  await testInfo.attach('催繳後', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })

  // 冷卻中：按鈕停用，寫「上次催繳剛剛，{明天同一時間} 後可再催」。
  const remindedAt = (
    await pool.query<{ at: Date }>(`select occurred_real_at as at from domain_events where type = 'item.reminded' and source_id = $1`, [personalItemId])
  ).rows
  expect(remindedAt).toHaveLength(1)
  const next = taipeiMinute(new Date(remindedAt[0]!.at.getTime() + DAY))
  await page.reload()
  await expect(button).toBeDisabled()
  await expect(page.getByTestId('remind-cooldown')).toHaveText(`上次催繳剛剛，${next} 後可再催`)
  await testInfo.attach('冷卻中', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })

  // 站內通知：3 位學生各一則「{標題} 尚未繳交，截止 {時間}」（背景工作投遞）。
  const due = (await pool.query<{ due_at: Date }>('select due_at from managed_items where id = $1', [personalItemId])).rows[0]!.due_at
  const title = `${PERSONAL_TITLE} 尚未繳交，截止 ${taipeiMinute(due)}`
  for (const s of students.slice(3)) {
    await expect
      .poll(
        async () =>
          Number(
            (
              await pool.query(`select count(*) as n from notifications where recipient_user_id = $1 and source_ref->>'id' = $2 and title = $3`, [
                s.userId,
                personalItemId,
                title,
              ])
            ).rows[0]!.n,
          ),
        { timeout: 30_000 },
      )
      .toBe(1)
  }
  // 沒在名單上的學生沒有。
  expect(
    Number((await pool.query(`select count(*) as n from notifications where recipient_user_id = $1 and source_ref->>'id' = $2`, [students[0]!.userId, personalItemId])).rows[0]!.n),
  ).toBe(0)

  // 催繳信：3 封 reminder（MAIL_CAPTURE=1 存進 outbox）。
  const mails = await pool.query<{ n: string }>(`select count(*) as n from mail_outbox where template = 'reminder' and body_text like $1`, [
    `%/dashboard/student/affairs/${personalItemId}%`,
  ])
  expect(Number(mails.rows[0]!.n)).toBe(3)

  // 稽核 item.remind 一筆。
  expect(await auditPayload('item.remind', personalItemId)).toHaveLength(1)
})
