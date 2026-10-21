import { expect, request as playwrightRequest, test } from '@playwright/test'
import { Pool } from 'pg'
import { createLegacyVersion } from './legacy-signoff'
import { createTestSession, sharedTestSession, toPlaywrightCookie, type TestSession } from './session'

/**
 * CL-4（#820）Review 1：同意書理由拿掉原生 `maxLength`、改用計數元件後，理由打超過上限按送出——
 * 表單在送出前就擋下（React 19 的 `<form action>` 跑完會重設表單，等伺服器回錯就把打的字清掉了）：
 * 字還在、看得到跟伺服器同一句訊息、這一票沒有記下。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const stamp = Date.now().toString(36).toUpperCase()
const MAX = 500

let pool: Pool
let student: TestSession
let versionId: string

test.beforeAll(async () => {
  test.setTimeout(120_000)
  if (!process.env.DATABASE_URL_OWNER) throw new Error('e2e 需要 DATABASE_URL_OWNER')
  pool = new Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 2 })
  const fresh = async (role: 'teacher' | 'student') => {
    const context = await playwrightRequest.newContext({ baseURL: BASE_URL })
    try {
      return await createTestSession(context, role)
    } finally {
      await context.dispose()
    }
  }
  const adminContext = await playwrightRequest.newContext({ baseURL: BASE_URL })
  const adminId = (await sharedTestSession(adminContext, 'admin')).userId
  await adminContext.dispose()
  const teacher = await fresh('teacher')
  student = await fresh('student')

  const cohortId = String((await pool.query(
    `insert into cohorts (id, code, name, status, year_end_date, is_default_working, group_size_min, group_size_max, created_by_kind)
     values (gen_random_uuid(), $1, $1, 'active', '2099-06-30', false, 1, 5, 'system') returning id`,
    [`CL4R-${stamp}`],
  )).rows[0]!.id)
  const studentNo = `426${String(Date.now()).slice(-6)}`
  await pool.query(
    `insert into user_profiles (user_id, display_name, name_normalized, student_no, cohort_id, phone, contact_email)
     values ($1, $2, $2, $3, $4, '0912000000', $5)
     on conflict (user_id) do update set display_name = excluded.display_name, student_no = excluded.student_no, cohort_id = excluded.cohort_id`,
    [student.userId, `理由測試${stamp.slice(-3)}`, studentNo, cohortId, `cl4r-${stamp.toLowerCase()}@contact.example.com`],
  )
  await pool.query(`insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)`, [cohortId, studentNo, student.userId])
  const at = new Date(Date.now() - 86_400_000)
  const groupId = String((await pool.query(
    `insert into groups (id, cohort_id, code, group_type, status, established_real_at, established_business_at, created_by_kind)
     values (gen_random_uuid(), $1, 'G01', 'general', 'active', $2, $2, 'system') returning id`,
    [cohortId, at],
  )).rows[0]!.id)
  await pool.query(
    `insert into group_memberships (id, group_id, cohort_id, user_id, valid_from, added_by_kind) values (gen_random_uuid(), $1, $2, $3, $4, 'system')`,
    [groupId, cohortId, student.userId, at],
  )
  await pool.query(`insert into group_leaders (id, group_id, user_id, valid_from, changed_by_user_id) values (gen_random_uuid(), $1, $2, $3, $2)`, [
    groupId,
    student.userId,
    at,
  ])
  await pool.query(
    `insert into advisor_assignments (id, group_id, teacher_user_id, source, valid_from, assigned_by_user_id, reason)
     values (gen_random_uuid(), $1, $2, 'admin', $3, $4, '抽籤結果')`,
    [groupId, teacher.userId, at, adminId],
  )
  versionId = (await createLegacyVersion(pool, { groupId, purpose: 'result_confirmation', content: `期中結果確認全文（${stamp}）`, adminId })).versionId
})

test.afterAll(async () => { await pool?.end() })

test('不同意的理由打 501 個 emoji 按送出：字還在、看得到「最多 500 字」、沒有記下這一票；刪到 500 個就送得出去', async ({ page }) => {
  await page.context().addCookies([toPlaywrightCookie(student.cookie, BASE_URL)])
  await page.goto('/dashboard/student/signoff')
  await page.getByTestId('respond-form').getByRole('button', { name: '不同意並退回修正' }).click()
  const dialog = page.getByRole('dialog', { name: '不同意並退回修正' })
  const reason = dialog.getByLabel('理由（選填）')
  const tooLong = '😀'.repeat(MAX + 1)
  await reason.fill(tooLong)
  await expect(dialog.getByTestId('char-count')).toHaveText(`${MAX + 1}／${MAX} 字（超過 1 字）`)
  await dialog.getByRole('button', { name: '確定不同意並退回修正' }).click()
  await expect(dialog.getByRole('alert')).toHaveText(`不同意或退回的理由最多 ${MAX} 字。`)
  await expect(reason).toHaveValue(tooLong)
  await expect(dialog).toBeVisible()
  const none = await pool.query('select 1 from approvals where version_id = $1', [versionId])
  expect(none.rowCount).toBe(0)

  await reason.fill('😀'.repeat(MAX))
  await dialog.getByRole('button', { name: '確定不同意並退回修正' }).click()
  await expect(dialog).toBeHidden()
  await expect.poll(async () => (await pool.query('select reason from approvals where version_id = $1', [versionId])).rows[0]?.reason, {
    timeout: 10_000,
    message: '500 個 emoji 的理由應該存得進去',
  }).toBe('😀'.repeat(MAX))
})
