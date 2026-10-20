import { randomUUID } from 'node:crypto'
import { expect, request as playwrightRequest, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, sharedTestSession, toPlaywrightCookie, type TestSession } from './session'

/**
 * 學生規格 ST-5：組別頁兩分頁（AC-ST-16～18；C3-11 起照規格③ §5：「我的組｜找隊員」、紀錄搬到「我的組」最下方）。
 *
 * - AC-ST-16：已成組的 G07（5 人）預設「我的組」：頁首卡、兩個分頁連結、組員與組長冠冕、膠囊「已成組」、
 *   指導老師卡列 `user_profiles.contact_email`（不是登入 Email）、里程碑四格（第一格「建立組別」）；沒有「請聯絡系辦」之類的句子。
 * - AC-ST-17／AC-C3-11：未分組預設「我的組」＝建立組別表單（第一格是自己、即時查學號、＋再加一位、合作案只在產學合作、
 *   右欄「邀請進度」）；送出後同位置換成「建立中（等全員確認）」；找隊員的名單空只一句；分組期過了只寫「分組期已經結束」。
 * - AC-C3-09：找隊員按「邀請加入」→ `?tab=mine&invite=<學號>` 預填（可累加）；送出建立後每張卡的「邀請加入」disabled。
 * - AC-ST-18／AC-C3-13：「我的組」最下方 section「紀錄」兩段（組別異動、建立組別紀錄），看不到系辦理由；`?tab=log` 視同我的組；找隊員看不到。
 * - AC-C3-12／AC-C3-26（學生側）：產學合作必選合作案（下拉只有已發布）；成立瞬間 `opportunity_links` 一列 `pending`、負責老師收通知；
 *   「我的組」顯示「合作案：甲（T1 老師）・待老師確認」；連結被婉拒後顯示「還沒有合作案」＋組長選案。
 *
 * 組別、建立紀錄、指派、作業與繳交都直接用 owner 連線建好（流程本身由 groups／advisors／group-submit 等 spec 走過畫面）。
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
/** 產學合作那一組（AC-C3-12）：發起人 E 與受邀者 A，都要登入操作。 */
let indE: TestSession
let indA: TestSession
let indEMember: Member
let indAMember: Member
/** 老師 T1 的合作案：甲（已發布）、乙（草稿，不該出現在下拉）、丙（已發布，婉拒後重選用）。 */
const opportunities: Record<'甲' | '乙' | '丙', { id: string; company: string }> = { 甲: { id: '', company: '' }, 乙: { id: '', company: '' }, 丙: { id: '', company: '' } }
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
  indE = await fresh((c) => createTestSession(c, 'student'))
  indA = await fresh((c) => createTestSession(c, 'student'))
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
  indEMember = await insertStudent(indE.userId, 9)
  indAMember = await insertStudent(indA.userId, 10)

  // 老師 T1 的合作案：甲、丙已發布，乙是草稿（AC-C3-12 下拉只有已發布）。
  for (const [key, status] of [['甲', 'published'], ['乙', 'draft'], ['丙', 'published']] as const) {
    const company = `ST5${key}公司${stamp.slice(-3)}`
    const row = await pool.query<{ id: string }>(
      `insert into industry_opportunities
         (id, owner_teacher_user_id, company_name, department, content, requirements, notes, address, contact_name,
          contact_phone, contact_email, status, published_business_at, created_by_kind, created_by_user_id)
       values (gen_random_uuid(), $1, $2, '研發部', '內容', '條件', '內部備註', '地址', '聯絡人', '02-0000-0000', 'secret@company.example.com',
               $3, case when $3 = 'published' then now() else null end, 'user', $1)
       returning id`,
      [teacher.userId, company, status],
    )
    opportunities[key] = { id: row.rows[0]!.id, company }
  }

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

test('AC-ST-16：已成組預設「我的組」：頁首卡、兩個分頁、組員與冠冕、已成組、指導老師聯絡 Email、里程碑四格（第一格「建立組別」）', async ({ page }) => {
  await signIn(page, viewer)
  await page.goto(GROUPS)
  const main = page.getByRole('main')
  await expect(page.getByRole('heading', { name: '組別', level: 1 })).toBeVisible()
  await expect(main).toContainText('G07・一般專題')

  const tabs = page.getByRole('navigation', { name: '組別分頁' })
  await expect(tabs.getByRole('link')).toHaveText(['我的組', '找隊員'])
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

  // 組員頭像實際渲染 32×32（AC-ST-29），桌機與手機寬都一樣。
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 })
    const avatars = seats.locator('img')
    await expect(avatars).toHaveCount(5)
    for (let i = 0; i < 5; i++) {
      const box = await avatars.nth(i).boundingBox()
      expect(box?.width).toBeCloseTo(32, 0)
      expect(box?.height).toBeCloseTo(32, 0)
    }
  }

  const advisor = page.getByTestId('my-advisor')
  await expect(advisor).toContainText(`${ADVISOR_NAME} 老師`)
  const mail = advisor.getByRole('link', { name: ADVISOR_CONTACT })
  await expect(mail).toHaveAttribute('href', `mailto:${ADVISOR_CONTACT}`)
  await expect(advisor).not.toContainText(teacher.email)
  await expect(main.getByRole('button', { name: /寫信/ })).toHaveCount(0)
  await expect(main.getByRole('link', { name: /寫信/ })).toHaveCount(0)

  const steps = page.getByRole('list', { name: '里程碑' }).getByRole('listitem')
  await expect(steps).toHaveCount(4)
  await expect(steps.nth(0)).toContainText(`已完成建立組別${md(proposedAt)}`)
  await expect(steps.nth(1)).toContainText(`已完成成組${md(establishedAt)}`)
  await expect(steps.nth(2)).toContainText(`已完成ST5 提案書 ${stamp}${md(submittedAt)}`)
  await expect(steps.nth(3)).toContainText(`還沒到ST5 期末報告 ${stamp}${Number(ymd(laterDue).split('-')[1])} 月`)

  // 拿掉的填充句（產學面板 ST-10 已拿掉，整頁都不能有）；一般組沒有「合作案」那一行（AC-C3-14：也沒有「提案」「組隊中」）。
  for (const text of ['請聯絡系辦', '由系辦處理', '組別類型與合作案見下方']) await expect(main).not.toContainText(text)
  await expect(page.getByTestId('my-opportunity')).toHaveCount(0)
  await expect(main).not.toContainText(/提案|組隊中/)

  // ?tab=mine 與沒帶參數是同一頁。
  await page.goto(`${GROUPS}?tab=mine`)
  await expect(page.getByRole('list', { name: '里程碑' }).getByRole('listitem')).toHaveCount(4)
  await expect(page.getByTestId('my-advisor')).toContainText(`${ADVISOR_NAME} 老師`)

  // 已成組的「找隊員」只一行，連回我的組。
  await page.goto(`${GROUPS}?tab=team`)
  await expect(main).toContainText('組別已成立，名單在「我的組」')
  await expect(page.getByRole('button', { name: '公開找隊員' })).toHaveCount(0)
  await main.getByRole('link', { name: '看我的組' }).click()
  await expect(page).toHaveURL(new RegExp(`${GROUPS}\\?tab=mine$`))
  await expect(page.getByRole('region', { name: '我的組別狀態' })).toContainText('組員（5 人）')
})

test('AC-ST-18／AC-C3-13：「我的組」最下方 section「紀錄」兩段（組別異動、建立組別紀錄），沒有系辦理由；?tab=log 視同我的組；找隊員看不到', async ({ page }) => {
  await signIn(page, viewer)
  await page.goto(`${GROUPS}?tab=mine`)
  const log = page.getByRole('region', { name: '紀錄' })
  const history = log.getByRole('list', { name: '組別異動' })
  await expect(history).toContainText(`組長 ${members[2]!.name} → ${members[0]!.name}`)
  await expect(history).toContainText(ADVISOR_NAME)
  const proposals = log.getByRole('region', { name: '建立組別紀錄' })
  await expect(proposals).toContainText('已成立（G07）')
  // 兩段分開：建立組別紀錄不在異動清單裡。
  await expect(history).not.toContainText('已成立（G07）')
  await expect(page.getByRole('main')).not.toContainText(LEADER_REASON)
  await expect(page.getByRole('main')).not.toContainText(ADVISOR_REASON)
  // 紀錄在狀態卡下面（最下方）。
  const statusBox = await page.getByRole('region', { name: '我的組別狀態' }).boundingBox()
  const logBox = await log.boundingBox()
  expect(logBox!.y).toBeGreaterThan(statusBox!.y + statusBox!.height - 1)

  // 舊的 `?tab=log`：200、內容與 `?tab=mine` 相同、沒有第三個分頁。
  const response = await page.goto(`${GROUPS}?tab=log`)
  expect(response?.status()).toBe(200)
  const tabs = page.getByRole('navigation', { name: '組別分頁' })
  await expect(tabs.getByRole('link')).toHaveText(['我的組', '找隊員'])
  await expect(tabs.getByRole('link', { name: '我的組' })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('region', { name: '紀錄' }).getByRole('list', { name: '組別異動' })).toContainText(`組長 ${members[2]!.name} → ${members[0]!.name}`)
  await expect(page.getByRole('region', { name: '建立組別紀錄' })).toContainText('已成立（G07）')
  await expect(page.getByRole('region', { name: '我的組別狀態' })).toContainText('組員（5 人）')

  await page.goto(`${GROUPS}?tab=team`)
  await expect(page.getByRole('navigation', { name: '組別分頁' })).toBeVisible()
  await expect(page.getByRole('main')).toContainText('組別已成立，名單在「我的組」')
  await expect(page.getByRole('list', { name: '組別異動' })).toHaveCount(0)
  await expect(page.getByRole('region', { name: '建立組別紀錄' })).toHaveCount(0)
  await expect(page.getByRole('region', { name: '紀錄' })).toHaveCount(0)
})

test('AC-ST-17：分組期過了，「我的組」只寫「分組期已經結束」，沒有表單、沒有「請聯絡系辦」', async ({ page }) => {
  await setClock(new Date(now.getTime() + 40 * DAY), 'e2e ST-5：推過分組期')
  try {
    await signIn(page, loner)
    await page.goto(GROUPS)
    const main = page.getByRole('main')
    await expect(page.getByRole('navigation', { name: '組別分頁' }).getByRole('link', { name: '我的組' })).toHaveAttribute('aria-current', 'page')
    await expect(page.getByRole('region', { name: '我的組別狀態' })).toContainText('分組期已經結束')
    await expect(page.getByRole('button', { name: '送出邀請' })).toHaveCount(0)
    await expect(page.getByRole('region', { name: '邀請進度' })).toHaveCount(0)
    await expect(main).not.toContainText('請聯絡系辦')
  } finally {
    await setClock(now, 'e2e ST-5：回到真實時間')
  }
})

test('AC-C3-09：找隊員按「邀請加入」→ 導到我的組、學號預填並顯示頭像與姓名；再按一位累加成 invite=A,B', async ({ page }) => {
  await signIn(page, loner)
  await page.goto(`${GROUPS}?tab=team`)
  const list = page.getByRole('region', { name: '找隊員名單' })
  await expect(list.getByRole('article')).toHaveCount(2)
  await list.getByRole('article', { name: others[0]!.name }).getByRole('link', { name: '邀請加入' }).click()
  await expect(page).toHaveURL(new RegExp(`${GROUPS}\\?tab=mine&invite=${others[0]!.studentNo}$`))
  const form = page.getByRole('region', { name: '我的組別狀態' })
  const slot1 = page.getByLabel(/^同學 1 的學號/)
  await expect(slot1).toHaveValue(others[0]!.studentNo)
  // 預填的學號一掛上就查：格子底下出現 A 的頭像與姓名。
  const hint1 = form.locator('p[aria-live]').nth(0)
  await expect(hint1).toContainText(others[0]!.name)
  await expect(hint1.locator('img')).toHaveCount(1)

  // 回找隊員（分頁連結帶著 invite）再按 B：invite=A,B，第 3 格（同學 2）是 B。
  await page.getByRole('navigation', { name: '組別分頁' }).getByRole('link', { name: '找隊員' }).click()
  await expect(page).toHaveURL(/tab=team&invite=/)
  await list.getByRole('article', { name: others[1]!.name }).getByRole('link', { name: '邀請加入' }).click()
  await expect(page).toHaveURL(new RegExp(`invite=${others[0]!.studentNo},${others[1]!.studentNo}$`))
  await expect(page.getByLabel(/^同學 1 的學號/)).toHaveValue(others[0]!.studentNo)
  await expect(page.getByLabel(/^同學 2 的學號/)).toHaveValue(others[1]!.studentNo)
  await expect(form.locator('p[aria-live]').nth(1)).toContainText(others[1]!.name)
})

test('AC-ST-17／AC-C3-11：未分組預設「我的組」＝建立組別：第一格是自己、即時查學號、＋再加一位、邀請進度；送出後同位置換成「建立中」；找隊員的邀請加入變 disabled', async ({ page }) => {
  await signIn(page, loner)
  await page.goto(GROUPS)
  const main = page.getByRole('main')
  const tabs = page.getByRole('navigation', { name: '組別分頁' })
  await expect(tabs.getByRole('link')).toHaveText(['我的組', '找隊員'])
  await expect(tabs.getByRole('link', { name: '我的組' })).toHaveAttribute('aria-current', 'page')
  const status = page.getByRole('region', { name: '我的組別狀態' })
  await expect(status).toContainText('建立組別')
  await expect(status).toContainText('本屆每組 2–5 人（含你自己）')
  await expect(status.getByRole('radio', { name: '一般專題' })).toBeVisible()
  await expect(status.getByRole('radio', { name: '產學合作' })).toBeVisible()
  // 選一般專題時沒有「合作案」欄。
  await expect(status.getByLabel('合作案')).toHaveCount(0)
  // 第一格是自己：頭像、姓名、「你」、學號。
  const loneSelf = await pool.query<{ display_name: string; student_no: string }>('select display_name, student_no from user_profiles where user_id = $1', [loner.userId])
  await expect(status).toContainText(loneSelf.rows[0]!.display_name)
  await expect(status).toContainText(loneSelf.rows[0]!.student_no)
  await expect(status.getByText('你', { exact: true })).toBeVisible()
  // 右欄「邀請進度」三步。
  const progress = page.getByRole('region', { name: '邀請進度' })
  await expect(progress.getByRole('listitem')).toHaveCount(3)
  await expect(progress).toContainText('送出邀請')
  await expect(progress).toContainText('同學確認')
  await expect(progress).toContainText('組別成立')
  // 每組 2–5 人：一開始只有「同學 1」一格（必填）；按「＋再加一位（可不填）」多一格。
  await expect(page.getByLabel(/^同學 \d 的學號/)).toHaveCount(1)
  await status.getByRole('button', { name: '＋再加一位（可不填）' }).click()
  await expect(page.getByLabel(/^同學 \d 的學號/)).toHaveCount(2)
  await expect(page.getByLabel('同學 2 的學號（可不填）')).toBeVisible()

  // 即時查學號：失焦後顯示頭像與姓名；已成組的學號寫「找不到這個學號，或他已經有組別」。
  const slot1 = page.getByLabel(/^同學 1 的學號/)
  const slot2 = page.getByLabel(/^同學 2 的學號/)
  await slot1.fill(others[0]!.studentNo)
  await slot1.blur()
  const hint1 = status.locator('p[aria-live]').nth(0)
  await expect(hint1).toContainText(others[0]!.name)
  await expect(hint1.locator('img')).toHaveCount(1)
  await slot2.fill(members[0]!.studentNo)
  await slot2.blur()
  await expect(status.locator('p[aria-live]').nth(1)).toContainText('找不到這個學號，或他已經有組別')
  await expect(status.locator('p[aria-live]').nth(1).locator('img')).toHaveCount(0)
  await slot2.fill('')
  await slot2.blur()
  await expect(status.locator('p[aria-live]').nth(1)).toHaveText('')
  await expect(status.getByRole('button', { name: '送出邀請' })).toBeVisible()
  await expect(main).not.toContainText(/提案|組隊中/)

  // 找隊員：公開開關、名單 2 張卡；名單空只一句，不叫人洽系辦、不連產學合作案。
  await page.goto(`${GROUPS}?tab=team`)
  await expect(page.getByRole('button', { name: '公開找隊員' })).toBeVisible()
  const list = page.getByRole('region', { name: '找隊員名單' })
  await expect(list.getByRole('article')).toHaveCount(2)
  for (const o of others) await expect(list).toContainText(o.name)
  await expect(page.getByRole('region', { name: '我的組別狀態' })).toHaveCount(0)
  await pool.query(`update user_profiles set open_to_join = false where user_id = any($1::uuid[])`, [others.map((o) => o.userId)])
  await page.reload()
  await expect(list).toContainText('目前沒有公開找隊員的同學')
  await expect(list.getByRole('link')).toHaveCount(0)
  await expect(main).not.toContainText('洽系辦')
  await expect(main.getByRole('link', { name: '看產學合作案' })).toHaveCount(0)
  await pool.query(`update user_profiles set open_to_join = true where user_id = any($1::uuid[])`, [others.map((o) => o.userId)])

  // 送出邀請：留在「我的組」，同位置換成狀態卡「建立中（等全員確認）」，成員格有已確認／待確認、到期時間、「撤回」。
  await page.goto(GROUPS)
  await status.getByRole('radio', { name: '一般專題' }).check()
  await page.getByLabel(/^同學 1 的學號/).fill(others[0]!.studentNo)
  await status.getByRole('button', { name: '送出邀請' }).click()
  await expect(status).toContainText('建立中（等全員確認）')
  await expect(status).toContainText('0／2 已確認')
  await expect(status).toContainText('到期時間')
  const seats = status.getByRole('list', { name: '成員' }).getByRole('listitem')
  await expect(seats).toHaveCount(2)
  await expect(seats.filter({ hasText: others[0]!.name })).toContainText('待確認')
  await expect(status.getByRole('button', { name: '撤回', exact: true })).toBeVisible()
  await expect(tabs.getByRole('link', { name: '我的組' })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('region', { name: '邀請進度' })).toHaveCount(0)
  await expect(main).toContainText('本屆每組 2–5 人')
  await expect(main).not.toContainText(/提案|組隊中/)

  // 已送出建立：找隊員每張卡的「邀請加入」disabled、旁邊寫原因（AC-C3-09 後半）。
  await page.goto(`${GROUPS}?tab=team`)
  await expect(list.getByRole('article')).toHaveCount(2)
  for (const o of others) {
    const card = list.getByRole('article', { name: o.name })
    await expect(card.getByRole('button', { name: '邀請加入' })).toBeDisabled()
    await expect(card).toContainText('你已送出建立組別，等大家確認後再邀請')
    await expect(card.getByRole('link', { name: '邀請加入' })).toHaveCount(0)
  }
})

test('AC-C3-12／AC-C3-26（學生側）：產學合作必選合作案（只列已發布）；成立瞬間 pending 連結＋通知負責老師；我的組顯示合作案；被婉拒後「還沒有合作案」＋組長重選', async ({ page }) => {
  await signIn(page, indE)
  await page.goto(GROUPS)
  const main = page.getByRole('main')
  const status = page.getByRole('region', { name: '我的組別狀態' })
  await status.getByRole('radio', { name: '產學合作' }).check()
  const picker = status.getByLabel('合作案')
  await expect(picker).toBeVisible()
  // 下拉只有已發布的甲與丙（乙是草稿）；還有一個「請選合作案」的空選項。
  await expect(picker.getByRole('option')).toHaveCount(3)
  await expect(picker).toContainText(opportunities.甲.company)
  await expect(picker).toContainText(opportunities.丙.company)
  await expect(picker).not.toContainText(opportunities.乙.company)
  await expect(picker).toContainText(`${ADVISOR_NAME} 老師`)

  // 不選就送出：被擋「請選合作案」，什麼都沒建。
  await page.getByLabel(/^同學 1 的學號/).fill(indAMember.studentNo)
  await status.getByRole('button', { name: '送出邀請' }).click()
  await expect(main.getByRole('alert')).toContainText('請選合作案')
  expect((await pool.query('select count(*)::int as n from group_proposals where proposer_user_id = $1', [indE.userId])).rows[0]!.n).toBe(0)

  await picker.selectOption(opportunities.甲.id)
  await status.getByRole('button', { name: '送出邀請' }).click()
  await expect(status).toContainText('建立中（等全員確認）')
  await expect(status).toContainText(`合作案：${opportunities.甲.company}・研發部（${ADVISOR_NAME} 老師）`)
  const proposal = await pool.query<{ id: string; group_type: string; opportunity_id: string }>(
    `select id, group_type, opportunity_id from group_proposals where proposer_user_id = $1 and state = 'open'`,
    [indE.userId],
  )
  expect(proposal.rows[0]).toMatchObject({ group_type: 'industry', opportunity_id: opportunities.甲.id })
  // 成立前沒有連結、沒通知老師。
  expect((await pool.query('select count(*)::int as n from opportunity_links where opportunity_id = $1', [opportunities.甲.id])).rows[0]!.n).toBe(0)

  // A 登入看到發起人 E、按「確認加入」；E 再按，成立。
  await signIn(page, indA)
  await page.goto(GROUPS)
  await expect(status).toContainText(`發起人 ${indEMember.name}`)
  await page.getByRole('button', { name: '確認加入' }).click()
  await expect(main.getByRole('status')).toContainText('已確認（1／2 已確認）')
  await signIn(page, indE)
  await page.goto(GROUPS)
  await page.getByRole('button', { name: '確認加入' }).click()
  await expect(main.getByRole('status')).toContainText('成立了')

  // 成立瞬間：groups.group_type='industry'、opportunity_links 一列 pending、負責老師收到 link_requested。
  const group = await pool.query<{ id: string; code: string; group_type: string }>(
    `select g.id, g.code, g.group_type from groups g join group_proposals p on p.established_group_id = g.id where p.id = $1`,
    [proposal.rows[0]!.id],
  )
  expect(group.rows[0]!.group_type).toBe('industry')
  const links = await pool.query<{ state: string; valid_to: Date | null }>('select state, valid_to from opportunity_links where group_id = $1', [group.rows[0]!.id])
  expect(links.rows).toEqual([{ state: 'pending', valid_to: null }])
  const requested = await pool.query<{ recipients: string[]; payload: { title: string } }>(
    `select recipients, payload from domain_events where type = 'opportunity.link_requested' and source_id = $1`,
    [opportunities.甲.id],
  )
  expect(requested.rows).toHaveLength(1)
  expect(requested.rows[0]!.recipients).toEqual([teacher.userId])
  expect(requested.rows[0]!.payload.title).toContain(`${group.rows[0]!.code} 選了你的合作案「${opportunities.甲.company}・研發部」`)
  // 站內收件匣（worker 消化事件後）：負責老師多一則。
  await expect
    .poll(
      async () =>
        (await pool.query(`select count(*)::int as n from notifications where recipient_user_id = $1 and title like '%選了你的合作案%'`, [teacher.userId])).rows[0]!.n,
      { timeout: 30_000 },
    )
    .toBe(1)

  // E 的「我的組」：合作案：甲（T1 老師）・待老師確認；沒有「提案」「組隊中」；紀錄寫已成立。
  await page.goto(GROUPS)
  await expect(main).toContainText(`${group.rows[0]!.code}・產學合作`)
  const row = page.getByTestId('my-opportunity')
  await expect(row).toContainText(`${opportunities.甲.company}・研發部（${ADVISOR_NAME} 老師）・待老師確認`)
  await expect(row.getByLabel('選合作案')).toHaveCount(0)
  await expect(page.getByRole('region', { name: '建立組別紀錄' })).toContainText(`已成立（${group.rows[0]!.code}）`)
  await expect(main).not.toContainText(/提案|組隊中/)

  // 負責老師婉拒（C3-09 的用例；這裡直接結束連結）→ 組長的「我的組」：「還沒有合作案」＋「選合作案」下拉（只有已發布）→ 選丙 → 新 pending 連結＋通知。
  await pool.query(
    `update opportunity_links set valid_to = now(), ended_real_at = now(), ended_by_user_id = $2 where group_id = $1 and valid_to is null`,
    [group.rows[0]!.id, teacher.userId],
  )
  await page.reload()
  await expect(row).toContainText('還沒有合作案')
  const repick = row.getByLabel('選合作案')
  await expect(repick.getByRole('option')).toHaveCount(3)
  await expect(repick).not.toContainText(opportunities.乙.company)
  await repick.selectOption(opportunities.丙.id)
  await row.getByRole('button', { name: '送出' }).click()
  await expect(main.getByRole('status')).toContainText(`已選「${opportunities.丙.company}・研發部」，等負責老師確認指導`)
  await expect(row).toContainText(`${opportunities.丙.company}・研發部（${ADVISOR_NAME} 老師）・待老師確認`)
  const relinked = await pool.query<{ state: string; opportunity_id: string }>(
    'select state, opportunity_id from opportunity_links where group_id = $1 and valid_to is null',
    [group.rows[0]!.id],
  )
  expect(relinked.rows).toEqual([{ state: 'pending', opportunity_id: opportunities.丙.id }])
  const requestedAgain = await pool.query<{ recipients: string[] }>(
    `select recipients from domain_events where type = 'opportunity.link_requested' and source_id = $1`,
    [opportunities.丙.id],
  )
  expect(requestedAgain.rows).toHaveLength(1)
  expect(requestedAgain.rows[0]!.recipients).toEqual([teacher.userId])

  // 組員（不是組長）看得到合作案狀態，但沒有選案的下拉。
  await pool.query(
    `update opportunity_links set valid_to = now(), ended_real_at = now(), ended_by_user_id = $2 where group_id = $1 and valid_to is null`,
    [group.rows[0]!.id, teacher.userId],
  )
  await signIn(page, indA)
  await page.goto(GROUPS)
  await expect(page.getByTestId('my-opportunity')).toContainText('還沒有合作案')
  await expect(page.getByTestId('my-opportunity').getByLabel('選合作案')).toHaveCount(0)
})
