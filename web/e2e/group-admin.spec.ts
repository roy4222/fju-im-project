import { expect, request as playwrightRequest, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, sharedTestSession, toPlaywrightCookie, type TestSession } from './session'

/**
 * 票 14（#225）：每組人數設定、管理員調整組員與換組長。「做完的樣子」逐條走：
 *
 * 1. 每組人數由管理員設定、學生提案照設定擋——票 13 的 groups.spec「分組設定」與整合測試已證明；
 *    這裡看管理員端：人數和設定不符時顯示「與設定不符」提醒，但允許。
 * 2. 管理員把未分組學生加入某組（理由選填，C3-05）；把組長移出時要先指定接任。
 * 3. 管理員填理由換組長，組別詳情與學生的「我的組別」都看得到歷史（學生看不到理由）。
 * 4. 只換組長不發成員異動事件（不重簽）；加入／移出才發。
 * 資格、正在提案中的學生、移出最後一人、並發等拒絕路徑由整合測試 pg-group-members.integration.test.ts 證明。
 *
 * 組別本身直接用 owner 連線建好（成組流程是票 13 的事，groups.spec 已走過真的畫面）；
 * 票 14 的動作全程用真的表單與按鈕，重新整理後再看，確認是存進資料庫。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()
const CODE = `T14-${stamp}`

type Member = { userId: string; name: string; studentNo: string }

let pool: Pool
let cohortId: string
let groupId: string
let adminId: string
/** members[1] 有真的登入狀態（看學生頁用），其他人只在資料庫。members[0] 是成立時的組長。 */
const members: Member[] = []
let viewer: TestSession
let newcomer: Member

function ymd(date: Date): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}

async function insertStudent(userId: string | null, index: number): Promise<Member> {
  const studentNo = `414${String(Date.now()).slice(-5)}${index}`
  const name = `組員${index}號`
  let id = userId
  if (!id) {
    const user = await pool.query<{ id: string }>(
      `insert into users (id, name, email, email_verified, updated_at, status)
       values (gen_random_uuid(), $1, $2, true, now(), 'active') returning id`,
      [name, `t14-${stamp.toLowerCase()}-${index}@example.com`],
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
    [id, name, studentNo, cohortId, `t14-${index}@contact.example.com`],
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
     values (gen_random_uuid(), 'staging', now(), now(), $1, 'e2e 票 14：回到真實時間')`,
    [adminId],
  )
  const cohort = await pool.query<{ id: string }>(
    `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
     values (gen_random_uuid(), $1, $2, 'active', $3, 'system') returning id`,
    [CODE, `${CODE} 調整組員測試`, ymd(new Date(now.getTime() + 300 * 86_400_000))],
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

  for (let i = 1; i <= 5; i += 1) members.push(await insertStudent(i === 2 ? viewer.userId : null, i))
  newcomer = await insertStudent(null, 6)

  // 已成立的 G01：五人、組長是 members[0]（和票 13 成立時寫的列一樣：同一個時間點）。
  const establishedAt = new Date(now.getTime() - 86_400_000)
  const group = await pool.query<{ id: string }>(
    `insert into groups (id, cohort_id, code, group_type, status, established_real_at, established_business_at,
                         created_at, created_by_kind, created_by_user_id, updated_at, updated_by_user_id)
     values (gen_random_uuid(), $1, 'G01', 'general', 'active', $3, $3, $3, 'user', $2, $3, $2) returning id`,
    [cohortId, members[0]!.userId, establishedAt],
  )
  groupId = group.rows[0]!.id
  await pool.query(
    `insert into group_memberships (id, group_id, cohort_id, user_id, valid_from, added_by_kind, added_by_user_id, created_at, updated_at)
     select gen_random_uuid(), $1, $2, u, $5, 'user', $3, $5, $5 from unnest($4::uuid[]) as u`,
    [groupId, cohortId, members[0]!.userId, members.map((m) => m.userId), establishedAt],
  )
  await pool.query(
    `insert into group_leaders (id, group_id, user_id, valid_from, changed_by_user_id, created_at)
     values (gen_random_uuid(), $1, $2, $3, $2, $3)`,
    [groupId, members[0]!.userId, establishedAt],
  )
})

test.afterAll(async () => {
  await pool?.end()
})

async function signIn(page: Page, session: TestSession) {
  await page.context().clearCookies()
  await page.context().addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
}

async function openAdminPage(page: Page) {
  await signIn(page, await sharedTestSession(page.request, 'admin'))
  await page.goto(`/dashboard/admin/groups?cohort=${cohortId}`)
  await expect(page.getByRole('heading', { name: '分組', exact: true })).toBeVisible()
}

async function openDetail(page: Page) {
  await page.getByRole('article', { name: 'G01', exact: true }).getByRole('link', { name: '進入小組' }).click()
  await expect(page).toHaveURL(new RegExp(`/dashboard/admin/groups/${groupId}$`))
  return page.getByRole('main')
}

async function eventCount(type: string): Promise<number> {
  const rows = await pool.query<{ n: number }>(
    `select count(*)::int as n from domain_events where type = $1 and source_id = $2`,
    [type, groupId],
  )
  return rows.rows[0]!.n
}

test('加入某組：預覽提醒人數會和設定不符；加入後允許並標「與設定不符」，全組收到成員異動', async ({ page }) => {
  await openAdminPage(page)
  await page.getByRole('article', { name: 'G01', exact: true }).getByRole('button', { name: '加人：G01' }).click()
  const dialog = page.getByRole('dialog', { name: '把學生加入 G01' })
  await dialog.getByLabel('未分組學生').selectOption(newcomer.studentNo)
  await expect(dialog).toContainText('人數與設定不符：6 人，超過本屆每組最多 5 人')

  await expect(dialog.getByLabel('理由（可不填）')).toHaveValue('')
  await dialog.getByRole('button', { name: '確認加入' }).click()
  await expect(page.getByRole('main').getByRole('status').filter({ hasText: '已把' })).toContainText(
    `已把 ${newcomer.name} 加入 G01；現在 6 人（人數與設定不符：6 人，超過本屆每組最多 5 人）`,
  )

  await page.reload()
  const groups = page.getByRole('region', { name: '全部組別' })
  await expect(groups).toContainText('6 人（與設定不符）')
  await expect(groups).toContainText(newcomer.name)
  await page.goto(`/dashboard/admin/groups/unassigned?cohort=${cohortId}`)
  await expect(page.getByRole('region', { name: '未分組學生' })).not.toContainText(newcomer.name)
  expect(await eventCount('group.members_changed')).toBe(1)
})

test('移出組長：沒指定接任被拒；指定接任後移出，詳情看得到新名單、理由與歷程', async ({ page }) => {
  await openAdminPage(page)
  const detail = await openDetail(page)
  await detail.getByRole('button', { name: `移除：${members[0]!.name}` }).click()
  const dialog = page.getByRole('dialog', { name: '移除 G01 的組員' })
  await dialog.getByLabel('理由（可不填）').fill('轉系')
  await dialog.getByRole('button', { name: '確定移除' }).click()
  await expect(dialog.getByRole('alert')).toContainText('要移出的是組長：請同時指定接任的組長')

  await dialog.getByLabel(/接任組長/).selectOption({ label: members[2]!.name })
  await dialog.getByRole('button', { name: '確定移除' }).click()
  await expect(detail.getByRole('status')).toContainText(`已把 ${members[0]!.name} 移出 G01，組長改由 ${members[2]!.name} 接任；現在 5 人`)
  await expect(detail.getByRole('region', { name: '組員', exact: true })).not.toContainText(members[0]!.name)
  const history = detail.getByRole('region', { name: '異動紀錄' })
  await expect(history).toContainText(`${members[0]!.name} 移出`)
  await expect(history).toContainText(`組長 ${members[0]!.name} → ${members[2]!.name}`)
  await expect(history).toContainText('理由：轉系')

  await page.reload()
  await expect(page.getByRole('row').filter({ hasText: members[2]!.name })).toContainText('組長')
  await page.goto(`/dashboard/admin/groups/unassigned?cohort=${cohortId}`)
  await expect(page.getByRole('region', { name: '未分組學生' })).toContainText(members[0]!.name)
  expect(await eventCount('group.member_removed')).toBe(1)
})

test('換組長：填理由換給另一位成員；只換組長不發成員異動事件（不重簽）；重新整理後歷程還在', async ({ page }) => {
  const membersChangedBefore = await eventCount('group.members_changed')
  await openAdminPage(page)
  const detail = await openDetail(page)
  await detail.getByRole('button', { name: `設為組長：${members[1]!.name}` }).click()
  const dialog = page.getByRole('dialog', { name: `把 G01 的組長換成 ${members[1]!.name}？` })
  await dialog.getByLabel('理由（可不填）').fill('原組長請辭，全組同意')
  await dialog.getByRole('button', { name: '確定更換' }).click()
  await expect(detail.getByRole('status')).toContainText(`G01 的組長已從 ${members[2]!.name} 換成 ${members[1]!.name}`)

  expect(await eventCount('group.leader_changed')).toBe(1)
  expect(await eventCount('group.members_changed')).toBe(membersChangedBefore)
  const recipients = await pool.query<{ n: number }>(
    `select cardinality(recipients)::int as n from domain_events where type = 'group.leader_changed' and source_id = $1`,
    [groupId],
  )
  expect(recipients.rows[0]!.n).toBe(5)

  await page.reload()
  await expect(page.getByRole('row').filter({ hasText: members[1]!.name })).toContainText('組長')
  const history = page.getByRole('region', { name: '異動紀錄' })
  await expect(history).toContainText(`組長 ${members[2]!.name} → ${members[1]!.name}`)
  await expect(history).toContainText('理由：原組長請辭，全組同意')
})

test('AC-C3-18：歷程隨詳情 SSR 載入，重新整理仍有操作者與理由；直接 HTTP 守門', async ({ page }) => {
  await openAdminPage(page)
  await openDetail(page)
  const history = page.getByRole('region', { name: '異動紀錄' })
  await expect(history).toContainText('原組長請辭，全組同意')
  await page.reload()
  await expect(history.getByRole('listitem').first()).toBeVisible()
  const admin = await sharedTestSession(page.request, 'admin')
  const html = await page.request.get(`/dashboard/admin/groups/${groupId}`, { headers: { cookie: admin.cookie } })
  expect(html.status()).toBe(200)
  expect(await html.text()).toContain('原組長請辭，全組同意')
  const wrong = await page.request.get(`/dashboard/admin/groups/${groupId}`, { headers: { cookie: viewer.cookie }, maxRedirects: 0 })
  expect(wrong.status()).toBe(307)
  expect(wrong.headers().location).toBe('/403')
  expect(await wrong.text()).not.toContain('異動紀錄')
  await page.goto('/403')
  await expect(page).toHaveURL(/\/403$/)
  expect((await page.request.get('/dashboard/admin/groups/00000000-0000-4000-8000-000000000673', { headers: { cookie: admin.cookie } })).status()).toBe(404)
})

test('學生的「我的組別」看得到組長與異動歷程，但看不到理由', async ({ page }) => {
  await signIn(page, viewer)
  await page.goto('/dashboard/student/groups?tab=mine')
  const status = page.getByRole('region', { name: '我的組別狀態' })
  await expect(status).toContainText('G01')
  await expect(page.getByRole('list', { name: '組員' }).getByRole('listitem').filter({ hasText: '組長' })).toContainText(members[1]!.name)
  // 異動在「紀錄」分頁（AC-ST-18）；理由整頁都不出現。
  await page.goto('/dashboard/student/groups?tab=log')
  const history = page.getByRole('list', { name: '組別異動' })
  await expect(history).toContainText(`${newcomer.name} 加入`)
  await expect(history).toContainText(`組長 ${members[2]!.name} → ${members[1]!.name}`)
  await expect(page.getByRole('main')).not.toContainText('原組長請辭')
  await expect(page.getByRole('main')).not.toContainText('轉系')
})

test('AC-C3-18：詳情也攔下必須改密與待審帳號', async ({ page }) => {
  const adminRequest = await playwrightRequest.newContext({ baseURL: BASE_URL })
  const mustChange = await createTestSession(adminRequest, 'admin').finally(() => adminRequest.dispose())
  await pool.query('update users set must_change_password = true where id = $1', [mustChange.userId])
  const password = await page.request.get(`/dashboard/admin/groups/${groupId}`, { headers: { cookie: mustChange.cookie }, maxRedirects: 0 })
  expect(password.status()).toBe(307)
  expect(password.headers().location).toBe('/account/change-password')
  expect(await password.text()).not.toContain('異動紀錄')
  const pendingRequest = await playwrightRequest.newContext({ baseURL: BASE_URL })
  const pending = await createTestSession(pendingRequest, null).finally(() => pendingRequest.dispose())
  await pool.query('update users set email_verified = true where id = $1', [pending.userId])
  const review = await page.request.get(`/dashboard/admin/groups/${groupId}`, { headers: { cookie: pending.cookie }, maxRedirects: 0 })
  expect(review.status()).toBe(307)
  expect(review.headers().location).toBe('/register/pending')
  expect(await review.text()).not.toContain('異動紀錄')
})

test('AC-C3-16：卡片移除組長，理由留空仍須指定接任；回執與異動紀錄持續可見', async ({ page }) => {
  await openAdminPage(page)
  const card = page.getByRole('article', { name: 'G01', exact: true })
  await card.getByRole('button', { name: '移除組員：G01' }).click()
  const dialog = page.getByRole('dialog', { name: '移除 G01 的組員' })
  await dialog.getByLabel('要移除的組員').selectOption(members[1]!.userId)
  await expect(dialog.getByLabel('理由（可不填）')).toHaveValue('')
  await dialog.getByRole('button', { name: '確定移除' }).click()
  await expect(dialog.getByRole('alert')).toContainText('要移出的是組長：請同時指定接任的組長')
  await dialog.getByLabel(/接任組長/).selectOption(members[2]!.userId)
  await dialog.getByRole('button', { name: '確定移除' }).click()
  await expect(card.getByRole('status')).toContainText(`已把 ${members[1]!.name} 移出 G01，組長改由 ${members[2]!.name} 接任；現在 4 人`)
  await expect(card.getByRole('list', { name: '組員' })).not.toContainText(members[1]!.name)
  await expect(card.getByRole('list', { name: '組員' }).getByRole('listitem').filter({ hasText: members[2]!.name })).toContainText('組長')
  await card.getByRole('link', { name: '進入小組' }).click()
  const entry = page.getByRole('region', { name: '異動紀錄' }).getByRole('listitem').filter({ hasText: `${members[1]!.name} 移出` })
  await expect(entry).toHaveCount(1)
  await expect(entry).not.toContainText('理由：')
  await page.reload()
  await expect(entry).toBeVisible()
})

/**
 * AD-05（系辦分組頁改版；驗收案例 AC-AD-10、12、14、23）：自己一屆、自己的組別與提案，不動上面票 14 的資料。
 * 12 組（G03 產學、未連結合作案；G05 只剩一人），2 份組隊中提案、1 份管理員作廢的提案。
 */
test.describe('AD-05 系辦分組頁', () => {
  const AD05 = `AD05-${stamp}`
  let ad05Cohort: string

  async function ad05Student(index: number): Promise<{ userId: string; name: string }> {
    const name = `分組頁${index}號`
    const user = await pool.query<{ id: string }>(
      `insert into users (id, name, email, email_verified, updated_at, status)
       values (gen_random_uuid(), $1, $2, true, now(), 'active') returning id`,
      [name, `ad05-${stamp.toLowerCase()}-${index}@example.com`],
    )
    const id = user.rows[0]!.id
    await pool.query(
      `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at)
       values (gen_random_uuid(), $1, 'student', $2, now())`,
      [id, adminId],
    )
    const studentNo = `415${String(Date.now()).slice(-4)}${String(index).padStart(2, '0')}`
    await pool.query(
      `insert into user_profiles (user_id, display_name, name_normalized, student_no, cohort_id, phone, contact_email)
       values ($1, $2, $2, $3, $4, '0912000000', $5)`,
      [id, name, studentNo, ad05Cohort, `ad05-${index}@contact.example.com`],
    )
    await pool.query(`insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)`, [ad05Cohort, studentNo, id])
    return { userId: id, name }
  }

  test.beforeAll(async () => {
    test.setTimeout(240_000)
    const now = new Date()
    const cohort = await pool.query<{ id: string }>(
      `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
       values (gen_random_uuid(), $1, $2, 'active', $3, 'system') returning id`,
      [AD05, `${AD05} 分組頁測試`, ymd(new Date(now.getTime() + 300 * 86_400_000))],
    )
    ad05Cohort = cohort.rows[0]!.id
    for (const [i, start] of [-10, 30, 90, 150].map((d) => ymd(new Date(now.getTime() + d * 86_400_000))).entries()) {
      await pool.query(
        `insert into cohort_stages (id, cohort_id, seq, name, start_date, created_by_kind)
         values (gen_random_uuid(), $1, $2, $3, $4, 'system')`,
        [ad05Cohort, i + 1, ['成組期', '期中', '期末', '成果'][i], start],
      )
    }

    let index = 0
    const at = new Date(now.getTime() - 86_400_000)
    for (let n = 1; n <= 12; n += 1) {
      const code = `G${String(n).padStart(2, '0')}`
      const people = []
      for (let k = 0; k < (code === 'G05' ? 1 : 3); k += 1) people.push(await ad05Student((index += 1)))
      const group = await pool.query<{ id: string }>(
        `insert into groups (id, cohort_id, code, group_type, status, established_real_at, established_business_at,
                             created_at, created_by_kind, created_by_user_id, updated_at, updated_by_user_id)
         values (gen_random_uuid(), $1, $2, $3, 'active', $5, $5, $5, 'user', $4, $5, $4) returning id`,
        [ad05Cohort, code, code === 'G03' ? 'industry' : 'general', people[0]!.userId, at],
      )
      await pool.query(
        `insert into group_memberships (id, group_id, cohort_id, user_id, valid_from, added_by_kind, added_by_user_id, created_at, updated_at)
         select gen_random_uuid(), $1, $2, u, $5, 'user', $3, $5, $5 from unnest($4::uuid[]) as u`,
        [group.rows[0]!.id, ad05Cohort, people[0]!.userId, people.map((p) => p.userId), at],
      )
      await pool.query(
        `insert into group_leaders (id, group_id, user_id, valid_from, changed_by_user_id, created_at)
         values (gen_random_uuid(), $1, $2, $3, $2, $3)`,
        [group.rows[0]!.id, people[0]!.userId, at],
      )
    }

    // G01～G06 有指導老師（名字取長一點，1280 寬的版面檢查才有代表性）；G07～G12 還沒指派。
    const context = await playwrightRequest.newContext({ baseURL: BASE_URL })
    const teacher = await createTestSession(context, 'teacher')
    await context.dispose()
    await pool.query(`update users set name = '歐陽指導老師' where id = $1`, [teacher.userId])
    await pool.query(`update user_profiles set display_name = '歐陽指導老師' where user_id = $1`, [teacher.userId])
    await pool.query(
      `insert into advisor_assignments (id, group_id, teacher_user_id, source, valid_from, assigned_by_user_id, reason)
       select gen_random_uuid(), g.id, $2, 'admin', now(), $3, 'e2e AD-05 指派'
         from groups g where g.cohort_id = $1 and g.code in ('G01','G02','G03','G04','G05','G06')`,
      [ad05Cohort, teacher.userId, adminId],
    )

    // 兩份組隊中、一份管理員作廢（提案人與受邀者都是還沒分組的學生）。
    const expires = new Date(now.getTime() + 5 * 86_400_000)
    for (const state of ['open', 'open', 'terminated'] as const) {
      const proposer = await ad05Student((index += 1))
      const invitee = await ad05Student((index += 1))
      const proposal = await pool.query<{ id: string }>(
        state === 'open'
          ? `insert into group_proposals (id, cohort_id, proposer_user_id, group_type, expires_business_at, state,
                                          created_real_at, created_business_at, updated_at)
             values (gen_random_uuid(), $1, $2, 'general', $3, 'open', now(), now(), now()) returning id`
          : `insert into group_proposals (id, cohort_id, proposer_user_id, group_type, expires_business_at, state,
                                          termination_kind, reason, created_real_at, created_business_at,
                                          closed_real_at, closed_business_at, closed_by_kind, closed_by_user_id, updated_at)
             values (gen_random_uuid(), $1, $2, 'general', $3, 'terminated', 'admin_voided', 'AD-05 測試作廢', now(), now(),
                     now(), now(), 'user', $4, now()) returning id`,
        state === 'open' ? [ad05Cohort, proposer.userId, expires] : [ad05Cohort, proposer.userId, expires, adminId],
      )
      await pool.query(
        `insert into proposal_invitations (id, proposal_id, user_id, state, decided_real_at)
         values (gen_random_uuid(), $1, $2, $4, now()), (gen_random_uuid(), $1, $3, $5, null)`,
        [proposal.rows[0]!.id, proposer.userId, invitee.userId, state === 'open' ? 'confirmed' : 'released', state === 'open' ? 'pending' : 'released'],
      )
    }
  })

  async function openAd05(page: Page) {
    await signIn(page, await sharedTestSession(page.request, 'admin'))
    await page.goto(`/dashboard/admin/groups?cohort=${ad05Cohort}`)
    await expect(page.getByRole('heading', { name: '分組', exact: true, level: 1 })).toBeVisible()
  }

  test('AC-AD-10：標題「分組」＋分頁列；分組設定在分頁列右側；全部組別是卡片格、沒有舊區塊', async ({ page }) => {
    await openAd05(page)
    await expect(page).toHaveTitle('分組｜資管系專題平台')
    const tabs = page.getByRole('navigation', { name: '分組分頁' })
    await expect(tabs.getByRole('link')).toHaveText(['全部組別', '未分組學生', '產學合作'])
    await expect(tabs.getByRole('link', { name: '全部組別' })).toHaveAttribute('aria-current', 'page')
    await expect(tabs.getByRole('link', { name: '產學合作' })).not.toHaveAttribute('aria-current', 'page')

    // 「分組設定」跟分頁列同一列（右側），不在標題那一列：按鈕在 h1 下面、跟分頁連結同一條水平帶。
    const settings = page.getByRole('button', { name: '分組設定' })
    const h1 = (await page.getByRole('heading', { name: '分組', exact: true, level: 1 }).boundingBox())!
    const tab = (await tabs.getByRole('link', { name: '全部組別' }).boundingBox())!
    const button = (await settings.boundingBox())!
    expect(button.y).toBeGreaterThanOrEqual(h1.y + h1.height)
    expect(button.x).toBeGreaterThan(tab.x + tab.width)
    expect(button.y + button.height).toBeGreaterThan(tab.y)
    expect(button.y).toBeLessThan(tab.y + tab.height)
    // 頁首說明句拿掉。
    await expect(page.getByRole('main')).not.toContainText('學生自行提案、全員確認後成組')

    for (const name of ['組隊中（等全員確認）', '最近終止的提案', '已解散的組別', '未分組學生']) {
      await expect(page.getByRole('region', { name })).toHaveCount(0)
    }
    await expect(page.getByRole('region', { name: '全部組別' }).locator('table')).toHaveCount(0)
    await expect(page.getByTestId('group-card')).toHaveCount(12)
    await expect(page.getByTestId('roster-row')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '匯入', exact: true })).toBeVisible()
    await expect(page.locator('summary').filter({ hasText: /^匯出$/ })).toBeVisible()
    await expect(page.getByTestId('advisor-summary')).toContainText('指導老師已指派 6／12・6 組尚未指派・產學組未連結合作案 1')

    // 分組設定成功訊息在對話框裡，不在標題列旁邊。
    await settings.click()
    const dialog = page.getByRole('dialog', { name: new RegExp(`（${AD05}） 的分組設定`) })
    await dialog.getByLabel('提案預設天數').fill('6')
    await dialog.getByRole('button', { name: '儲存' }).click()
    await expect(dialog.getByRole('status')).toContainText('提案 6 天內要全員確認')
    await expect(page.getByRole('main').getByRole('status')).toHaveCount(1)
    await dialog.getByRole('button', { name: '關閉' }).click()
    await expect(page.getByTestId('grouping-settings')).toContainText('提案 6 天內要全員確認')

    await tabs.getByRole('link', { name: '產學合作' }).click()
    await expect(page).toHaveURL(/\/dashboard\/admin\/industry$/)
  })

  test('AC-AD-12：一般組的列與詳情都沒有「連結合作案」；產學組的合作案欄留著位置', async ({ page }) => {
    await openAd05(page)
    const table = page.getByRole('region', { name: '全部組別' })
    await expect(table.getByRole('columnheader')).toHaveCount(0)
    // 入口＝按鈕或連結（AD-06 的「連結合作案 G03」）。「改類型」對話框本來就有「也沒有連結合作案」這句說明，不算入口。
    const g01 = table.getByRole('article', { name: 'G01', exact: true })
    await expect(g01.getByRole('button', { name: /連結合作案/ })).toHaveCount(0)
    await expect(g01.getByRole('link', { name: /連結合作案/ })).toHaveCount(0)
    await expect(g01.getByText('連結合作案', { exact: true })).toHaveCount(0)
    await expect(table.getByRole('article', { name: 'G03', exact: true })).toContainText('尚未連結')
    await g01.getByRole('link', { name: '進入小組' }).click()
    const detail = page.getByRole('main')
    await expect(detail).toBeVisible()
    await expect(detail).not.toContainText('連結合作案')
    await expect(detail.getByRole('button', { name: /連結合作案/ })).toHaveCount(0)
  })

  test('AC-AD-14：只剩一人的組，詳情寫「只剩一人時不能再移出」，沒有移出按鈕', async ({ page }) => {
    await openAd05(page)
    const card = page.getByRole('article', { name: 'G05', exact: true })
    await expect(card.getByRole('button', { name: '移除組員：G05' })).toBeDisabled()
    await card.getByRole('link', { name: '進入小組' }).click()
    const detail = page.getByRole('main')
    await expect(detail).toContainText('只剩一人時不能再移出')
    await expect(detail).not.toContainText('之後才會開放')
    await expect(detail.getByRole('button', { name: /^移除：/ })).toHaveCount(0)
  })

  test('AC-AD-23：1280 寬不溢出，卡片格兩欄沒有橫向捲軸，每列的操作按鈕完整可見、可點', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE_URL })
    await page.setViewportSize({ width: 1280, height: 800 })
    await openAd05(page)
    const page_ = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }))
    expect(page_.scroll).toBe(page_.client)

    const table = page.getByRole('region', { name: '全部組別' })
    await expect(table.getByTestId('group-card')).toHaveCount(12)
    const frame = table.getByRole('list', { name: '組別卡片' })
    const cards = table.getByTestId('group-card')
    const first = (await cards.nth(0).boundingBox())!
    const second = (await cards.nth(1).boundingBox())!
    expect(Math.abs(first.y - second.y)).toBeLessThan(2)
    expect(second.x).toBeGreaterThan(first.x + first.width)
    await page.screenshot({ path: test.info().outputPath('cards-1280.png'), fullPage: true })
    const box = await frame.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth, right: el.getBoundingClientRect().right }))
    expect(box.scroll).toBeLessThanOrEqual(box.client)
    for (const code of ['G01', 'G12']) {
      await table.getByRole('article', { name: code, exact: true }).locator('summary').click()
      const copy = table.getByRole('button', { name: `複製本組信箱：${code}` })
      await copy.scrollIntoViewIfNeeded()
      const b = (await copy.boundingBox())!
      expect(b.x + b.width).toBeLessThanOrEqual(box.right)
      await expect(table.getByRole('article', { name: code, exact: true }).getByRole('link', { name: '進入小組' })).toBeVisible()
    }
    await table.getByRole('button', { name: '複製本組信箱：G01' }).click()
    await expect(table.getByRole('status').filter({ hasText: '已複製 3 個信箱' })).toBeVisible()
    const member = table.getByRole('article', { name: 'G01', exact: true }).getByRole('list', { name: '組員' }).getByRole('link').first()
    const href = await member.getAttribute('href')
    expect(href).toMatch(/^\/dashboard\/admin\/accounts\?q=\d+$/)
    await member.click()
    await expect(page).toHaveURL(`${BASE_URL}${href}`)
  })
})
