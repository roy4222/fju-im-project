import { expect, request as playwrightRequest, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, sharedTestSession, toPlaywrightCookie, type TestSession } from './session'

/**
 * C3-15（#667）：系辦「未分組學生」分頁（設計方案③ §6.3；AC-C3-19）。
 *
 * 未分組：N（可加入，技能 4 個→顯示 3 個＋「+1」）、P（公開找隊員、技能「前端」「AI」、系級）、
 * E 發起、Q 受邀的一份建立中組別。E 有真的登入狀態，終止後看自己的紀錄。
 * 驗收案例寫「3 人未分組」是只數 N、P、Q；E 自己也未分組，所以畫面是 4 人（數字規則見 `unassigned.test.ts`）。
 * 另有已成立的 G01（2 人），最後把 N 加入 G01（理由留空），走既有的 `addMemberAction`。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()
const CODE = `U15-${stamp}`

type Student = { id: string; name: string; studentNo: string }

let pool: Pool
let cohortId: string
let adminId: string
let proposalId: string
let expiresMd: string
let eSession: TestSession
let n: Student, p: Student, e: Student, q: Student

function ymd(date: Date): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}

async function insertStudent(
  userId: string | null,
  index: number,
  patch: { openToJoin?: boolean; skills?: string[]; departmentClass?: string } = {},
): Promise<Student> {
  const studentNo = `415${String(Date.now()).slice(-5)}${index}`
  const name = `未分組${index}號`
  let id = userId
  if (!id) {
    const user = await pool.query<{ id: string }>(
      `insert into users (id, name, email, email_verified, updated_at, status)
       values (gen_random_uuid(), $1, $2, true, now(), 'active') returning id`,
      [name, `u15-${stamp.toLowerCase()}-${index}@example.com`],
    )
    id = user.rows[0]!.id
    await pool.query(
      `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at)
       values (gen_random_uuid(), $1, 'student', $2, now())`,
      [id, adminId],
    )
  }
  await pool.query(
    `insert into user_profiles (user_id, display_name, name_normalized, student_no, cohort_id, phone, contact_email,
                                open_to_join, skills, department_class)
     values ($1, $2, $2, $3, $4, '0912000000', $5, $6, $7::jsonb, $8)
     on conflict (user_id) do update set display_name = excluded.display_name, student_no = excluded.student_no,
       cohort_id = excluded.cohort_id, open_to_join = excluded.open_to_join, skills = excluded.skills,
       department_class = excluded.department_class`,
    [
      id,
      name,
      studentNo,
      cohortId,
      `u15-${index}@contact.example.com`,
      patch.openToJoin ?? false,
      JSON.stringify(patch.skills ?? []),
      patch.departmentClass ?? null,
    ],
  )
  await pool.query(`insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)`, [cohortId, studentNo, id])
  return { id, name, studentNo }
}

test.beforeAll(async () => {
  test.setTimeout(240_000)
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備與核對資料')
  pool = new Pool({ connectionString: ownerUrl, max: 2 })

  const now = new Date()
  const adminContext = await playwrightRequest.newContext({ baseURL: BASE_URL })
  adminId = (await sharedTestSession(adminContext, 'admin')).userId
  await adminContext.dispose()
  await pool.query(
    `insert into business_clock_overrides (id, environment, business_at, real_at, set_by_user_id, reason)
     values (gen_random_uuid(), 'staging', now(), now(), $1, 'e2e C3-15：回到真實時間')`,
    [adminId],
  )
  const cohort = await pool.query<{ id: string }>(
    `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
     values (gen_random_uuid(), $1, $2, 'active', $3, 'system') returning id`,
    [CODE, `${CODE} 未分組測試`, ymd(new Date(now.getTime() + 300 * 86_400_000))],
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
  eSession = await createTestSession(context, 'student')
  await context.dispose()

  n = await insertStudent(null, 1, { skills: ['資料庫', '後端', '簡報', '設計'] })
  p = await insertStudent(null, 2, { openToJoin: true, skills: ['前端', 'AI'], departmentClass: '資管三甲' })
  e = await insertStudent(eSession.userId, 3)
  q = await insertStudent(null, 4)
  const grouped = [await insertStudent(null, 5), await insertStudent(null, 6)]

  // 已成立的 G01（2 人）：給「加入組別」選。
  const establishedAt = new Date(now.getTime() - 86_400_000)
  const group = await pool.query<{ id: string }>(
    `insert into groups (id, cohort_id, code, group_type, status, established_real_at, established_business_at,
                         created_at, created_by_kind, created_by_user_id, updated_at, updated_by_user_id)
     values (gen_random_uuid(), $1, 'G01', 'general', 'active', $3, $3, $3, 'user', $2, $3, $2) returning id`,
    [cohortId, grouped[0]!.id, establishedAt],
  )
  await pool.query(
    `insert into group_memberships (id, group_id, cohort_id, user_id, valid_from, added_by_kind, added_by_user_id, created_at, updated_at)
     select gen_random_uuid(), $1, $2, u, $5, 'user', $3, $5, $5 from unnest($4::uuid[]) as u`,
    [group.rows[0]!.id, cohortId, grouped[0]!.id, grouped.map((s) => s.id), establishedAt],
  )
  await pool.query(
    `insert into group_leaders (id, group_id, user_id, valid_from, changed_by_user_id, created_at)
     values (gen_random_uuid(), $1, $2, $3, $2, $3)`,
    [group.rows[0]!.id, grouped[0]!.id, establishedAt],
  )

  // E 發起、Q 受邀的建立中組別：兩人都被占住。
  const expires = new Date(now.getTime() + 5 * 86_400_000)
  const taipei = new Date(expires.getTime() + 8 * 3600_000)
  expiresMd = `${taipei.getUTCMonth() + 1}/${taipei.getUTCDate()}`
  const proposal = await pool.query<{ id: string }>(
    `insert into group_proposals (id, cohort_id, proposer_user_id, group_type, expires_business_at, state, created_real_at, created_business_at, updated_at)
     values (gen_random_uuid(), $1, $2, 'general', $3, 'open', now(), now(), now()) returning id`,
    [cohortId, e.id, expires],
  )
  proposalId = proposal.rows[0]!.id
  await pool.query(
    `insert into proposal_invitations (id, proposal_id, user_id, state, decided_real_at)
     values (gen_random_uuid(), $1, $2, 'confirmed', now()), (gen_random_uuid(), $1, $3, 'pending', null)`,
    [proposalId, e.id, q.id],
  )
  await pool.query(`insert into proposal_occupancy (user_id, proposal_id) values ($1, $3), ($2, $3)`, [e.id, q.id, proposalId])
})

test.afterAll(async () => {
  await pool?.end()
})

async function signIn(page: Page, session: TestSession) {
  await page.context().clearCookies()
  await page.context().addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
}

async function openUnassigned(page: Page) {
  await signIn(page, await sharedTestSession(page.request, 'admin'))
  await page.goto(`/dashboard/admin/groups/unassigned?cohort=${cohortId}`)
  return page.getByRole('region', { name: '未分組學生' })
}

const rowOf = (page: Page, s: Student) => page.getByRole('row').filter({ hasText: s.studentNo })

test('AC-C3-19：每列頭像、姓名連帳號、學號、系級、狀態、技能膠囊；三種狀態各自的動作', async ({ page }) => {
  const region = await openUnassigned(page)
  await expect(region.getByTestId('unassigned-summary')).toHaveText('4 人未分組・1 人公開找隊員・1 份建立中')

  // 頭像 32px、姓名連到「帳號」的那一列（A16）。
  const pRow = rowOf(page, p)
  const avatar = pRow.locator('img').first()
  await expect(avatar).toHaveAttribute('width', '32')
  await expect(avatar).toHaveAttribute('src', /^\/avatars\/\d{3}\.webp$/)
  await expect(pRow.getByRole('link', { name: p.name })).toHaveAttribute('href', `/dashboard/admin/accounts?q=${p.studentNo}`)
  await expect(pRow).toContainText('資管三甲')
  await expect(pRow).toContainText('公開找隊員')
  await expect(pRow.getByTestId('open-dot')).toBeVisible()
  await expect(pRow.getByRole('list', { name: `${p.name}的技能` }).getByRole('listitem')).toHaveText(['前端', 'AI'])
  await expect(pRow.getByRole('button', { name: `加入組別：${p.name}` })).toBeVisible()

  const nRow = rowOf(page, n)
  await expect(nRow).toContainText('可加入')
  await expect(nRow.getByTestId('open-dot')).toHaveCount(0)
  await expect(nRow.getByRole('list', { name: `${n.name}的技能` }).getByRole('listitem')).toHaveText(['資料庫', '後端', '簡報', '+1'])
  await expect(nRow.getByRole('button', { name: `加入組別：${n.name}` })).toBeVisible()

  for (const s of [q, e]) {
    const row = rowOf(page, s)
    await expect(row).toContainText(`建立中（發起人 ${e.name}，到期 ${expiresMd}）`)
    await expect(row.getByRole('button', { name: `終止建立：${e.name}` })).toBeVisible()
    await expect(row.getByRole('button', { name: /加入組別/ })).toHaveCount(0)
  }

  // 點 P 的姓名：到「帳號」並帶學號搜尋。
  await pRow.getByRole('link', { name: p.name }).click()
  await expect(page).toHaveURL(new RegExp(`/dashboard/admin/accounts\\?q=${p.studentNo}$`))
})

test('AC-C3-19：Q 列「終止建立：E」理由留空 → 成功；Q 與 E 變可加入；E 的紀錄寫「沒有成立：系辦終止」', async ({ page }) => {
  const region = await openUnassigned(page)
  await rowOf(page, q).getByRole('button', { name: `終止建立：${e.name}` }).click()
  const dialog = page.getByRole('dialog', { name: `終止 ${e.name} 建立中的組別？` })
  await expect(dialog.getByLabel('理由（可不填）')).toHaveValue('')
  await dialog.getByRole('button', { name: '確定終止' }).click()
  await expect(region.getByRole('status')).toHaveText(`已終止 ${e.name} 建立中的組別`)
  await expect(dialog).toBeHidden()

  for (const s of [q, e]) {
    await expect(rowOf(page, s)).toContainText('可加入')
    await expect(rowOf(page, s).getByRole('button', { name: `加入組別：${s.name}` })).toBeVisible()
  }
  await expect(region.getByTestId('unassigned-summary')).toHaveText('4 人未分組・1 人公開找隊員・0 份建立中')

  const stored = await pool.query<{ state: string; termination_kind: string; reason: string | null }>(
    'select state, termination_kind, reason from group_proposals where id = $1',
    [proposalId],
  )
  expect(stored.rows[0]).toMatchObject({ state: 'terminated', termination_kind: 'admin_voided' })
  expect(stored.rows[0]!.reason ?? '').toBe('')
  const occupancy = await pool.query('select 1 from proposal_occupancy where proposal_id = $1', [proposalId])
  expect(occupancy.rowCount).toBe(0)

  // E 自己的紀錄：只寫「系辦終止」，沒有理由。
  await signIn(page, eSession)
  await page.goto('/dashboard/student/groups?tab=log')
  const log = page.locator('section[aria-label="建立組別紀錄"]')
  await expect(log).toContainText('沒有成立：系辦終止')
  await expect(log).not.toContainText('理由')
})

test('AC-C3-19：「加入組別」理由可不填、沒有「先到組隊中作廢」的提示；N 加入 G01 後從名單消失', async ({ page }) => {
  const region = await openUnassigned(page)
  await rowOf(page, n).getByRole('button', { name: `加入組別：${n.name}` }).click()
  const dialog = page.getByRole('dialog', { name: `把 ${n.name} 加入組別` })
  await expect(dialog.getByLabel('組別')).toContainText('G01・目前 2 人')
  await expect(dialog.getByLabel('理由（可不填）')).toHaveValue('')
  await expect(page.getByRole('main')).not.toContainText('作廢那份提案')
  await dialog.getByRole('button', { name: '確認加入' }).click()
  await expect(region.getByRole('status')).toContainText(`已把 ${n.name} 加入 G01`)
  await expect(rowOf(page, n)).toHaveCount(0)
  await expect(region.getByTestId('unassigned-summary')).toHaveText('3 人未分組・1 人公開找隊員・0 份建立中')

  const member = await pool.query(
    `select 1 from group_memberships m join groups g on g.id = m.group_id
      where m.user_id = $1 and g.cohort_id = $2 and g.code = 'G01' and m.valid_to is null`,
    [n.id, cohortId],
  )
  expect(member.rowCount).toBe(1)
})
