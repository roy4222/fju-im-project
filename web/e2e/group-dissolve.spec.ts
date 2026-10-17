import { expect, request as playwrightRequest, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, sharedTestSession, toPlaywrightCookie, type TestSession } from './session'

/**
 * 開站後：系辦解散組別（最小版）。走真的畫面：
 *
 * 1. 分組總覽 → 組別詳情 → 「解散組別」：沒填理由不能下一步；下一步看後果、按「確定解散」才送出（二次確認）。
 * 2. 解散後這組離開「全部組別」、出現在「已解散的組別」（回執、時間、理由、解散時成員）；組員回到「未分組學生」。
 * 3. 資料庫：組別 dissolved、組員資格與組長列結束、一則 group.dissolved 通知給兩位組員。
 * 4. 學生的「我的組別」不再有這組。
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

function ymd(date: Date): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
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

test('系辦解散：理由必填、二次確認；解散後改列在「已解散的組別」，組員回到未分組並收到通知', async ({ page }) => {
  await signIn(page, await sharedTestSession(page.request, 'admin'))
  await page.goto(`/dashboard/admin/groups?cohort=${cohortId}`)
  await expect(page.getByRole('heading', { name: '分組總覽', exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: '已解散的組別' })).toHaveCount(0)

  await page.getByRole('region', { name: '全部組別' }).getByRole('button', { name: 'G01 詳情' }).click()
  const detail = page.getByRole('dialog', { name: 'G01 詳情' })
  await detail.getByRole('button', { name: '解散組別' }).click()
  const dialog = page.getByRole('dialog', { name: '解散 G01？' })
  await expect(dialog).toContainText(`${members[0]!.name}、${members[1]!.name}`)
  const next = dialog.getByRole('button', { name: '下一步' })
  await expect(next).toBeDisabled()
  await dialog.getByLabel('理由（必填）').fill('全組僅剩兩人且都休學')
  await next.click()

  // 第二步：看後果、確定才送出。返回修改還看得到剛填的理由。
  await expect(dialog.getByRole('heading', { name: '確定解散 G01？' })).toBeVisible()
  await expect(dialog).toContainText('解散後不能復原')
  await dialog.getByRole('button', { name: '返回修改' }).click()
  await expect(dialog.getByLabel('理由（必填）')).toHaveValue('全組僅剩兩人且都休學')
  await dialog.getByRole('button', { name: '下一步' }).click()
  await dialog.getByRole('button', { name: '確定解散' }).click()

  const dissolved = page.getByRole('region', { name: '已解散的組別' })
  await expect(dissolved.getByRole('status')).toContainText('已解散 G01：2 人回到未分組')
  await expect(dissolved).toContainText('全組僅剩兩人且都休學')
  await expect(dissolved).toContainText(`${members[0]!.name}（組長）`)
  await expect(page.getByRole('region', { name: '全部組別' }).getByRole('button', { name: 'G01 詳情' })).toHaveCount(0)
  const ungrouped = page.getByRole('region', { name: '未分組學生' })
  await expect(ungrouped).toContainText(members[0]!.name)
  await expect(ungrouped).toContainText(members[1]!.name)

  // 重新整理後還在（存進資料庫），回執那一句只在剛解散時出現。
  await page.goto(`/dashboard/admin/groups?cohort=${cohortId}`)
  await expect(page.getByRole('region', { name: '已解散的組別' })).toContainText('G01')
  await expect(page.getByRole('region', { name: '已解散的組別' }).getByRole('status')).toHaveCount(0)

  const head = await pool.query<{ status: string; reason: string }>(`select status, dissolve_reason as reason from groups where id = $1`, [groupId])
  expect(head.rows[0]).toEqual({ status: 'dissolved', reason: '全組僅剩兩人且都休學' })
  const open = await pool.query<{ n: number }>(
    `select (select count(*) from group_memberships where group_id = $1 and valid_to is null)::int
          + (select count(*) from group_leaders where group_id = $1 and valid_to is null)::int as n`,
    [groupId],
  )
  expect(open.rows[0]!.n).toBe(0)
  const events = await pool.query<{ n: number }>(
    `select cardinality(recipients)::int as n from domain_events where type = 'group.dissolved' and source_id = $1`,
    [groupId],
  )
  expect(events.rows.map((r) => r.n)).toEqual([2])
})

test('學生的「我的組別」不再有解散的組', async ({ page }) => {
  await signIn(page, viewer)
  await page.goto('/dashboard/student/groups')
  await expect(page.getByRole('region', { name: '我的組別狀態' })).toBeVisible()
  await expect(page.getByRole('region', { name: '我的組別狀態' })).not.toContainText('組別 G01')
})
