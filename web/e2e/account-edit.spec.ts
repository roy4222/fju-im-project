import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { Pool } from 'pg'
import { createTestSession, sharedTestSession, toPlaywrightCookie, type TestSession } from './session'

/**
 * C2-08：帳號列「編輯」（調屆、學生↔老師互轉、學號占用），用真的畫面走一次（AC-C2-21、22、23）。
 *
 * - AC-C2-21：(a) 改姓名、學號、屆別；(b) 學生改老師：學號屆別欄消失、舊 session 下一個請求轉登入頁、重登落在老師後台；
 *   (c) 老師改學生：重登落在學生後台。
 * - AC-C2-22：(a) 在組裡：屆別下拉 disabled、下面連到那一組；(a′) 改老師時「儲存」disabled、`title` 與小字同一句；
 *   (c) 指導中＋評分指派；(d) 學生缺學號。(b)「有繳交紀錄」要真的作業與繳交，放在整合測試（`pg-profile-edit.integration.test.ts`）。
 * - AC-C2-23：學號占用 → alert，資料不變。
 *
 * 跑完把三段 SQL 查詢結果寫進 `E2E_EVIDENCE_DIR`（有設才寫）：C2-08-sql-1／2／3.json（附 PR 用）。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER
const PASSWORD = 'E2e-Password-Correct-9'

test.describe.configure({ mode: 'serial' })

const run = String(Date.now()).slice(-6)
const CODE_A = `A${run}`
const CODE_B = `B${run}`
const name = (who: string) => `${who}編${run}`

let seeder: APIRequestContext
let cohortA = ''
let cohortB = ''

async function db<T>(fn: (pool: Pool) => Promise<T>): Promise<T> {
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER')
  const pool = new Pool({ connectionString: ownerUrl, max: 1 })
  try {
    return await fn(pool)
  } finally {
    await pool.end()
  }
}

const sql = <T = Record<string, unknown>>(text: string, params: unknown[] = []) => db(async (pool) => (await pool.query(text, params)).rows as T[])

test.beforeAll(async ({ playwright }) => {
  seeder = await playwright.request.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { origin: new URL(BASE_URL).origin } })
  const ymd = new Date(Date.now() + 300 * 86_400_000).toISOString().slice(0, 10)
  for (const code of [CODE_A, CODE_B]) {
    await sql(
      `insert into cohorts (id, code, name, status, year_end_date, created_by_kind) values (gen_random_uuid(), $1, $1, 'preparing', $2, 'system')`,
      [code, ymd],
    )
  }
  cohortA = String((await sql<{ id: string }>(`select id from cohorts where code = $1`, [CODE_A]))[0]!.id)
  cohortB = String((await sql<{ id: string }>(`select id from cohorts where code = $1`, [CODE_B]))[0]!.id)
})

test.afterAll(async () => {
  await seeder?.dispose()
})

type Person = TestSession & { name: string }

/** 學生：真的註冊拿 session，再擺成「A 屆、有學號」的已核准學生。 */
async function student(who: string, studentNo: string, cohortId = cohortA): Promise<Person> {
  const s = await createTestSession(seeder, 'student')
  const n = name(who)
  await db(async (pool) => {
    await pool.query(`update users set name = $2 where id = $1`, [s.userId, n])
    await pool.query(
      `insert into user_profiles (user_id, display_name, name_normalized, student_no, cohort_id, contact_email, profile_completed_at)
       values ($1, $2, $2, $3, $4, $5, now())`,
      [s.userId, n, studentNo, cohortId, s.email],
    )
    await pool.query(`insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)`, [cohortId, studentNo, s.userId])
  })
  return { ...s, name: n }
}

async function teacher(who: string): Promise<Person> {
  const s = await createTestSession(seeder, 'teacher')
  const n = name(who)
  await db(async (pool) => {
    await pool.query(`update users set name = $2 where id = $1`, [s.userId, n])
    await pool.query(`update user_profiles set display_name = $2 where user_id = $1`, [s.userId, n])
  })
  return { ...s, name: n }
}

async function group(code: string, members: string[]): Promise<string> {
  const g = await sql<{ id: string }>(
    `insert into groups (id, cohort_id, code, group_type, established_real_at, established_business_at, created_by_kind)
     values (gen_random_uuid(), $1, $2, 'general', now(), now(), 'system') returning id`,
    [cohortA, code],
  )
  for (const m of members) {
    await sql(
      `insert into group_memberships (id, group_id, cohort_id, user_id, valid_from, added_by_kind) values (gen_random_uuid(), $1, $2, $3, now(), 'system')`,
      [g[0]!.id, cohortA, m],
    )
  }
  return g[0]!.id
}

async function adminPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext()
  const page = await context.newPage()
  const admin = await sharedTestSession(page.request, 'admin')
  await context.addCookies([toPlaywrightCookie(admin.cookie, BASE_URL)])
  return page
}

function rowOf(page: Page, who: string) {
  return page.getByRole('table', { name: '帳號列表' }).getByRole('row').filter({ has: page.getByText(who, { exact: true }) })
}

/** 用名字搜尋、打開那一列的「編輯」，等視窗讀完。 */
async function openEdit(page: Page, who: string) {
  await page.goto(`/dashboard/admin/accounts?q=${encodeURIComponent(who)}`)
  await rowOf(page, who).getByRole('button', { name: `編輯 ${who}` }).click()
  const dialog = page.getByRole('dialog', { name: `編輯帳號 ${who}` })
  await expect(dialog.getByLabel('姓名')).toBeVisible()
  return dialog
}

async function login(browser: Browser, email: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage()
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('密碼', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: '登入', exact: true }).click()
  await expect(page).not.toHaveURL(/\/login/)
  return page
}

const evidence: Record<string, unknown[]> = { 'C2-08-sql-1': [], 'C2-08-sql-2': [], 'C2-08-sql-3': [] }

async function collect(userId: string) {
  evidence['C2-08-sql-1']!.push(
    ...(await sql(`select user_id, display_name, student_no, cohort_id from user_profiles where user_id = $1`, [userId])),
  )
  evidence['C2-08-sql-2']!.push({
    userId,
    studentIdentities: await sql(`select cohort_id, student_no from student_identities where user_id = $1`, [userId]),
    roleAssignments: await sql(
      `select role, granted_real_at, revoked_real_at from role_assignments where user_id = $1 order by granted_real_at, role`,
      [userId],
    ),
  })
  evidence['C2-08-sql-3']!.push(
    ...(await sql(`select action, target_id, payload, real_at from audit_events where action = 'account.profile_edit' and target_id = $1 order by real_at`, [userId])),
  )
}

test('AC-C2-21：改姓名學號屆別、學生改老師（舊 session 失效、重登進老師後台）、老師改學生（重登進學生後台）', async ({ browser }) => {
  const sx1 = await student('SX1', `4110${run}`)
  const t2 = await teacher('T2')
  const page = await adminPage(browser)

  // (a) 改姓名、學號、屆別 A→B。
  let dialog = await openEdit(page, sx1.name)
  const renamed = `${sx1.name}改`
  await dialog.getByLabel('姓名').fill(renamed)
  await dialog.getByLabel('學號').fill(`4111${run}`)
  await dialog.getByLabel('屆別').selectOption({ label: CODE_B })
  await dialog.getByRole('button', { name: '儲存' }).click()
  await expect(dialog.getByRole('status')).toContainText('已儲存')
  await dialog.getByRole('button', { name: '關閉' }).click()
  await page.goto(`/dashboard/admin/accounts?q=${encodeURIComponent(renamed)}`)
  await expect(rowOf(page, renamed)).toContainText(`4111${run}`)
  await expect(rowOf(page, renamed)).toContainText(CODE_B)
  expect(await sql(`select student_no, cohort_id from student_identities where user_id = $1`, [sx1.userId])).toEqual([
    { student_no: `4111${run}`, cohort_id: cohortB },
  ])
  // 只改學號屆別不撤登入：學生還在自己的後台。
  const sxPage = await (await browser.newContext()).newPage()
  await sxPage.context().addCookies([toPlaywrightCookie(sx1.cookie, BASE_URL)])
  await sxPage.goto('/dashboard/student')
  await expect(sxPage).toHaveURL(/\/dashboard\/student/)

  // (b) 學生改老師：學號、屆別欄消失；存後列的角色是「老師」。
  dialog = await openEdit(page, renamed)
  await dialog.getByRole('radio', { name: '老師' }).check()
  await expect(dialog.getByLabel('學號')).toHaveCount(0)
  await expect(dialog.getByLabel('屆別')).toHaveCount(0)
  await dialog.getByRole('button', { name: '儲存' }).click()
  await expect(dialog.getByRole('status')).toContainText('原本的登入已登出')
  await dialog.getByRole('button', { name: '關閉' }).click()
  await page.goto(`/dashboard/admin/accounts?q=${encodeURIComponent(renamed)}`)
  await expect(rowOf(page, renamed).getByRole('cell', { name: '老師', exact: true })).toBeVisible()
  const roles = await sql<{ role: string; revoked: boolean }>(
    `select role, revoked_real_at is not null as revoked from role_assignments where user_id = $1 order by role`,
    [sx1.userId],
  )
  expect(roles).toEqual([
    { role: 'student', revoked: true },
    { role: 'teacher', revoked: false },
  ])
  expect(await sql(`select * from student_identities where user_id = $1`, [sx1.userId])).toEqual([])
  expect(await sql(`select cohort_id, student_no from user_profiles where user_id = $1`, [sx1.userId])).toEqual([{ cohort_id: null, student_no: null }])
  // 原 session 下一個請求就是未登入；重登落在老師後台。
  await sxPage.goto('/dashboard/student')
  await expect(sxPage).toHaveURL(/\/login/)
  const sxAgain = await login(browser, sx1.email)
  await expect(sxAgain).toHaveURL(/\/dashboard\/teacher/)

  // (c) 老師改學生：填學號、屆別 B；重登落在學生後台。
  dialog = await openEdit(page, t2.name)
  await dialog.getByRole('radio', { name: '學生' }).check()
  await dialog.getByLabel('學號').fill(`4119${run}`)
  await dialog.getByLabel('屆別').selectOption({ label: CODE_B })
  await dialog.getByRole('button', { name: '儲存' }).click()
  await expect(dialog.getByRole('status')).toContainText('已儲存')
  await dialog.getByRole('button', { name: '關閉' }).click()
  await page.goto(`/dashboard/admin/accounts?q=${encodeURIComponent(t2.name)}`)
  await expect(rowOf(page, t2.name).getByRole('cell', { name: '學生', exact: true })).toBeVisible()
  await expect(rowOf(page, t2.name)).toContainText(CODE_B)
  expect(await sql(`select student_no, cohort_id from student_identities where user_id = $1`, [t2.userId])).toEqual([
    { student_no: `4119${run}`, cohort_id: cohortB },
  ])
  const t2Again = await login(browser, t2.email)
  await expect(t2Again).toHaveURL(/\/dashboard\/student/)

  await collect(sx1.userId)
  await collect(t2.userId)
})

test('AC-C2-22：在組不能調屆（連到那組）、改老師／改學生前置不成立時「儲存」disabled＋同句 title 與小字、資料不動', async ({ browser }) => {
  const sx = await student('SX組', `4112${run}`)
  const groupId = await group('第 3 組', [sx.userId])
  const t1 = await teacher('T1')
  const advised = await group(`T1A${run}`, [])
  await sql(
    `insert into advisor_assignments (id, group_id, teacher_user_id, source, valid_from, assigned_by_user_id, reason)
     values (gen_random_uuid(), $1, $2, 'admin', now(), $2, '抽籤結果')`,
    [advised, t1.userId],
  )
  for (const g of [advised, await group(`T1B${run}`, []), await group(`T1C${run}`, [])]) {
    await sql(
      `insert into evaluator_assignments (id, group_id, stage_key, teacher_user_id, valid_from, assigned_by_user_id)
       values (gen_random_uuid(), $1, 's1', $2, now(), $2)`,
      [g, t1.userId],
    )
  }
  const t2d = await teacher('T2d')
  const page = await adminPage(browser)
  const before = await sql(`select * from user_profiles where user_id = any($1::uuid[]) order by user_id`, [[sx.userId, t1.userId, t2d.userId]])

  // (a) 屆別下拉 disabled，下面一句連到那一組；姓名、學號仍可改。
  let dialog = await openEdit(page, sx.name)
  await expect(dialog.getByLabel('屆別')).toBeDisabled()
  const lockText = `他在 ${CODE_A} 屆第 3 組，先到分組把他移出才能改屆別`
  await expect(dialog.getByRole('link', { name: lockText })).toHaveAttribute('href', `/dashboard/admin/groups/${groupId}`)
  await expect(dialog.getByLabel('姓名')).toBeEnabled()
  await expect(dialog.getByLabel('學號')).toBeEnabled()
  // (a′) 同視窗改「老師」：儲存 disabled，title 與小字同一句。
  await dialog.getByRole('radio', { name: '老師' }).check()
  const save = dialog.getByRole('button', { name: '儲存' })
  const toTeacher = `他在 ${CODE_A} 屆第 3 組，不能改成老師`
  await expect(save).toBeDisabled()
  await expect(save).toHaveAttribute('title', toTeacher)
  await expect(dialog.getByTestId('edit-blocked')).toHaveText(toTeacher)
  // 組別那半句連到那一組（§3.9；Review 第 1 輪第 5 項）。
  await expect(dialog.getByTestId('edit-blocked').getByRole('link', { name: `他在 ${CODE_A} 屆第 3 組` })).toHaveAttribute(
    'href',
    `/dashboard/admin/groups/${groupId}`,
  )
  await dialog.getByRole('button', { name: '取消' }).click()

  // (c) 指導中 1 組、3 筆評分指派：不能改成學生。
  dialog = await openEdit(page, t1.name)
  await dialog.getByRole('radio', { name: '學生' }).check()
  await dialog.getByLabel('學號').fill(`4113${run}`)
  await dialog.getByLabel('屆別').selectOption({ label: CODE_B })
  const toStudent = '他指導中 1 組、有 3 筆評分指派，不能改成學生'
  await expect(dialog.getByRole('button', { name: '儲存' })).toBeDisabled()
  await expect(dialog.getByRole('button', { name: '儲存' })).toHaveAttribute('title', toStudent)
  await expect(dialog.getByTestId('edit-blocked')).toHaveText(toStudent)
  await dialog.getByRole('button', { name: '取消' }).click()

  // (d) 沒有指派的老師改學生、學號留空：「學生要有學號和屆別」。
  dialog = await openEdit(page, t2d.name)
  await dialog.getByRole('radio', { name: '學生' }).check()
  await dialog.getByLabel('屆別').selectOption({ label: CODE_B })
  await expect(dialog.getByRole('button', { name: '儲存' })).toBeDisabled()
  await expect(dialog.getByRole('button', { name: '儲存' })).toHaveAttribute('title', '學生要有學號和屆別')
  await expect(dialog.getByTestId('edit-blocked')).toHaveText('學生要有學號和屆別')
  await dialog.getByRole('button', { name: '取消' }).click()

  // 四種都按不下去：資料庫沒有變動。
  expect(await sql(`select * from user_profiles where user_id = any($1::uuid[]) order by user_id`, [[sx.userId, t1.userId, t2d.userId]])).toEqual(before)
  expect(
    await sql(`select count(*)::int as n from audit_events where action = 'account.profile_edit' and target_id = any($1::uuid[])`, [
      [sx.userId, t1.userId, t2d.userId],
    ]),
  ).toEqual([{ n: 0 }])
})

test('AC-C2-23：學號在那一屆已經有人 → alert，資料不變', async ({ browser }) => {
  const taken = `4115${run}`
  await student('占用', taken, cohortB)
  const other = await student('另一人', `4116${run}`)
  const page = await adminPage(browser)
  const before = await sql(`select student_no, cohort_id from student_identities where user_id = $1`, [other.userId])

  const dialog = await openEdit(page, other.name)
  await dialog.getByLabel('學號').fill(taken)
  await dialog.getByLabel('屆別').selectOption({ label: CODE_B })
  await dialog.getByRole('button', { name: '儲存' }).click()
  await expect(dialog.getByRole('alert')).toHaveText(`這個學號在 ${CODE_B} 屆已經有人`)
  expect(await sql(`select student_no, cohort_id from student_identities where user_id = $1`, [other.userId])).toEqual(before)

  const dir = process.env.E2E_EVIDENCE_DIR
  if (dir) for (const [file, rows] of Object.entries(evidence)) writeFileSync(`${dir}/${file}.json`, `${JSON.stringify(rows, null, 2)}\n`)
})
