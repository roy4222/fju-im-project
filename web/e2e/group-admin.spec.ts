import { expect, request as playwrightRequest, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, sharedTestSession, toPlaywrightCookie, type TestSession } from './session'

/**
 * 票 14（#225）：每組人數設定、管理員調整組員與換組長。「做完的樣子」逐條走：
 *
 * 1. 每組人數由管理員設定、學生提案照設定擋——票 13 的 groups.spec「分組設定」與整合測試已證明；
 *    這裡看管理員端：人數和設定不符時顯示「與設定不符」提醒，但允許。
 * 2. 管理員把未分組學生加入某組（理由必填）；把組長移出時要先指定接任。
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
  await page.getByRole('region', { name: '全部組別' }).getByRole('button', { name: 'G01 詳情' }).click()
  return page.getByRole('dialog', { name: 'G01 詳情' })
}

async function eventCount(type: string): Promise<number> {
  const rows = await pool.query<{ n: number }>(
    `select count(*)::int as n from domain_events where type = $1 and source_id = $2`,
    [type, groupId],
  )
  return rows.rows[0]!.n
}

test('加入某組：預覽提醒人數會和設定不符、理由必填；加入後允許並標「與設定不符」，全組收到成員異動', async ({ page }) => {
  await openAdminPage(page)
  const ungrouped = page.getByRole('region', { name: '未分組學生' })
  await ungrouped.getByRole('button', { name: `加入某組：${newcomer.name}` }).click()
  const dialog = page.getByRole('dialog', { name: `把 ${newcomer.name} 加入組別` })
  await expect(dialog.getByLabel('組別')).toContainText('G01・目前 5 人')
  await expect(dialog).toContainText('人數與設定不符：6 人，超過本屆每組最多 5 人')

  await dialog.getByRole('button', { name: '確認加入' }).click()
  await expect(dialog.getByRole('alert')).toContainText('加入組員一定要填理由')

  await dialog.getByLabel('理由（必填）').fill('轉學生，系上安排加入')
  await dialog.getByRole('button', { name: '確認加入' }).click()
  await expect(page.getByRole('main').getByRole('status').filter({ hasText: '已把' })).toContainText(
    `已把 ${newcomer.name} 加入 G01；現在 6 人（人數與設定不符：6 人，超過本屆每組最多 5 人）`,
  )

  await page.reload()
  const groups = page.getByRole('region', { name: '全部組別' })
  await expect(groups).toContainText('6 人（與設定不符）')
  await expect(groups).toContainText(newcomer.name)
  await expect(page.getByRole('region', { name: '未分組學生' })).not.toContainText(newcomer.name)
  expect(await eventCount('group.members_changed')).toBe(1)
})

test('移出組長：沒指定接任被拒；指定接任後移出，詳情看得到新名單、理由與歷程', async ({ page }) => {
  await openAdminPage(page)
  const detail = await openDetail(page)
  await detail.getByRole('button', { name: `移出：${members[0]!.name}` }).click()
  const dialog = page.getByRole('dialog', { name: `把 ${members[0]!.name} 移出 G01？` })
  await dialog.getByLabel('理由（必填）').fill('轉系')
  await dialog.getByRole('button', { name: '確定移出' }).click()
  await expect(dialog.getByRole('alert')).toContainText('要移出的是組長：請同時指定接任的組長')

  await dialog.getByLabel(/接任組長/).selectOption({ label: members[2]!.name })
  await dialog.getByRole('button', { name: '確定移出' }).click()
  await expect(detail.getByRole('status')).toContainText(`已把 ${members[0]!.name} 移出 G01，組長改由 ${members[2]!.name} 接任；現在 5 人`)
  await expect(detail.getByRole('list', { name: '成員名單' })).not.toContainText(members[0]!.name)
  const history = detail.getByRole('region', { name: '異動歷程' })
  await expect(history).toContainText(`${members[0]!.name} 移出`)
  await expect(history).toContainText(`組長 ${members[0]!.name} → ${members[2]!.name}`)
  await expect(history).toContainText('理由：轉系')

  await page.reload()
  await expect(page.getByRole('region', { name: '全部組別' })).toContainText(`${members[2]!.name}（組長）`)
  await expect(page.getByRole('region', { name: '未分組學生' })).toContainText(members[0]!.name)
  expect(await eventCount('group.member_removed')).toBe(1)
})

test('換組長：填理由換給另一位成員；只換組長不發成員異動事件（不重簽）；重新整理後歷程還在', async ({ page }) => {
  const membersChangedBefore = await eventCount('group.members_changed')
  await openAdminPage(page)
  const detail = await openDetail(page)
  await detail.getByRole('button', { name: '換組長' }).click()
  const dialog = page.getByRole('dialog', { name: '換 G01 的組長' })
  await expect(dialog).toContainText(`目前組長：${members[2]!.name}`)
  await dialog.getByLabel('新組長').selectOption({ label: members[1]!.name })
  await dialog.getByLabel('理由（必填）').fill('原組長請辭，全組同意')
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
  await expect(page.getByRole('region', { name: '全部組別' })).toContainText(`${members[1]!.name}（組長）`)
  const history = (await openDetail(page)).getByRole('region', { name: '異動歷程' })
  await expect(history).toContainText(`組長 ${members[2]!.name} → ${members[1]!.name}`)
  await expect(history).toContainText('理由：原組長請辭，全組同意')
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

  test('AC-AD-10：標題「分組」＋分頁列；分組設定在分頁列右側；組隊中與最近終止是卡片、全部組別仍是表格', async ({ page }) => {
    await openAd05(page)
    await expect(page).toHaveTitle('分組｜資管系專題平台')
    const tabs = page.getByRole('navigation', { name: '分組分頁' })
    await expect(tabs.getByRole('link')).toHaveText(['分組總覽', '合作案'])
    await expect(tabs.getByRole('link', { name: '分組總覽' })).toHaveAttribute('aria-current', 'page')
    await expect(tabs.getByRole('link', { name: '合作案' })).not.toHaveAttribute('aria-current', 'page')

    // 「分組設定」跟分頁列同一列（右側），不在標題那一列：按鈕在 h1 下面、跟分頁連結同一條水平帶。
    const settings = page.getByRole('button', { name: '分組設定' })
    const h1 = (await page.getByRole('heading', { name: '分組', exact: true, level: 1 }).boundingBox())!
    const tab = (await tabs.getByRole('link', { name: '分組總覽' }).boundingBox())!
    const button = (await settings.boundingBox())!
    expect(button.y).toBeGreaterThanOrEqual(h1.y + h1.height)
    expect(button.x).toBeGreaterThan(tab.x + tab.width)
    expect(button.y + button.height).toBeGreaterThan(tab.y)
    expect(button.y).toBeLessThan(tab.y + tab.height)
    // 頁首說明句拿掉。
    await expect(page.getByRole('main')).not.toContainText('學生自行提案、全員確認後成組')

    const open = page.getByRole('region', { name: '組隊中（等全員確認）' })
    await expect(open.locator('table')).toHaveCount(0)
    await expect(open.getByRole('list', { name: '組隊中的提案' }).getByRole('listitem')).toHaveCount(2)
    await expect(open.getByRole('button', { name: /^作廢：/ })).toHaveCount(2)
    const closed = page.getByRole('region', { name: '最近終止的提案' })
    await expect(closed.locator('table')).toHaveCount(0)
    await expect(closed.getByRole('listitem')).toHaveCount(1)
    await expect(closed).toContainText('管理員作廢')
    await expect(closed).toContainText('AD-05 測試作廢')
    await expect(page.getByRole('region', { name: '全部組別' }).locator('table')).toHaveCount(1)
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

    await tabs.getByRole('link', { name: '合作案' }).click()
    await expect(page).toHaveURL(/\/dashboard\/admin\/industry$/)
  })

  test('AC-AD-12：一般組的列與詳情都沒有「連結合作案」；產學組的合作案欄留著位置', async ({ page }) => {
    await openAd05(page)
    const table = page.getByRole('region', { name: '全部組別' })
    await expect(table.getByRole('columnheader', { name: '合作案' })).toBeVisible()
    // 入口＝按鈕或連結（AD-06 的「連結合作案 G03」）。「改類型」對話框本來就有「也沒有連結合作案」這句說明，不算入口。
    const g01 = table.getByTestId('roster-row').and(page.locator('[data-code="G01"]'))
    await expect(g01.getByRole('button', { name: /連結合作案/ })).toHaveCount(0)
    await expect(g01.getByRole('link', { name: /連結合作案/ })).toHaveCount(0)
    await expect(g01.getByText('連結合作案', { exact: true })).toHaveCount(0)
    await expect(table.getByTestId('roster-row').and(page.locator('[data-code="G03"]'))).toContainText('尚未連結')
    await table.getByRole('button', { name: 'G01 詳情' }).click()
    const detail = page.getByRole('dialog', { name: 'G01 詳情' })
    await expect(detail).toBeVisible()
    await expect(detail).not.toContainText('連結合作案')
    await expect(detail.getByRole('button', { name: /連結合作案/ })).toHaveCount(0)
  })

  test('AC-AD-14：只剩一人的組，詳情寫「只剩一人時不能再移出」，沒有移出按鈕', async ({ page }) => {
    await openAd05(page)
    await page.getByRole('region', { name: '全部組別' }).getByRole('button', { name: 'G05 詳情' }).click()
    const detail = page.getByRole('dialog', { name: 'G05 詳情' })
    await expect(detail).toContainText('只剩一人時不能再移出')
    await expect(detail).not.toContainText('之後才會開放')
    await expect(detail.getByRole('button', { name: /^移出：/ })).toHaveCount(0)
  })

  test('AC-AD-23：1280 寬不溢出，組別表沒有橫向捲軸，每列的操作按鈕完整可見、可點', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE_URL })
    await page.setViewportSize({ width: 1280, height: 800 })
    await openAd05(page)
    const page_ = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }))
    expect(page_.scroll).toBe(page_.client)

    const table = page.getByRole('region', { name: '全部組別' })
    await expect(table.getByTestId('roster-row')).toHaveCount(12)
    const frame = table.locator('table').locator('xpath=..')
    const box = await frame.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth, right: el.getBoundingClientRect().right }))
    expect(box.scroll).toBeLessThanOrEqual(box.client)
    for (const code of ['G01', 'G12']) {
      const copy = table.getByRole('button', { name: `複製本組信箱：${code}` })
      await copy.scrollIntoViewIfNeeded()
      const b = (await copy.boundingBox())!
      expect(b.x + b.width).toBeLessThanOrEqual(box.right)
      await expect(table.getByRole('button', { name: `${code} 詳情` })).toBeVisible()
    }
    await table.getByRole('button', { name: '複製本組信箱：G01' }).click()
    await expect(table.getByRole('status').filter({ hasText: '已複製 3 個信箱' })).toBeVisible()
  })
})
