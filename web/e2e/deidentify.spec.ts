import { expect, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, sharedTestSession, toPlaywrightCookie, type TestSession } from './session'

/**
 * 票 40：系辦用**真的畫面**完成一次去識別化（ACC-14）。
 *
 * 影響預覽 → 理由必填 → 照打登入 Email 才按得下去 → 回執只有代稱；
 * 之後原姓名搜不到、狀態篩選找得到代稱；本人舊分頁下一個動作就被登出，原 Email 也登入不了。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER
/** e2e/session.ts 造的帳號都用這個密碼。 */
const PASSWORD = 'E2e-Password-Correct-9'

const run = Date.now().toString(36)
const prefix = String(Date.now()).slice(-6)
const name = `去識${prefix}`
const studentNo = `0${prefix}401`

let target: TestSession

function rowOf(page: Page, text: string) {
  return page.getByRole('table', { name: '帳號列表' }).getByRole('row').filter({ has: page.getByText(text, { exact: true }) })
}

test.beforeAll(async ({ playwright }) => {
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能種學生資料')
  const request = await playwright.request.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { origin: new URL(BASE_URL).origin } })
  const pool = new Pool({ connectionString: ownerUrl, max: 1 })
  try {
    const cohort = await pool.query<{ id: string }>(
      `insert into cohorts (id, code, name, created_by_kind) values (gen_random_uuid(), $1, $2, 'system') returning id`,
      [`d${run}`.slice(0, 20), `E2E 去識別化測試屆 ${run}`],
    )
    // 一個核准過的學生（真的註冊拿 session，再補上核准後才有的資料；審核畫面由 registration.spec 測）。
    target = await createTestSession(request, 'student')
    await pool.query(`update users set name = $2 where id = $1`, [target.userId, name])
    await pool.query(
      `insert into user_profiles (user_id, display_name, name_normalized, student_no, department_class, cohort_id, phone, contact_email)
       values ($1, $2, lower($2), $3, '資管二甲', $4, '0912-345-678', $5)`,
      [target.userId, name, studentNo, cohort.rows[0]!.id, target.email],
    )
    await pool.query(`insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)`, [
      cohort.rows[0]!.id,
      studentNo,
      target.userId,
    ])
  } finally {
    await pool.end()
    await request.dispose()
  }
})

test('系辦完成一次去識別化：預覽、理由、照打 Email、回執只有代稱；本人被登出且不能再登入', async ({ browser }) => {
  // 本人的「舊分頁」：已經登入、開著學生首頁。
  const studentContext = await browser.newContext()
  await studentContext.addCookies([toPlaywrightCookie(target.cookie, BASE_URL)])
  const studentPage = await studentContext.newPage()
  await studentPage.goto('/dashboard/student')
  await expect(studentPage).toHaveURL(/\/dashboard\/student$/)

  const adminContext = await browser.newContext()
  const page = await adminContext.newPage()
  const session = await sharedTestSession(page.request, 'admin')
  await adminContext.addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])

  await page.goto(`/dashboard/admin/accounts?q=${encodeURIComponent(name)}`)
  await rowOf(page, name).getByRole('button', { name: `去識別化 ${name}` }).click()
  const dialog = page.getByRole('dialog', { name: `去識別化 ${name}` })

  // 影響預覽：對象、代稱、會清除、會保留。
  await expect(dialog.getByText(target.email, { exact: true })).toBeVisible()
  await expect(dialog.getByText(studentNo, { exact: true })).toBeVisible()
  await expect(dialog.getByRole('region', { name: '會清除' })).toBeVisible()
  await expect(dialog.getByTestId('deidentify-retained')).toContainText('操作紀錄')

  // 沒寫理由、沒照打 Email 之前按不下去；打錯也按不下去。
  const confirm = dialog.getByRole('button', { name: '確認去識別化' })
  await expect(confirm).toBeDisabled()
  await dialog.getByLabel(/理由/).fill('本人申請刪除個資')
  await dialog.getByLabel('照打登入 Email 確認').fill('someone-else@example.com')
  await expect(confirm).toBeDisabled()
  await dialog.getByLabel('照打登入 Email 確認').fill(target.email)
  await confirm.click()

  await expect(dialog.getByRole('status')).toContainText('已去識別化')
  const pseudonym = (await dialog.getByTestId('deidentify-pseudonym').innerText()).trim()
  expect(pseudonym).toMatch(/^已去識別化使用者 [0-9A-F]{6}$/)
  await expect(dialog).not.toContainText(name)
  await dialog.getByRole('button', { name: '關閉' }).click()

  // 原姓名搜不到；用狀態篩選＋代稱找得到，狀態是「已去識別化」、沒有學號。
  await page.goto(`/dashboard/admin/accounts?q=${encodeURIComponent(name)}`)
  await expect(page.getByText('沒有符合條件的帳號')).toBeVisible()
  await page.goto(`/dashboard/admin/accounts?status=deidentified&q=${encodeURIComponent(pseudonym)}`)
  const row = rowOf(page, pseudonym)
  await expect(row).toContainText('已去識別化')
  await expect(row).not.toContainText(studentNo)
  await expect(row.getByRole('button', { name: `去識別化 ${pseudonym}` })).toHaveCount(0)

  // 本人舊分頁做下一個動作 → 被帶去登入頁；原 Email 也登入不了。
  await studentPage.reload()
  await expect(studentPage).toHaveURL(/\/login/)
  await studentPage.getByLabel('Email').fill(target.email)
  await studentPage.getByLabel('密碼', { exact: true }).fill(PASSWORD)
  await studentPage.getByRole('button', { name: '登入', exact: true }).click()
  await expect(studentPage.getByRole('alert')).toBeVisible()
  await expect(studentPage).toHaveURL(/\/login/)

  await studentContext.close()
  await adminContext.close()
})
