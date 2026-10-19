import { writeFileSync } from 'node:fs'
import { expect, test, type Browser, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { sharedTestSession, toPlaywrightCookie } from './session'

/**
 * C 階段規格② C2-09：新增成員（設計方案 §3.7；AC-C2-27）。
 *
 * - 「新增成員」→ 老師／管理員／學生各建一位：三位都出現在全部帳號、狀態「已核准」；
 *   管理員那位有 admin 角色；學生那位占了學號；每位 `mail_outbox` 一封「請設定密碼」信；視窗沒有核實方式欄。
 * - 同屆同學號再加一次 → 視窗內寫「這個學號在 … 屆已經有人」，沒有多出帳號。
 * - 信裡的連結真的能設密碼並登入。
 *
 * 設 `C2_09_EVIDENCE` 環境變數時，把 `mail_outbox` 那三列寫成 JSON 檔（PR 證據 `C2-09-sql-1.json`）。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER
const PASSWORD = 'New-Member-Password-2026'

test.describe.configure({ mode: 'serial' })

const run = Date.now().toString(36)
const stamp = String(Date.now()).slice(-6)
const cohortCode = `NM-${stamp}`
const cohortLabel = `E2E 新增成員屆 ${cohortCode}（${cohortCode}）`
const people = {
  student: { name: `新生${stamp}`, email: `nm-student-${run}@example.com`, studentNo: `8${stamp}01` },
  teacher: { name: `新師${stamp}`, email: `nm-teacher-${run}@example.com` },
  admin: { name: `新管${stamp}`, email: `nm-admin-${run}@example.com` },
}
let cohortId: string

test.beforeAll(async () => {
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能種資料')
  const pool = new Pool({ connectionString: ownerUrl, max: 1 })
  try {
    cohortId = (
      await pool.query<{ id: string }>(
        `insert into cohorts (id, code, name, created_by_kind) values (gen_random_uuid(), $1, $2, 'system') returning id`,
        [cohortCode, `E2E 新增成員屆 ${cohortCode}`],
      )
    ).rows[0]!.id
  } finally {
    await pool.end()
  }
})

async function adminPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext()
  const page = await context.newPage()
  const session = await sharedTestSession(page.request, 'admin')
  await context.addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
  return page
}

async function openDialog(page: Page) {
  await page.goto('/dashboard/admin/accounts')
  await page.getByRole('button', { name: '新增成員', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '新增成員' })
  await expect(dialog).toBeVisible()
  return dialog
}

async function query<T extends Record<string, unknown>>(sql: string, params: unknown[]): Promise<T[]> {
  const pool = new Pool({ connectionString: ownerUrl, max: 1 })
  try {
    return (await pool.query(sql, params)).rows as T[]
  } finally {
    await pool.end()
  }
}

async function setupMails(email: string) {
  await expect
    .poll(async () => (await query(`select 1 from mail_outbox where to_email = $1`, [email])).length, { timeout: 15_000 })
    .toBe(1)
  return query<{ to_email: string; template: string; subject: string; body_text: string | null }>(
    `select to_email, template, subject, body_text from mail_outbox where to_email = $1`,
    [email],
  )
}

test('AC-C2-27：學生、老師、管理員各建一位，直接開通並各寄一封「請設定密碼」信；視窗沒有核實方式', async ({ browser }) => {
  const admin = await adminPage(browser)
  let dialog = await openDialog(admin)
  await expect(dialog.getByRole('radio')).toHaveCount(3)
  await expect(dialog).not.toContainText('怎麼確認')
  await expect(dialog).not.toContainText('核實')

  // 學生：預設就是學生，要學號和屆別。
  const s = people.student
  await dialog.getByLabel('姓名').fill(s.name)
  await dialog.getByLabel('登入 Email').fill(s.email)
  await dialog.getByRole('button', { name: '新增學生' }).click()
  await expect(dialog.getByRole('alert')).toContainText('學生要有學號和屆別')
  await dialog.getByLabel('學號', { exact: true }).fill(s.studentNo)
  await dialog.getByRole('combobox', { name: /屆別/ }).selectOption({ label: cohortLabel })
  await dialog.getByRole('button', { name: '新增學生' }).click()
  await expect(dialog.getByRole('status')).toContainText('已新增學生')
  await expect(dialog.getByRole('status')).toContainText(`已寄「請設定密碼」信到 ${s.email}`)
  await dialog.getByRole('button', { name: '關閉' }).click()

  // 老師：不問學號、屆別。
  dialog = await openDialog(admin)
  await dialog.getByRole('radio', { name: /^老師/ }).check()
  await expect(dialog.getByLabel('學號', { exact: true })).toHaveCount(0)
  await expect(dialog.getByRole('combobox')).toHaveCount(0)
  await dialog.getByLabel('姓名').fill(people.teacher.name)
  await dialog.getByLabel('登入 Email').fill(people.teacher.email)
  await dialog.getByRole('button', { name: '新增老師' }).click()
  await expect(dialog.getByRole('status')).toContainText('已新增老師')
  await dialog.getByRole('button', { name: '關閉' }).click()

  // 管理員。
  dialog = await openDialog(admin)
  await dialog.getByRole('radio', { name: /^管理員/ }).check()
  await dialog.getByLabel('姓名').fill(people.admin.name)
  await dialog.getByLabel('登入 Email').fill(people.admin.email)
  await dialog.getByRole('button', { name: '新增管理員' }).click()
  await expect(dialog.getByRole('status')).toContainText('已新增管理員')
  await expect(dialog.getByRole('alert')).toHaveCount(0)
  await dialog.getByRole('button', { name: '關閉' }).click()

  // 三位都在全部帳號，狀態「已核准」。
  for (const p of Object.values(people)) {
    await admin.goto(`/dashboard/admin/accounts?q=${encodeURIComponent(p.email)}`)
    const row = admin.getByRole('table', { name: '帳號列表' }).getByRole('row').filter({ hasText: p.email })
    await expect(row).toHaveCount(1)
    await expect(row).toContainText('已核准')
  }

  // 資料庫：角色、學號占用、一人一封「請設定密碼」信。
  const roles = async (email: string) =>
    (
      await query<{ role: string }>(
        `select ra.role from role_assignments ra join users u on u.id = ra.user_id
          where lower(u.email) = $1 and ra.revoked_real_at is null order by ra.role`,
        [email],
      )
    ).map((r) => r.role)
  expect(await roles(s.email)).toEqual(['student'])
  expect(await roles(people.teacher.email)).toEqual(['teacher'])
  expect(await roles(people.admin.email)).toEqual(['admin', 'teacher'])
  expect(
    await query(`select si.student_no from student_identities si join users u on u.id = si.user_id where lower(u.email) = $1 and si.cohort_id = $2`, [s.email, cohortId]),
  ).toEqual([{ student_no: s.studentNo.toUpperCase() }])

  const mails = [...(await setupMails(s.email)), ...(await setupMails(people.teacher.email)), ...(await setupMails(people.admin.email))]
  expect(mails).toHaveLength(3)
  for (const m of mails) {
    expect(m.template).toBe('password_reset')
    expect(m.subject).toBe('【專題管理平台】請設定密碼')
  }
  if (process.env.C2_09_EVIDENCE) {
    // 證據只留收件人、樣板、主旨；信裡的重設連結（含 token）不寫出去。
    writeFileSync(
      process.env.C2_09_EVIDENCE,
      JSON.stringify(mails.map(({ to_email, template, subject }) => ({ to_email, template, subject })), null, 2),
    )
  }
  await admin.context().close()
})

test('同屆同學號再加一次 → 視窗內擋下，沒有多出帳號', async ({ browser }) => {
  const admin = await adminPage(browser)
  const dialog = await openDialog(admin)
  const email = `nm-dup-${run}@example.com`
  await dialog.getByLabel('姓名').fill(`重號${stamp}`)
  await dialog.getByLabel('登入 Email').fill(email)
  await dialog.getByLabel('學號', { exact: true }).fill(people.student.studentNo.toLowerCase())
  await dialog.getByRole('combobox', { name: /屆別/ }).selectOption({ label: cohortLabel })
  await dialog.getByRole('button', { name: '新增學生' }).click()
  await expect(dialog.getByRole('alert')).toContainText(`這個學號在 ${cohortCode} 屆已經有人`)
  expect(await query(`select 1 from users where lower(email) = $1`, [email])).toHaveLength(0)
  await admin.context().close()
})

test('信裡的連結真的能設密碼，設好就能登入', async ({ browser }) => {
  const [mail] = await setupMails(people.teacher.email)
  const url = /https?:\/\/\S+?\/reset-password\?token=[^\s。，]+/.exec(mail!.body_text ?? '')?.[0]
  if (!url) throw new Error('信裡沒有設定密碼的連結')
  const parsed = new URL(url)

  const context = await browser.newContext({ extraHTTPHeaders: { 'x-real-ip': `10.209.${Number(stamp.slice(-2)) + 1}.7` } })
  const page = await context.newPage()
  await page.goto(`${parsed.pathname}${parsed.search}`)
  await page.getByLabel('新密碼', { exact: true }).fill(PASSWORD)
  await page.getByLabel('確認密碼').fill(PASSWORD)
  await page.getByRole('button', { name: '重設密碼' }).click()
  await expect(page.getByText('密碼已重設，請用新密碼登入')).toBeVisible()

  await page.goto('/login')
  await page.getByLabel('Email').fill(people.teacher.email)
  await page.getByLabel('密碼', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: '登入', exact: true }).click()
  // 老師第一次登入要補資料，不用改密碼（這個密碼是他自己設的）。
  await page.waitForURL(/\/account\/setup$/, { timeout: 10_000 })
  await context.close()
})
