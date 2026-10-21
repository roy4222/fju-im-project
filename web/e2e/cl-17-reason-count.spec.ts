import { expect, request as playwrightRequest, test, type Locator, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, sharedTestSession, toPlaywrightCookie, type TestSession } from './session'

/**
 * CL-17（#843）：分組與產學的「理由」欄拿掉原生 `maxLength`（按 UTF-16 算，emoji 算 2），改掛計數元件 `CharCount`，
 * 字數照「字」算（跟伺服器的 `charLength` 一樣），上限 200 字、錯誤句不變。三種代表：
 *
 * 1. 系辦刪除組別（受控欄位、`<form action>`）：201 個 emoji 送到伺服器被擋 → 看到伺服器那句、返回修改字還在；200 個刪得掉。
 * 2. 系辦解除合作案（不受控欄位、`<form action>`）：201 個 emoji 前端先擋（表單不重設）→ 字還在、同一句；200 個解除得了。
 * 3. 老師婉拒（不受控欄位、`<form action>`）：同 2。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()
const CODE = `CL17-${stamp}`
const COMPANY = `計數元件${stamp}`
const OVER = '😀'.repeat(201)
const LIMIT = '😀'.repeat(200)

let pool: Pool
let cohortId: string
let adminId: string
let teacher: TestSession
const groupIds = new Map<string, string>()
let seq = 0

async function insertStudent(): Promise<string> {
  seq += 1
  const user = await pool.query<{ id: string }>(
    `insert into users (id, name, email, email_verified, updated_at, status)
     values (gen_random_uuid(), $1, $2, true, now(), 'active') returning id`,
    [`計數${seq}號`, `cl17-${stamp.toLowerCase()}-${seq}@example.com`],
  )
  const id = user.rows[0]!.id
  const studentNo = `417${String(Date.now()).slice(-5)}${seq}`
  await pool.query(
    `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at)
     values (gen_random_uuid(), $1, 'student', $2, now())`,
    [id, adminId],
  )
  await pool.query(
    `insert into user_profiles (user_id, display_name, name_normalized, student_no, cohort_id, phone, contact_email)
     values ($1, $2, $2, $3, $4, '0912000000', $5)`,
    [id, `計數${seq}號`, studentNo, cohortId, `cl17-${seq}@contact.example.com`],
  )
  await pool.query(`insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)`, [cohortId, studentNo, id])
  return id
}

async function insertGroup(code: string, type: 'general' | 'industry') {
  const members = [await insertStudent(), await insertStudent()]
  const at = new Date(Date.now() - 86_400_000)
  const id = (await pool.query<{ id: string }>(
    `insert into groups (id, cohort_id, code, group_type, status, established_real_at, established_business_at,
                         created_at, created_by_kind, created_by_user_id, updated_at, updated_by_user_id)
     values (gen_random_uuid(), $1, $2, $3, 'active', $5, $5, $5, 'user', $4, $5, $4) returning id`,
    [cohortId, code, type, members[0], at],
  )).rows[0]!.id
  await pool.query(
    `insert into group_memberships (id, group_id, cohort_id, user_id, valid_from, added_by_kind, added_by_user_id, created_at, updated_at)
     select gen_random_uuid(), $1, $2, u, $4, 'user', $3, $4, $4 from unnest($5::uuid[]) as u`,
    [id, cohortId, members[0], at, members],
  )
  await pool.query(
    `insert into group_leaders (id, group_id, user_id, valid_from, changed_by_user_id, created_at)
     values (gen_random_uuid(), $1, $2, $3, $2, $3)`,
    [id, members[0], at],
  )
  groupIds.set(code, id)
  return { id, leader: members[0]! }
}

test.beforeAll(async () => {
  test.setTimeout(240_000)
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備與核對資料')
  pool = new Pool({ connectionString: ownerUrl, max: 2 })

  const adminContext = await playwrightRequest.newContext({ baseURL: BASE_URL })
  adminId = (await sharedTestSession(adminContext, 'admin')).userId
  await adminContext.dispose()
  const teacherContext = await playwrightRequest.newContext({ baseURL: BASE_URL })
  teacher = await createTestSession(teacherContext, 'teacher')
  await teacherContext.dispose()

  cohortId = (await pool.query<{ id: string }>(
    `insert into cohorts (id, code, name, status, year_end_date, is_default_working, created_by_kind)
     values (gen_random_uuid(), $1, $1, 'active', '2099-06-30', false, 'system') returning id`,
    [CODE],
  )).rows[0]!.id

  await insertGroup('G01', 'general')
  const g02 = await insertGroup('G02', 'industry')
  const g03 = await insertGroup('G03', 'industry')
  const opportunityId = (await pool.query<{ id: string }>(
    `insert into industry_opportunities
       (id, owner_teacher_user_id, company_name, department, content, requirements, status, published_business_at, created_by_kind, created_by_user_id)
     values (gen_random_uuid(), $1, $2, '資訊部', 'CL-17 測試', '', 'published', now(), 'user', $1) returning id`,
    [teacher.userId, COMPANY],
  )).rows[0]!.id
  await pool.query(
    `insert into opportunity_links (id, group_id, opportunity_id, state, valid_from, linked_by_user_id, created_at)
     values (gen_random_uuid(), $1, $3, 'active', now(), $4, now()), (gen_random_uuid(), $2, $3, 'pending', now(), $5, now())`,
    [g02.id, g03.id, opportunityId, adminId, g03.leader],
  )
})

test.afterAll(async () => {
  await pool?.end()
})

async function signIn(page: Page, session: TestSession) {
  await page.context().clearCookies()
  await page.context().addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
}

/** 欄位沒有原生 `maxLength`，`aria-describedby` 指到「n／200 字」。 */
async function countOf(field: Locator): Promise<Locator> {
  await expect(field).not.toHaveAttribute('maxlength')
  const ids = ((await field.getAttribute('aria-describedby')) ?? '').split(' ')
  const countId = ids.find((id) => id.endsWith('-count'))
  expect(countId, '理由欄的 aria-describedby 要指到字數').toBeTruthy()
  return field.page().locator(`[id="${countId}"]`)
}

async function endReason(groupId: string): Promise<string | null> {
  const rows = await pool.query<{ end_reason: string | null }>(
    `select end_reason from opportunity_links where group_id = $1 and valid_to is not null`,
    [groupId],
  )
  return rows.rows[0]?.end_reason ?? null
}

test('系辦刪除組別（受控欄位）：201 個 emoji 被伺服器擋、看到同一句、返回修改字還在；200 個刪得掉', async ({ page }) => {
  await signIn(page, await sharedTestSession(page.request, 'admin'))
  await page.goto(`/dashboard/admin/groups?cohort=${cohortId}`)
  const card = page.getByRole('article', { name: 'G01', exact: true })
  await card.locator('summary').click()
  await card.getByRole('button', { name: '刪除 G01', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '刪除 G01？' })
  const reason = dialog.getByLabel('理由（可不填）')
  const count = await countOf(reason)

  await reason.fill(OVER)
  await expect(reason).toHaveValue(OVER)
  await expect(count).toHaveText('201／200 字（超過 1 字）')
  await dialog.getByRole('button', { name: '下一步' }).click()
  await dialog.getByRole('button', { name: '確定刪除' }).click()
  await expect(dialog.getByRole('alert')).toHaveText('解散組別的理由最多 200 個字。')
  await dialog.getByRole('button', { name: '返回修改' }).click()
  await expect(reason).toHaveValue(OVER)

  await reason.fill(LIMIT)
  await expect(count).toHaveText('200／200 字')
  await dialog.getByRole('button', { name: '下一步' }).click()
  await dialog.getByRole('button', { name: '確定刪除' }).click()
  await expect(page.getByRole('status').filter({ hasText: '已刪除' })).toContainText('已刪除 G01')
  const stored = await pool.query<{ dissolve_reason: string }>(`select dissolve_reason from groups where id = $1`, [groupIds.get('G01')])
  expect(stored.rows[0]!.dissolve_reason).toBe(LIMIT)
})

test('系辦解除合作案（不受控欄位）：201 個 emoji 前端先擋、字還在、同一句；200 個解除得了', async ({ page }) => {
  await signIn(page, await sharedTestSession(page.request, 'admin'))
  await page.goto(`/dashboard/admin/groups/${groupIds.get('G02')}`)
  await page.getByRole('button', { name: '解除合作案', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '解除 G02 的合作案' })
  const reason = dialog.getByLabel('理由（可不填）')
  const count = await countOf(reason)

  await reason.fill(OVER)
  await expect(count).toHaveText('201／200 字（超過 1 字）')
  await dialog.getByRole('button', { name: '確定解除' }).click()
  await expect(dialog.getByRole('alert')).toHaveText('解除連結的理由最多 200 個字。')
  await expect(reason).toHaveValue(OVER)
  expect(await endReason(groupIds.get('G02')!)).toBeNull()

  await reason.fill(LIMIT)
  await expect(count).toHaveText('200／200 字')
  await dialog.getByRole('button', { name: '確定解除' }).click()
  await expect(page.getByRole('status')).toContainText('已解除 G02')
  expect(await endReason(groupIds.get('G02')!)).toBe(LIMIT)
})

test('老師婉拒（不受控欄位）：201 個 emoji 前端先擋、字還在、同一句；200 個婉拒得了', async ({ page }) => {
  await signIn(page, teacher)
  await page.goto('/dashboard/teacher/groups?tab=industry')
  const row = page.getByTestId('managed-opportunity').filter({ hasText: COMPANY })
  await row.getByRole('region', { name: '待確認要帶的組' }).getByRole('button', { name: '婉拒：G03' }).click()
  const dialog = page.getByRole('dialog', { name: '婉拒 G03？' })
  const reason = dialog.getByLabel('理由（可不填）')
  const count = await countOf(reason)

  await reason.fill(OVER)
  await expect(count).toHaveText('201／200 字（超過 1 字）')
  await dialog.getByRole('button', { name: '確定婉拒' }).click()
  await expect(dialog.getByRole('alert')).toHaveText('婉拒的理由最多 200 個字。')
  await expect(reason).toHaveValue(OVER)
  expect(await endReason(groupIds.get('G03')!)).toBeNull()

  await reason.fill(LIMIT)
  await expect(count).toHaveText('200／200 字')
  await dialog.getByRole('button', { name: '確定婉拒' }).click()
  await expect(dialog.getByRole('status')).toContainText('已婉拒 G03')
  expect(await endReason(groupIds.get('G03')!)).toBe(LIMIT)
})
