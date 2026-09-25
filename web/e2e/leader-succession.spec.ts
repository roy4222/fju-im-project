import { expect, request as playwrightRequest, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { sharedTestSession, toPlaywrightCookie } from './session'

/**
 * 票 42（#324）：組長帳號被停用時，要在同一個停用對話框指定接任的組長（產品模組 03「組長」；GRP-18）。
 *
 * 1. 停用對話框認得出他是組長，列出這組其他有效成員讓系辦選；沒選不能送出。
 * 2. 選了接任再停用：回執說明誰接任；分組總覽重新整理後組長已經換人，異動歷程看得到「帳號停用」的理由。
 * 3. 這組沒有其他可接任的有效成員時，對話框說明要先到分組總覽處理，按鈕不能按。
 * 伺服器端的拒絕（沒帶接任、接任已停用或不是組員、批次停用略過組長、同交易回滾）由整合測試
 * leader-succession.integration.test.ts 證明。
 *
 * 組別直接用 owner 連線建好（成組流程是票 13 的事）；停用全程走真的畫面，重新整理後再看。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()
const CODE = `T42-${stamp}`

type Member = { userId: string; name: string; studentNo: string }

let pool: Pool
let cohortId: string
let adminId: string
/** G01：三人，組長 g1[0]。G02：兩人，組長 g2[0]，另一位 g2[1] 已停用（沒有人可以接任）。 */
const g1: Member[] = []
const g2: Member[] = []

function ymd(date: Date): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}

async function insertStudent(index: number, status = 'active'): Promise<Member> {
  const studentNo = `442${String(Date.now()).slice(-5)}${index}`
  const name = `接任${stamp}-${index}`
  const user = await pool.query<{ id: string }>(
    `insert into users (id, name, email, email_verified, updated_at, status)
     values (gen_random_uuid(), $1, $2, true, now(), $3) returning id`,
    [name, `t42-${stamp.toLowerCase()}-${index}@example.com`, status],
  )
  const id = user.rows[0]!.id
  await pool.query(
    `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at)
     values (gen_random_uuid(), $1, 'student', $2, now())`,
    [id, adminId],
  )
  await pool.query(
    `insert into user_profiles (user_id, display_name, name_normalized, student_no, cohort_id, phone, contact_email)
     values ($1, $2, $2, $3, $4, '0912000000', $5)`,
    [id, name, studentNo, cohortId, `t42-${index}@contact.example.com`],
  )
  if (status === 'active') {
    await pool.query(`insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)`, [cohortId, studentNo, id])
  }
  return { userId: id, name, studentNo }
}

async function insertGroup(code: string, members: Member[]): Promise<string> {
  const at = new Date(Date.now() - 86_400_000)
  const group = await pool.query<{ id: string }>(
    `insert into groups (id, cohort_id, code, group_type, status, established_real_at, established_business_at,
                         created_at, created_by_kind, created_by_user_id, updated_at, updated_by_user_id)
     values (gen_random_uuid(), $1, $2, 'general', 'active', $4, $4, $4, 'user', $3, $4, $3) returning id`,
    [cohortId, code, members[0]!.userId, at],
  )
  const groupId = group.rows[0]!.id
  await pool.query(
    `insert into group_memberships (id, group_id, cohort_id, user_id, valid_from, added_by_kind, added_by_user_id, created_at, updated_at)
     select gen_random_uuid(), $1, $2, u, $5, 'user', $3, $5, $5 from unnest($4::uuid[]) as u`,
    [groupId, cohortId, members[0]!.userId, members.map((m) => m.userId), at],
  )
  await pool.query(
    `insert into group_leaders (id, group_id, user_id, valid_from, changed_by_user_id, created_at)
     values (gen_random_uuid(), $1, $2, $3, $2, $3)`,
    [groupId, members[0]!.userId, at],
  )
  return groupId
}

test.beforeAll(async () => {
  test.setTimeout(240_000)
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備與核對資料')
  pool = new Pool({ connectionString: ownerUrl, max: 2 })

  const context = await playwrightRequest.newContext({ baseURL: BASE_URL })
  adminId = (await sharedTestSession(context, 'admin')).userId
  await context.dispose()

  const now = new Date()
  const cohort = await pool.query<{ id: string }>(
    `insert into cohorts (id, code, name, status, year_end_date, group_size_min, group_size_max, created_by_kind)
     values (gen_random_uuid(), $1, $2, 'active', $3, 2, 5, 'system') returning id`,
    [CODE, `${CODE} 組長接任測試`, ymd(new Date(now.getTime() + 300 * 86_400_000))],
  )
  cohortId = cohort.rows[0]!.id
  for (const [i, start] of [-10, 30, 90, 150].map((d) => ymd(new Date(now.getTime() + d * 86_400_000))).entries()) {
    await pool.query(
      `insert into cohort_stages (id, cohort_id, seq, name, start_date, created_by_kind)
       values (gen_random_uuid(), $1, $2, $3, $4, 'system')`,
      [cohortId, i + 1, ['成組期', '期中', '期末', '成果'][i], start],
    )
  }

  for (let i = 1; i <= 3; i += 1) g1.push(await insertStudent(i))
  g2.push(await insertStudent(4), await insertStudent(5, 'disabled'))
  await insertGroup('G01', g1)
  await insertGroup('G02', g2)
})

test.afterAll(async () => {
  await pool?.end()
})

async function adminPage(page: Page) {
  await page.context().clearCookies()
  await page.context().addCookies([toPlaywrightCookie((await sharedTestSession(page.request, 'admin')).cookie, BASE_URL)])
}

async function openDisableDialog(page: Page, member: Member) {
  await page.goto(`/dashboard/admin/accounts?q=${encodeURIComponent(member.name)}`)
  const table = page.getByRole('table', { name: '帳號列表' })
  await expect(table).toBeVisible()
  await table.getByRole('row').filter({ has: page.getByText(member.name, { exact: true }) }).getByRole('button', { name: `停用 ${member.name}` }).click()
  return page.getByRole('dialog', { name: `停用 ${member.name}` })
}

async function currentLeader(code: string): Promise<string> {
  const rows = await pool.query<{ user_id: string }>(
    `select l.user_id from group_leaders l join groups g on g.id = l.group_id
      where g.cohort_id = $1 and g.code = $2 and l.valid_to is null`,
    [cohortId, code],
  )
  expect(rows.rows).toHaveLength(1)
  return rows.rows[0]!.user_id
}

test('停用組長：對話框要求指定接任；選了之後停用與換組長一起完成，分組總覽看得到新組長與理由', async ({ page }) => {
  await adminPage(page)
  const [leader, b, c] = g1 as [Member, Member, Member]
  const dialog = await openDisableDialog(page, leader)

  const successor = dialog.getByLabel(/接任 G01 組長/)
  await expect(successor).toBeVisible()
  await expect(successor.locator('option')).toHaveText(['請選一位留在組裡的成員', `${b.name}（${b.studentNo}）`, `${c.name}（${c.studentNo}）`])

  await dialog.getByLabel(/理由/).fill('休學')
  await dialog.getByRole('button', { name: '確認停用' }).click()
  await expect(dialog.getByRole('alert')).toContainText('請選接任 G01 組長的同學')
  expect(await currentLeader('G01')).toBe(leader.userId)

  await successor.selectOption({ label: `${b.name}（${b.studentNo}）` })
  await dialog.getByRole('button', { name: '確認停用' }).click()
  const receipt = dialog.getByRole('status')
  await expect(receipt).toContainText('已停用')
  await expect(receipt).toContainText(`G01 的組長已改由 ${b.name} 接任，全組已收到通知。`)
  await dialog.getByRole('button', { name: '關閉' }).click()

  expect(await currentLeader('G01')).toBe(b.userId)
  const status = await pool.query<{ status: string }>('select status from users where id = $1', [leader.userId])
  expect(status.rows[0]!.status).toBe('disabled')

  await page.goto(`/dashboard/admin/groups?cohort=${cohortId}`)
  await expect(page.getByRole('heading', { name: '分組總覽', exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: '全部組別' })).toContainText(`${b.name}（組長）`)
  await page.getByRole('region', { name: '全部組別' }).getByRole('button', { name: 'G01 詳情' }).click()
  const history = page.getByRole('dialog', { name: 'G01 詳情' }).getByRole('region', { name: '異動歷程' })
  await expect(history).toContainText(`組長 ${leader.name} → ${b.name}`)
  await expect(history).toContainText('理由：帳號停用：休學')
})

test('這組沒有其他可接任的有效成員：說明要先到分組總覽處理，停用按鈕不能按', async ({ page }) => {
  await adminPage(page)
  const dialog = await openDisableDialog(page, g2[0]!)
  await expect(dialog.getByRole('alert')).toContainText('他是 G02 的組長，但這組沒有其他可以接任的成員')
  await expect(dialog.getByRole('button', { name: '確認停用' })).toBeDisabled()
  expect(await currentLeader('G02')).toBe(g2[0]!.userId)
})
