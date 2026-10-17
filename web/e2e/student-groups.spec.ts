import { randomUUID } from 'node:crypto'
import { expect, request as playwrightRequest, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, sharedTestSession, toPlaywrightCookie, type TestSession } from './session'

/**
 * 學生規格 ST-5：組別頁三分頁（AC-ST-16～18）。
 *
 * - AC-ST-16：已成組的 G07（5 人）預設「我的組」：頁首卡、三個分頁連結、組員與組長冠冕、膠囊「已成組」、
 *   指導老師卡列 `user_profiles.contact_email`（不是登入 Email）、里程碑四格；沒有「請聯絡系辦」之類的句子。
 * - AC-ST-17：未分組預設「找隊員」：公開開關、名單、發起提案；名單空只一句；分組期過了只寫「分組期已經結束」。
 * - AC-ST-18：「紀錄」分頁兩段（組別異動、提案紀錄），看不到系辦理由；其他兩個分頁看不到這兩段。
 *
 * 組別、提案、指派、作業與繳交都直接用 owner 連線建好（流程本身由 groups／advisors／group-submit 等 spec 走過畫面）。
 * 產學面板仍在「我的組」最下方（ST-10 才拿掉），裡面的字不算在這裡的「沒有」斷言。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER

test.describe.configure({ mode: 'serial' })

const DAY = 86_400_000
const stamp = Date.now().toString(36).toUpperCase()
const CODE = `ST5-${stamp}`
const ADVISOR_NAME = `陳明德${stamp.slice(-3)}`
const ADVISOR_CONTACT = `t-${stamp.toLowerCase()}@example.edu`
const LEADER_REASON = 'ST5 內部：原組長請辭'
const ADVISOR_REASON = 'ST5 內部：抽籤結果'

type Member = { userId: string; name: string; studentNo: string }

let pool: Pool
let cohortId: string
let groupId: string
let adminId: string
let teacher: TestSession
/** members[1] 是登入看頁面的 S；members[0] 是現任組長 L（系辦從 members[2] 換過來）。 */
const members: Member[] = []
let viewer: TestSession
/** 未分組、會看找隊員分頁的學生 U；others 是同屆另外兩位公開找組員的同學。 */
let loner: TestSession
const others: Member[] = []
let stageId: string
const now = new Date()

function ymd(date: Date): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}

/** 臺灣日期的 `M/D`。 */
function md(date: Date): string {
  const [, m, d] = ymd(date).split('-').map(Number)
  return `${m}/${d}`
}

async function insertStudent(userId: string | null, index: number, openToJoin = false): Promise<Member> {
  const studentNo = `415${String(Date.now()).slice(-5)}${index}`
  const name = `組別生${index}號`
  let id = userId
  if (!id) {
    const user = await pool.query<{ id: string }>(
      `insert into users (id, name, email, email_verified, updated_at, status)
       values (gen_random_uuid(), $1, $2, true, now(), 'active') returning id`,
      [name, `st5-${stamp.toLowerCase()}-${index}@example.com`],
    )
    id = user.rows[0]!.id
    await pool.query(
      `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at)
       values (gen_random_uuid(), $1, 'student', $2, now())`,
      [id, adminId],
    )
  }
  await pool.query(
    `insert into user_profiles (user_id, display_name, name_normalized, student_no, cohort_id, phone, contact_email, open_to_join)
     values ($1, $2, $2, $3, $4, '0912000000', $5, $6)
     on conflict (user_id) do update set display_name = excluded.display_name, student_no = excluded.student_no,
       cohort_id = excluded.cohort_id, open_to_join = excluded.open_to_join`,
    [id, name, studentNo, cohortId, `st5-${index}@contact.example.com`, openToJoin],
  )
  await pool.query(`insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)`, [cohortId, studentNo, id])
  return { userId: id, name, studentNo }
}

/** 一份已發布、整組一份的作業（名單只有 G07），回項目與欄位版本 id。 */
async function groupItem(title: string, dueAt: Date): Promise<{ itemId: string; schemaId: string }> {
  const fields = [{ key: 'note', type: 'text', label: '說明', required: true }]
  const item = await pool.query<{ id: string }>(
    `insert into managed_items
       (id, cohort_id, placement, audience_kind, receiver_unit, stage_id, status, opens_at, actual_opened_at, due_at,
        title, summary, body_html, draft_schema, created_by_kind, created_by_user_id, updated_by_user_id)
     values (gen_random_uuid(), $1, 'submission', 'cohort_students', 'group', $2, 'draft', null, $3, $4,
             $5, '一句話摘要', '<p>請在截止前交。</p>', $6::jsonb, 'user', $7, $7)
     returning id`,
    [cohortId, stageId, new Date(now.getTime() - 10 * DAY), dueAt, title, JSON.stringify({ fields }), adminId],
  )
  const itemId = item.rows[0]!.id
  const content = await pool.query<{ id: string }>(
    `insert into item_versions (id, item_id, version_no, title, summary, body_html, created_by_user_id)
     values (gen_random_uuid(), $1, 1, $2, '一句話摘要', '<p>請在截止前交。</p>', $3) returning id`,
    [itemId, title, adminId],
  )
  const schema = await pool.query<{ id: string }>(
    `insert into form_schema_versions (id, item_id, version_no, schema, created_by_user_id)
     values (gen_random_uuid(), $1, 1, $2::jsonb, $3) returning id`,
    [itemId, JSON.stringify({ fields }), adminId],
  )
  await pool.query(`update managed_items set status = 'published', current_content_version_id = $2, current_schema_version_id = $3 where id = $1`, [
    itemId,
    content.rows[0]!.id,
    schema.rows[0]!.id,
  ])
  await pool.query(
    `insert into response_rosters
       (id, item_id, cohort_id, receiver_kind, receiver_id, eligible_from_business_at, source, created_by_kind, created_by_user_id)
     values (gen_random_uuid(), $1, $2, 'group', $3, now() - interval '10 days', 'auto', 'user', $4)`,
    [itemId, cohortId, groupId, adminId],
  )
  return { itemId, schemaId: schema.rows[0]!.id }
}

async function setClock(at: Date, reason: string) {
  await pool.query(
    `insert into business_clock_overrides (id, environment, business_at, real_at, set_by_user_id, reason)
     values (gen_random_uuid(), 'staging', $1, now(), $2, $3)`,
    [at, adminId, reason],
  )
}

const proposedAt = new Date(now.getTime() - 5 * DAY)
const establishedAt = new Date(now.getTime() - 3 * DAY)
const submittedAt = new Date(now.getTime() - 1 * DAY)
const laterDue = new Date(now.getTime() + 60 * DAY)

test.beforeAll(async () => {
  test.setTimeout(240_000)
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備與核對資料')
  pool = new Pool({ connectionString: ownerUrl, max: 2 })

  // 每個帳號各用一個 request context：同一個 context 帶著上一個帳號的 cookie 再註冊會被 Origin 檢查擋。
  const fresh = async <T>(run: (context: Awaited<ReturnType<typeof playwrightRequest.newContext>>) => Promise<T>): Promise<T> => {
    const context = await playwrightRequest.newContext({ baseURL: BASE_URL })
    try {
      return await run(context)
    } finally {
      await context.dispose()
    }
  }
  adminId = (await fresh((c) => sharedTestSession(c, 'admin'))).userId
  teacher = await fresh((c) => createTestSession(c, 'teacher'))
  viewer = await fresh((c) => createTestSession(c, 'student'))
  loner = await fresh((c) => createTestSession(c, 'student'))
  await setClock(now, 'e2e ST-5：回到真實時間')

  // 老師的登入 Email 是 e2e-teacher-…@example.com；聯絡 Email 另設（Q122 要顯示的是這個）。
  await pool.query(`update user_profiles set display_name = $2, name_normalized = $2, contact_email = $3 where user_id = $1`, [
    teacher.userId,
    ADVISOR_NAME,
    ADVISOR_CONTACT,
  ])

  const cohort = await pool.query<{ id: string }>(
    `insert into cohorts (id, code, name, status, year_end_date, created_by_kind, group_size_min, group_size_max)
     values (gen_random_uuid(), $1, $2, 'active', $3, 'system', 2, 5) returning id`,
    [CODE, `${CODE} 組別頁測試`, ymd(new Date(now.getTime() + 300 * DAY))],
  )
  cohortId = cohort.rows[0]!.id
  // 成組期從 10 天前開始、30 天後結束（第 2 階段開始日）。
  for (const [i, start] of [-10, 30, 90, 150].map((d) => ymd(new Date(now.getTime() + d * DAY))).entries()) {
    const stage = await pool.query<{ id: string }>(
      `insert into cohort_stages (id, cohort_id, seq, name, start_date, created_by_kind)
       values (gen_random_uuid(), $1, $2, $3, $4, 'system') returning id`,
      [cohortId, i + 1, ['成組期', '期中', '期末', '成果'][i], start],
    )
    if (i === 0) stageId = stage.rows[0]!.id
  }

  for (let i = 1; i <= 5; i += 1) members.push(await insertStudent(i === 2 ? viewer.userId : null, i))
  await insertStudent(loner.userId, 6)
  for (let i = 7; i <= 8; i += 1) others.push(await insertStudent(null, i, true))

  // G07：五人；成組時組長是 members[2]，一小時後系辦換成 members[0]（有理由）。
  const group = await pool.query<{ id: string }>(
    `insert into groups (id, cohort_id, code, group_type, status, established_real_at, established_business_at,
                         created_at, created_by_kind, created_by_user_id, updated_at, updated_by_user_id)
     values (gen_random_uuid(), $1, 'G07', 'general', 'active', $3, $3, $3, 'user', $2, $3, $2) returning id`,
    [cohortId, members[2]!.userId, establishedAt],
  )
  groupId = group.rows[0]!.id
  await pool.query(
    `insert into group_memberships (id, group_id, cohort_id, user_id, valid_from, added_by_kind, added_by_user_id, created_at, updated_at)
     select gen_random_uuid(), $1, $2, u, $5, 'user', $3, $5, $5 from unnest($4::uuid[]) as u`,
    [groupId, cohortId, members[2]!.userId, members.map((m) => m.userId), establishedAt],
  )
  const changedAt = new Date(establishedAt.getTime() + 3600_000)
  await pool.query(
    `insert into group_leaders (id, group_id, user_id, valid_from, valid_to, changed_by_user_id, created_at)
     values (gen_random_uuid(), $1, $2, $3, $4, $2, $3)`,
    [groupId, members[2]!.userId, establishedAt, changedAt],
  )
  await pool.query(
    `insert into group_leaders (id, group_id, user_id, valid_from, changed_by_user_id, reason, created_at)
     values (gen_random_uuid(), $1, $2, $3, $4, $5, $3)`,
    [groupId, members[0]!.userId, changedAt, adminId, LEADER_REASON],
  )

  // 成組的那份提案（里程碑「發起提案」、提案紀錄「已成立（G07）」）。
  const proposal = await pool.query<{ id: string }>(
    `insert into group_proposals (id, cohort_id, proposer_user_id, group_type, expires_business_at, state, established_group_id,
                                  created_real_at, created_business_at, closed_real_at, closed_business_at, closed_by_kind, closed_by_user_id)
     values (gen_random_uuid(), $1, $2, 'general', $3, 'established', $4, $5, $5, $6, $6, 'user', $2) returning id`,
    [cohortId, members[2]!.userId, new Date(proposedAt.getTime() + 7 * DAY), groupId, proposedAt, establishedAt],
  )
  await pool.query(
    `insert into proposal_invitations (id, proposal_id, user_id, state, decided_real_at)
     select gen_random_uuid(), $1, u, 'confirmed', $3 from unnest($2::uuid[]) as u`,
    [proposal.rows[0]!.id, members.map((m) => m.userId), establishedAt],
  )

  await pool.query(
    `insert into advisor_assignments (id, group_id, teacher_user_id, source, valid_from, assigned_by_user_id, reason)
     values (gen_random_uuid(), $1, $2, 'admin', $3, $4, $5)`,
    [groupId, teacher.userId, new Date(establishedAt.getTime() + 2 * 3600_000), adminId, ADVISOR_REASON],
  )

  // 兩件整組一份的作業：一件已送出（昨天）、一件 60 天後截止還沒送。
  const sent = await groupItem(`ST5 提案書 ${stamp}`, new Date(now.getTime() + 5 * DAY))
  await groupItem(`ST5 期末報告 ${stamp}`, laterDue)
  await pool.query(
    `insert into submission_versions (id, item_id, receiver_kind, receiver_id, version_no, schema_version_id, answers,
                                      submitted_by_user_id, received_real_at, received_business_at, request_id,
                                      membership_snapshot, deadline_version_at_submit)
     values (gen_random_uuid(), $1, 'group', $2, 1, $3, '{"note":"第一版"}'::jsonb, $4, $5, $5, $6, $7::jsonb, 1)`,
    [sent.itemId, groupId, sent.schemaId, members[0]!.userId, submittedAt, randomUUID(), JSON.stringify(members.map((m) => m.userId))],
  )
})

test.afterAll(async () => {
  if (pool && adminId) await setClock(new Date(), 'e2e ST-5：回到真實時間')
  await pool?.end()
})

async function signIn(page: Page, session: TestSession) {
  await page.context().clearCookies()
  await page.context().addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
}

const GROUPS = '/dashboard/student/groups'

test('AC-ST-16：已成組預設「我的組」：頁首卡、三個分頁、組員與冠冕、已成組、指導老師聯絡 Email、里程碑四格', async ({ page }) => {
  await signIn(page, viewer)
  await page.goto(GROUPS)
  const main = page.getByRole('main')
  await expect(page.getByRole('heading', { name: '組別', level: 1 })).toBeVisible()
  await expect(main).toContainText('G07・一般專題')

  const tabs = page.getByRole('navigation', { name: '組別分頁' })
  await expect(tabs.getByRole('link')).toHaveText(['我的組', '找隊員', '紀錄'])
  await expect(tabs.getByRole('link', { name: '我的組' })).toHaveAttribute('aria-current', 'page')

  const status = page.getByRole('region', { name: '我的組別狀態' })
  await expect(status).toContainText('組員（5 人）')
  await expect(status).toContainText('已成組')
  const seats = page.getByRole('list', { name: '組員' }).getByRole('listitem')
  await expect(seats).toHaveCount(5)
  for (const m of members) await expect(page.getByRole('list', { name: '組員' })).toContainText(m.name)
  await expect(seats.filter({ hasText: '組長' })).toHaveCount(1)
  await expect(seats.filter({ hasText: '組長' })).toContainText(members[0]!.name)
  await expect(seats.filter({ hasText: '組長' }).locator('svg.tabler-icon-crown')).toHaveCount(1)

  const advisor = page.getByTestId('my-advisor')
  await expect(advisor).toContainText(`${ADVISOR_NAME} 老師`)
  const mail = advisor.getByRole('link', { name: ADVISOR_CONTACT })
  await expect(mail).toHaveAttribute('href', `mailto:${ADVISOR_CONTACT}`)
  await expect(advisor).not.toContainText(teacher.email)
  await expect(main.getByRole('button', { name: /寫信/ })).toHaveCount(0)
  await expect(main.getByRole('link', { name: /寫信/ })).toHaveCount(0)

  const steps = page.getByRole('list', { name: '里程碑' }).getByRole('listitem')
  await expect(steps).toHaveCount(4)
  await expect(steps.nth(0)).toContainText(`已完成發起提案${md(proposedAt)}`)
  await expect(steps.nth(1)).toContainText(`已完成成組${md(establishedAt)}`)
  await expect(steps.nth(2)).toContainText(`已完成ST5 提案書 ${stamp}${md(submittedAt)}`)
  await expect(steps.nth(3)).toContainText(`還沒到ST5 期末報告 ${stamp}${Number(ymd(laterDue).split('-')[1])} 月`)

  // 拿掉的填充句（產學面板 ST-10 已拿掉，整頁都不能有）。
  for (const text of ['請聯絡系辦', '由系辦處理', '組別類型與合作案見下方']) await expect(main).not.toContainText(text)

  // ?tab=mine 與沒帶參數是同一頁。
  await page.goto(`${GROUPS}?tab=mine`)
  await expect(page.getByRole('list', { name: '里程碑' }).getByRole('listitem')).toHaveCount(4)
  await expect(page.getByTestId('my-advisor')).toContainText(`${ADVISOR_NAME} 老師`)

  // 已成組的「找隊員」只一行，連回我的組。
  await page.goto(`${GROUPS}?tab=team`)
  await expect(main).toContainText('組別已成立，名單在「我的組」')
  await expect(page.getByRole('button', { name: '公開找組員' })).toHaveCount(0)
  await main.getByRole('link', { name: '看我的組' }).click()
  await expect(page).toHaveURL(new RegExp(`${GROUPS}\\?tab=mine$`))
  await expect(page.getByRole('region', { name: '我的組別狀態' })).toContainText('組員（5 人）')
})

test('AC-ST-18：「紀錄」分頁兩段（組別異動、提案紀錄），沒有系辦理由；另外兩個分頁看不到這兩段', async ({ page }) => {
  await signIn(page, viewer)
  await page.goto(`${GROUPS}?tab=log`)
  await expect(page.getByRole('navigation', { name: '組別分頁' }).getByRole('link', { name: '紀錄' })).toHaveAttribute('aria-current', 'page')
  const history = page.getByRole('list', { name: '組別異動' })
  await expect(history).toContainText(`組長 ${members[2]!.name} → ${members[0]!.name}`)
  await expect(history).toContainText(ADVISOR_NAME)
  const proposals = page.getByRole('region', { name: '提案紀錄' })
  await expect(proposals).toContainText('已成立（G07）')
  // 兩段分開：提案紀錄不在異動清單裡。
  await expect(history).not.toContainText('已成立（G07）')
  await expect(page.getByRole('main')).not.toContainText(LEADER_REASON)
  await expect(page.getByRole('main')).not.toContainText(ADVISOR_REASON)

  for (const tab of ['mine', 'team']) {
    await page.goto(`${GROUPS}?tab=${tab}`)
    await expect(page.getByRole('navigation', { name: '組別分頁' })).toBeVisible()
    await expect(page.getByRole('list', { name: '組別異動' })).toHaveCount(0)
    await expect(page.getByRole('region', { name: '提案紀錄' })).toHaveCount(0)
  }
  await page.goto(GROUPS)
  await expect(page.getByRole('list', { name: '組別異動' })).toHaveCount(0)
  await expect(page.getByRole('region', { name: '提案紀錄' })).toHaveCount(0)
})

test('AC-ST-17：分組期過了，找隊員分頁只寫「分組期已經結束」，沒有表單、沒有「請聯絡系辦」', async ({ page }) => {
  await setClock(new Date(now.getTime() + 40 * DAY), 'e2e ST-5：推過分組期')
  try {
    await signIn(page, loner)
    await page.goto(GROUPS)
    const main = page.getByRole('main')
    await expect(page.getByRole('navigation', { name: '組別分頁' }).getByRole('link', { name: '找隊員' })).toHaveAttribute('aria-current', 'page')
    await expect(page.getByRole('region', { name: '我的組別狀態' })).toContainText('分組期已經結束')
    await expect(page.getByRole('button', { name: '發起提案' })).toHaveCount(0)
    await expect(main).not.toContainText('請聯絡系辦')
  } finally {
    await setClock(now, 'e2e ST-5：回到真實時間')
  }
})

test('AC-ST-17：未分組預設「找隊員」：公開開關、名單 2 人、發起提案；名單空只一句；提案後狀態卡還在找隊員', async ({ page }) => {
  await signIn(page, loner)
  await page.goto(GROUPS)
  const main = page.getByRole('main')
  await expect(page.getByRole('navigation', { name: '組別分頁' }).getByRole('link', { name: '找隊員' })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('button', { name: '公開找組員' })).toBeVisible()
  const list = page.getByRole('region', { name: '找組員名單' })
  await expect(list.getByRole('listitem')).toHaveCount(2)
  for (const o of others) await expect(list).toContainText(o.name)
  const status = page.getByRole('region', { name: '我的組別狀態' })
  await expect(status).toContainText('本屆每組 2–5 人（含你自己）')
  await expect(status.getByRole('radio', { name: '一般專題' })).toBeVisible()
  await expect(status.getByRole('radio', { name: '產學合作' })).toBeVisible()
  await expect(status.getByRole('button', { name: '發起提案' })).toBeVisible()

  // 名單空：只一句，不叫人洽系辦、不連產學合作案。
  await pool.query(`update user_profiles set open_to_join = false where user_id = any($1::uuid[])`, [others.map((o) => o.userId)])
  await page.reload()
  await expect(list).toContainText('目前沒有公開找組員的同學')
  await expect(list.getByRole('link')).toHaveCount(0)
  await expect(main).not.toContainText('洽系辦')
  await expect(main.getByRole('link', { name: '看產學合作案' })).toHaveCount(0)

  // 發起提案：狀態卡顯示提案，網址不變、仍在找隊員。
  await status.getByRole('radio', { name: '一般專題' }).check()
  await page.getByLabel(/^同學 1 的學號/).fill(others[0]!.studentNo)
  await status.getByRole('button', { name: '發起提案' }).click()
  await expect(status).toContainText('已確認')
  await expect(status).toContainText('組隊中（等全員確認）')
  await expect(page.getByRole('navigation', { name: '組別分頁' }).getByRole('link', { name: '找隊員' })).toHaveAttribute('aria-current', 'page')

  // 還沒成組的「我的組」：一句話＋連到找隊員。
  await page.goto(`${GROUPS}?tab=mine`)
  await expect(main).toContainText('還沒有組別')
  await expect(page.getByRole('region', { name: '我的組別狀態' })).toHaveCount(0)
})
