import { expect, test, type APIRequestContext, type Browser, type Page, type PlaywrightWorkerArgs } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, sharedTestSession, toPlaywrightCookie } from './session'

/**
 * C2-11：帳號列「寄重設密碼信」＋臨時密碼視窗不問核實（AC-C2-24、25、26）。
 *
 * 要擷取模式（`MAIL_CAPTURE=1`）：信的內容從 `mail_outbox` 讀。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER

async function sql<T extends Record<string, unknown> = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER')
  const pool = new Pool({ connectionString: ownerUrl, max: 1 })
  try {
    return (await pool.query<T>(text, params)).rows
  } finally {
    await pool.end()
  }
}

async function adminPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext()
  const page = await context.newPage()
  const session = await sharedTestSession(page.request, 'admin')
  await context.addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
  return page
}

/** Better Auth 對沒有 Origin 的請求一律拒絕；獨立的 request context 要手動帶。 */
async function originRequest(playwright: PlaywrightWorkerArgs['playwright']): Promise<APIRequestContext> {
  return playwright.request.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { origin: new URL(BASE_URL).origin } })
}

async function rowFor(page: Page, email: string) {
  await page.goto(`/dashboard/admin/accounts?q=${encodeURIComponent(email)}`)
  const row = page.getByRole('table', { name: '帳號列表' }).getByRole('row').filter({ hasText: email })
  await expect(row).toBeVisible()
  return row
}

test('AC-C2-24：有密碼的帳號列寄重設密碼信 → 視窗寫收件人與 30 分鐘；mail_outbox 與稽核各一列', async ({ browser, playwright }) => {
  const admin = await adminPage(browser)
  const request = await originRequest(playwright)
  const student = await createTestSession(request, 'student')
  const row = await rowFor(admin, student.email)

  await row.getByRole('button', { name: /^寄重設密碼信給/ }).click()
  const dialog = admin.getByRole('dialog', { name: '寄重設密碼信' })
  await expect(dialog).toContainText(student.email)
  await dialog.getByRole('button', { name: '寄出' }).click()
  await expect(dialog.getByRole('status')).toContainText(`已寄到 ${student.email}`)
  await expect(dialog.getByRole('status')).toContainText('30 分鐘內有效')

  const mails = await sql<{ template: string; to_email: string }>(
    `select template, to_email from mail_outbox where to_email = $1 and template = 'password_reset'`,
    [student.email],
  )
  expect(mails).toEqual([{ template: 'password_reset', to_email: student.email }])
  const audits = await sql<{ n: number }>(
    `select count(*)::int as n from audit_events where action = 'account.reset_mail_sent' and target_id = $1`,
    [student.userId],
  )
  expect(audits).toEqual([{ n: 1 }])
  await request.dispose()
  await admin.context().close()
})

test('AC-C2-25：只有 Google 登入的帳號，「寄重設密碼信」disabled 並寫原因', async ({ browser }) => {
  const admin = await adminPage(browser)
  const email = `e2e-google-${Date.now().toString(36)}@example.com`
  const id = (
    await sql<{ id: string }>(
      `insert into users (id, name, email, email_verified, status) values (gen_random_uuid(), 'Google 帳號', $1, true, 'active') returning id`,
      [email],
    )
  )[0]!.id
  await sql(
    `insert into accounts (id, account_id, provider_id, user_id, created_at, updated_at) values (gen_random_uuid(), $1, 'google', $2, now(), now())`,
    [`g-${id}`, id],
  )
  const row = await rowFor(admin, email)
  await expect(row.getByRole('button', { name: /^寄重設密碼信給/ })).toBeDisabled()
  await expect(row).toContainText('這個帳號用 Google 登入，沒有密碼')
  await admin.context().close()
})

test('AC-C2-26：收不到信 → 臨時密碼，不問怎麼確認，理由留空照發；稽核記 office_review', async ({ browser, playwright }) => {
  const admin = await adminPage(browser)
  const request = await originRequest(playwright)
  const student = await createTestSession(request, 'student')
  const row = await rowFor(admin, student.email)

  await row.getByRole('button', { name: /^寄重設密碼信給/ }).click()
  await admin.getByRole('dialog', { name: '寄重設密碼信' }).getByRole('button', { name: '改發臨時密碼' }).click()
  const temp = admin.getByRole('dialog', { name: '發臨時密碼' })
  await expect(temp).not.toContainText('怎麼確認')
  await expect(temp.getByRole('radio')).toHaveCount(0)
  await temp.getByRole('button', { name: '產生一次性密碼' }).click()
  const secret = (await temp.getByTestId('temporary-password').innerText()).trim()
  expect(secret.length).toBeGreaterThanOrEqual(12)

  // 核發臨時密碼只寫稽核（不寫 user_status_events），核實方式固定 office_review。
  const events = await sql<{ verification_method: string | null }>(
    `select verification_method from audit_events where action = 'account.issue_temporary_password' and target_id = $1 order by real_at desc limit 1`,
    [student.userId],
  )
  expect(events[0]?.verification_method).toBe('office_review')
  await request.dispose()
  await admin.context().close()
})
