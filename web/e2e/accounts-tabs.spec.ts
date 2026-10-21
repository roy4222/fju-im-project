import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, sharedTestSession, toPlaywrightCookie } from './session'

/**
 * C 階段規格② C2-07：帳號拆成四個分頁（設計方案 §3.1、§3.2、§3.3、§3.5、§3.6）。
 *
 * - AC-C2-18：全部帳號只剩列表；標題列只有一顆「新增成員」。
 * - AC-C2-13（帳號部分）：沒有「危險操作」；列上依序「編輯、發臨時密碼、停用、更多」，「刪除個人資料」是「更多」最後一項。
 * - AC-C2-20：待審核分頁不寫「第 N 版」；被退回後重新送出的列尾寫「已重送」，從沒被退回過的不寫（走真的「退回 → 重送」）。
 * - AC-C2-30：已停用分頁只列停用的人，每列「恢復」、更多裡「刪除個人資料」；標題列「批次停用」；匯出在工具列。
 * - AC-C2-31：名單匯入分頁標題列「匯入名單」、「歷次匯入」、說明句寫自動開通。
 * - AC-C2-32：帳號列的屆別連到那一屆的分組總覽、組別連到那一組（分組頁連回帳號列由③做）。
 *
 * `?status=pending|disabled` 舊網址轉址（AC-C2-08）在 `admin-redirects.spec.ts`。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'

/** 這份開的瀏覽器 context 每個測試結束就關（#816：沒關的分頁會活到 worker 結束，全套連跑時一直吃 CPU）。 */
const openContexts: BrowserContext[] = []
function track(context: BrowserContext): BrowserContext {
  openContexts.push(context)
  return context
}
test.afterEach(async () => {
  await Promise.all(openContexts.splice(0).map((context) => context.close()))
})

const ownerUrl = process.env.DATABASE_URL_OWNER

test.describe.configure({ mode: 'serial' })

const stamp = String(Date.now()).slice(-6)
const tag = `分頁${stamp}`
const prefix = `7${stamp.slice(-4)}`
const cohortCode = `C207-${stamp}`

let cohortId: string
let groupId: string
const groupCode = `G${stamp.slice(-2)}`
const people = {
  grouped: { name: `${tag}-有組`, studentNo: `0${prefix}001`, userId: '' },
  disabled: { name: `${tag}-停用`, studentNo: `0${prefix}002`, userId: '' },
  resubmitted: { name: `${tag}-重送`, studentNo: `0${prefix}003`, userId: '', cookie: '' },
  fresh: { name: `${tag}-新申請`, studentNo: `0${prefix}004`, userId: '', cookie: '' },
}

test.beforeAll(async ({ playwright }) => {
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能種資料')
  const request = await playwright.request.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { origin: new URL(BASE_URL).origin } })
  const pool = new Pool({ connectionString: ownerUrl, max: 1 })
  try {
    cohortId = (
      await pool.query<{ id: string }>(
        `insert into cohorts (id, code, name, created_by_kind) values (gen_random_uuid(), $1, $2, 'system') returning id`,
        [cohortCode, `E2E 分頁測試屆 ${cohortCode}`],
      )
    ).rows[0]!.id

    // 兩個核准過的學生（一個在組裡、一個等一下停用）。
    for (const p of [people.grouped, people.disabled]) {
      const session = await createTestSession(request, 'student')
      p.userId = session.userId
      await pool.query(`update users set name = $2 where id = $1`, [session.userId, p.name])
      await pool.query(
        `insert into user_profiles (user_id, display_name, name_normalized, student_no, department_class, cohort_id, phone, contact_email)
         values ($1, $2, lower($2), $3, '資管二甲', $4, '0912-345-678', $5)`,
        [session.userId, p.name, p.studentNo, cohortId, session.email],
      )
      await pool.query(`insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)`, [cohortId, p.studentNo, session.userId])
    }
    groupId = (
      await pool.query<{ id: string }>(
        `insert into groups (id, cohort_id, code, group_type, established_real_at, established_business_at, created_by_kind)
         values (gen_random_uuid(), $1, $2, 'general', now(), now(), 'system') returning id`,
        [cohortId, groupCode],
      )
    ).rows[0]!.id
    await pool.query(
      `insert into group_memberships (id, group_id, cohort_id, user_id, valid_from, added_by_kind)
       values (gen_random_uuid(), $1, $2, $3, now(), 'system')`,
      [groupId, cohortId, people.grouped.userId],
    )
    // 停用：狀態直接寫（停用流程本身由 accounts.spec 測）。
    await pool.query(`update users set status = 'disabled' where id = $1`, [people.disabled.userId])

    // 兩個待審申請：「重送」那位等一下會被退回再重送；「新申請」從沒被退回過。
    // 學生要用畫面重送，所以 Email 先標成已驗證（不然會被帶去驗證頁）。
    for (const p of [people.resubmitted, people.fresh]) {
      const pending = await createTestSession(request, null)
      p.userId = pending.userId
      p.cookie = pending.cookie
      await pool.query(`update users set email_verified = true where id = $1`, [pending.userId])
      await pool.query(
        `insert into registration_applications
           (id, user_id, applied_name, student_no, department_class, phone, contact_email, login_email, revision, created_by_kind, created_by_user_id)
         values (gen_random_uuid(), $1, $2, $3, '資管二甲', '0912-345-678', $4, $4, 1, 'user', $1)`,
        [pending.userId, p.name, p.studentNo, pending.email],
      )
    }
  } finally {
    await pool.end()
    await request.dispose()
  }
})

async function adminPage(browser: Browser): Promise<Page> {
  const context = track(await browser.newContext())
  const page = await context.newPage()
  const session = await sharedTestSession(page.request, 'admin')
  await context.addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
  return page
}

function rowOf(page: Page, name: string) {
  return page.getByRole('table', { name: '帳號列表' }).getByRole('row').filter({ has: page.getByText(name, { exact: true }) })
}

test('AC-C2-18：全部帳號只剩列表，標題列只有「新增成員」', async ({ browser }) => {
  const page = await adminPage(browser)
  const response = await page.goto('/dashboard/admin/accounts')
  expect(response?.status()).toBe(200)
  await expect(page.getByRole('table', { name: '帳號列表' })).toBeVisible()
  await expect(page.getByRole('region', { name: '待審核' })).toHaveCount(0)
  await expect(page.locator('details[aria-label="名單與停用"]')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '發臨時密碼', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '新增老師', exact: true })).toHaveCount(0)
  await expect(page.getByTestId('page-title-actions').getByRole('button')).toHaveText(['新增成員'])
  // 「新增成員」開三選一的視窗（C2-09；內容在 `new-member.spec.ts`）。
  await page.getByRole('button', { name: '新增成員', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '新增成員' })).toBeVisible()
})

test('AC-C2-13：帳號頁、已停用分頁沒有「危險操作」；列上依序編輯、寄重設密碼信、停用、更多', async ({ browser }) => {
  const page = await adminPage(browser)
  for (const path of ['/dashboard/admin/accounts', '/dashboard/admin/accounts/disabled']) {
    await page.goto(path)
    await expect(page.locator('main')).not.toContainText('危險操作')
    await expect(page.locator('main')).not.toContainText('危險區')
  }

  const { name } = people.grouped
  await page.goto(`/dashboard/admin/accounts?q=${encodeURIComponent(name)}`)
  const row = rowOf(page, name)
  await expect(row.getByRole('button')).toHaveText(['編輯', '寄重設密碼信', '停用', ''])
  await expect(row.getByRole('button').last()).toHaveAccessibleName(`更多 ${name}`)
  // 編輯帳號 C2-08 接上了：按得下去，打開「編輯帳號」視窗。
  await expect(row.getByRole('button', { name: `編輯 ${name}` })).toBeEnabled()
  await row.getByRole('button', { name: `編輯 ${name}` }).click()
  const editDialog = page.getByRole('dialog', { name: `編輯帳號 ${name}` })
  await expect(editDialog).toBeVisible()
  await expect(editDialog.getByLabel('姓名')).toBeVisible()
  await editDialog.getByRole('button', { name: '取消' }).click()
  await expect(editDialog).toBeHidden()

  await row.getByRole('button', { name: `更多 ${name}` }).click()
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  await expect(menu).not.toContainText('危險操作')
  await expect(menu.getByRole('menuitem').last()).toHaveText('刪除個人資料')
})

test('AC-C2-20：待審核分頁不寫「第 N 版」，退回後重送的列尾寫「已重送」，沒被退回過的不寫', async ({ browser }) => {
  const page = await adminPage(browser)
  const pendingRow = (name: string) =>
    page.getByRole('table', { name: '待審核清單' }).getByRole('row').filter({ has: page.getByText(name, { exact: true }) })

  // 退回前：兩位都是第一次送，都沒有「已重送」。
  const response = await page.goto('/dashboard/admin/accounts/pending')
  expect(response?.status()).toBe(200)
  await expect(pendingRow(people.resubmitted.name)).not.toContainText('已重送')
  await expect(pendingRow(people.fresh.name)).not.toContainText('已重送')

  // 系辦在畫面上退回「重送」那位。
  await page.getByRole('button', { name: `退回 ${people.resubmitted.name}` }).click()
  const dialog = page.getByRole('dialog', { name: `退回 ${people.resubmitted.name}` })
  await dialog.getByLabel(/^理由/).fill('請補正系級後重新送出')
  await dialog.getByRole('button', { name: '退回' }).click()
  await expect(dialog.getByRole('status')).toContainText('已退回')
  await dialog.getByRole('button', { name: '關閉' }).click()
  await expect(pendingRow(people.resubmitted.name)).toHaveCount(0)

  // 學生登入看到退回理由，用畫面重新送出（新的申請，版本從 1 開始）。
  const context = await browser.newContext()
  const student = await context.newPage()
  await context.addCookies([toPlaywrightCookie(people.resubmitted.cookie, BASE_URL)])
  await student.goto('/register/pending')
  await expect(student.getByRole('heading', { name: '申請被退回' })).toBeVisible()
  await student.getByRole('button', { name: '送出申請' }).click()
  await expect(student.getByRole('heading', { name: '等待系辦審核' })).toBeVisible()
  await context.close()

  // 重送後：這位列尾「已重送」、沒有「第 N 版」；沒被退回過的那位沒有。
  await page.goto('/dashboard/admin/accounts/pending')
  const row = pendingRow(people.resubmitted.name)
  await expect(row).toContainText('已重送')
  await expect(row).not.toContainText('第 1 版')
  await expect(row).not.toContainText('第 2 版')
  await expect(pendingRow(people.fresh.name)).not.toContainText('已重送')
  await expect(row.getByRole('button', { name: `核准 ${people.resubmitted.name}` })).toBeVisible()
  await expect(row.getByRole('button', { name: `退回 ${people.resubmitted.name}` })).toBeVisible()
})

test('AC-C2-30：已停用分頁只列停用的人，每列恢復與刪除個人資料，標題列批次停用，匯出在工具列', async ({ browser }) => {
  const page = await adminPage(browser)
  const response = await page.goto(`/dashboard/admin/accounts/disabled?q=${encodeURIComponent(tag)}`)
  expect(response?.status()).toBe(200)
  const rows = page.getByRole('table', { name: '帳號列表' }).locator('tbody tr')
  await expect(rows).toHaveCount(1)
  const { name } = people.disabled
  const row = rowOf(page, name)
  await expect(row).toContainText('已停用')
  await expect(row.getByRole('button', { name: `恢復 ${name}` })).toBeVisible()
  await expect(row.getByRole('button', { name: `停用 ${name}` })).toHaveCount(0)
  await row.getByRole('button', { name: `更多 ${name}` }).click()
  await expect(page.getByRole('menu').getByRole('menuitem', { name: `刪除 ${name} 的個人資料` })).toBeVisible()
  await page.keyboard.press('Escape')

  await expect(page.getByTestId('page-title-actions').getByRole('button', { name: /^批次停用/ })).toBeVisible()
  await expect(page.getByRole('region', { name: '帳號' }).getByRole('button', { name: /^匯出全部篩選結果（1 筆）/ })).toBeVisible()

  // 不分搜尋時也只有停用的人（狀態欄全是「已停用」）。
  await page.goto('/dashboard/admin/accounts/disabled')
  const statuses = await page.getByRole('table', { name: '帳號列表' }).locator('tbody tr td:nth-child(8)').allInnerTexts()
  expect(statuses.length).toBeGreaterThan(0)
  for (const text of statuses) expect(text).toContain('已停用')
})

test('AC-C2-31：名單匯入分頁標題列「匯入名單」、歷次匯入、說明句寫自動開通', async ({ browser }) => {
  const page = await adminPage(browser)
  const response = await page.goto('/dashboard/admin/accounts/roster')
  expect(response?.status()).toBe(200)
  await expect(page.getByTestId('page-title-actions').getByRole('button', { name: /^匯入名單/ })).toBeVisible()
  await expect(page.getByRole('region', { name: '歷次匯入' })).toBeVisible()
  await expect(page.locator('main')).toContainText('自動開通')
  await expect(page.locator('details')).toHaveCount(0)
})

test('AC-C2-32：帳號列的屆別連到那一屆的分組總覽，組別連到那一組', async ({ browser }) => {
  const page = await adminPage(browser)
  await page.goto(`/dashboard/admin/accounts?q=${encodeURIComponent(people.grouped.name)}`)
  const row = rowOf(page, people.grouped.name)
  const cohortLink = row.getByRole('link', { name: new RegExp(cohortCode) })
  await expect(cohortLink).toHaveAttribute('href', `/dashboard/admin/groups?cohort=${cohortId}`)
  await expect(row.getByRole('link', { name: groupCode, exact: true })).toHaveAttribute('href', `/dashboard/admin/groups/${groupId}`)
  // 沒分組的人沒有組別連結。
  await page.goto(`/dashboard/admin/accounts/disabled?q=${encodeURIComponent(people.disabled.name)}`)
  await expect(rowOf(page, people.disabled.name).getByRole('link', { name: new RegExp(cohortCode) })).toBeVisible()
  await expect(rowOf(page, people.disabled.name).getByRole('link', { name: /^G\d+$/ })).toHaveCount(0)

  await page.goto(`/dashboard/admin/accounts?q=${encodeURIComponent(people.grouped.name)}`)
  await rowOf(page, people.grouped.name).getByRole('link', { name: new RegExp(cohortCode) }).click()
  await expect(page).toHaveURL(new RegExp(`/dashboard/admin/groups\\?cohort=${cohortId}$`))
})
