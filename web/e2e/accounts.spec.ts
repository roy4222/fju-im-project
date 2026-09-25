import fs from 'node:fs/promises'
import { expect, test, type Browser, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, sharedTestSession, toPlaywrightCookie, type TestSession } from './session'

/**
 * 票 9：帳號列表、停用與匯出，用**真的畫面**走完「做完的樣子」四條。
 *
 * 1. 待審核／已核准／已停用三個磚；表格可搜尋、篩選、排序。
 * 2. 停用某人後，他在舊分頁做下一個動作就被登出；恢復後可再登入。
 * 3. 勾選部分或全選匯出 UTF-8 CSV（含系級、學號保留前導零）。
 * 4. 批次停用貼一行一個學號，先預覽再執行。
 * 另外：匯出每次重新授權——未登入 401、學生 403。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER
/** e2e/session.ts 造的帳號都用這個密碼。 */
const PASSWORD = 'E2e-Password-Correct-9'

test.describe.configure({ mode: 'serial' })

const run = Date.now().toString(36)
const cohortCode = `a${run}`.slice(0, 20)
/** 這一輪專用的學號（10 碼、前導零），避免跟別的測試或重跑撞號。 */
const prefix = String(Date.now()).slice(-6)
const tag = `帳號${prefix}`

type Student = TestSession & { name: string; studentNo: string }
const students: Student[] = []
let cohortId = ''

async function adminPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext()
  const page = await context.newPage()
  const session = await sharedTestSession(page.request, 'admin')
  await context.addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
  return page
}

function rowOf(page: Page, name: string) {
  return page.getByRole('table', { name: '帳號列表' }).getByRole('row').filter({ has: page.getByText(name, { exact: true }) })
}

async function searchFor(page: Page, q: string) {
  await page.goto(`/dashboard/admin/accounts?q=${encodeURIComponent(q)}`)
  await expect(page.getByRole('table', { name: '帳號列表' })).toBeVisible()
}

test.beforeAll(async ({ playwright }) => {
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能種學生資料')
  // Better Auth 對沒有 Origin 的請求一律拒絕；瀏覽器會自己帶，獨立的 request context 要手動帶。
  const request = await playwright.request.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { origin: new URL(BASE_URL).origin } })
  const pool = new Pool({ connectionString: ownerUrl, max: 1 })
  try {
    const cohort = await pool.query<{ id: string }>(
      `insert into cohorts (id, code, name, created_by_kind) values (gen_random_uuid(), $1, $2, 'system') returning id`,
      [cohortCode, `E2E 帳號測試屆 ${cohortCode}`],
    )
    cohortId = cohort.rows[0]!.id
    // 四個核准過的學生：真的註冊拿 session，再補上核准後才有的資料（審核畫面由 registration.spec 測）。
    for (let i = 1; i <= 4; i += 1) {
      const session = await createTestSession(request, 'student')
      const name = `${tag}-${i}`
      const studentNo = `0${prefix}00${i}`
      await pool.query(`update users set name = $2 where id = $1`, [session.userId, name])
      await pool.query(
        `insert into user_profiles (user_id, display_name, name_normalized, student_no, department_class, cohort_id, phone, contact_email)
         values ($1, $2, lower($2), $3, $4, $5, '0912-345-678', $6)`,
        [session.userId, name, studentNo, i % 2 === 1 ? '資管二甲' : '資管二乙', cohortId, session.email],
      )
      await pool.query(`insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)`, [cohortId, studentNo, session.userId])
      students.push({ ...session, name, studentNo })
    }
  } finally {
    await pool.end()
    await request.dispose()
  }
})

test('做完的樣子 1：三個磚、搜尋、篩選、排序', async ({ browser }) => {
  const page = await adminPage(browser)
  await page.goto('/dashboard/admin/accounts')
  for (const label of ['待審核', '已核准', '已停用']) {
    await expect(page.getByRole('link', { name: new RegExp(`^${label}`) })).toBeVisible()
  }

  // 搜尋姓名 → 只剩這一輪的四個人；搜尋學號 → 一個。
  await searchFor(page, tag)
  await expect(page.getByRole('table', { name: '帳號列表' }).getByRole('row')).toHaveCount(5)
  await searchFor(page, students[2]!.studentNo)
  await expect(rowOf(page, students[2]!.name)).toBeVisible()
  await expect(page.getByRole('table', { name: '帳號列表' }).getByRole('row')).toHaveCount(2)
  // 搜尋 Email。
  await searchFor(page, students[1]!.email)
  await expect(rowOf(page, students[1]!.name)).toBeVisible()
  // 每一列都掛著票 8 的「發臨時密碼」，打開就是這個人，不用再用 Email 查。
  await rowOf(page, students[1]!.name).getByRole('button', { name: `發臨時密碼給 ${students[1]!.name}` }).click()
  const temp = page.getByRole('dialog', { name: '發臨時密碼' })
  await expect(temp.getByRole('heading', { name: `發臨時密碼給 ${students[1]!.name}` })).toBeVisible()
  await page.keyboard.press('Escape')

  // 篩選：搜尋框（Enter 送出）＋角色、屆別、狀態三顆篩選鈕；條件都在網址上、互相保留。
  await page.goto('/dashboard/admin/accounts')
  const form = page.getByRole('search', { name: '篩選帳號' })
  await form.getByRole('searchbox', { name: '搜尋' }).fill(tag)
  await form.getByRole('searchbox', { name: '搜尋' }).press('Enter')
  await expect(page).toHaveURL(/q=/)
  await page.getByRole('button', { name: '篩選角色' }).click()
  await page.getByRole('menuitemradio', { name: '學生' }).click()
  await expect(page).toHaveURL(/role=student/)
  await page.getByRole('button', { name: '篩選屆別' }).click()
  await page.getByRole('menuitemradio', { name: new RegExp(cohortCode) }).click()
  await expect(page).toHaveURL(new RegExp(`cohort=${cohortId}`))
  await page.getByRole('button', { name: '篩選狀態' }).click()
  await page.getByRole('menuitemradio', { name: '已核准' }).click()
  await expect(page).toHaveURL(/status=active/)
  await expect(page).toHaveURL(/role=student/)
  await expect(page.getByRole('table', { name: '帳號列表' }).getByRole('row')).toHaveCount(5)

  // 排序：點「學號」升冪，再點一次降冪。
  await page.getByRole('link', { name: '依學號排序' }).click()
  await expect(page).toHaveURL(/sort=studentNo&dir=asc/)
  const names = () => page.getByRole('table', { name: '帳號列表' }).locator('tbody tr td:nth-child(2)').allInnerTexts()
  expect(await names()).toEqual(students.map((s) => s.name))
  await page.getByRole('link', { name: '依學號排序' }).click()
  await expect(page).toHaveURL(/sort=studentNo&dir=desc/)
  expect(await names()).toEqual(students.map((s) => s.name).reverse())
})

test('做完的樣子 2：停用後舊分頁下一個動作就被登出；恢復後可以再登入', async ({ browser }) => {
  const target = students[0]!
  // 學生的「舊分頁」：已經登入、開著學生首頁。
  const studentContext = await browser.newContext()
  await studentContext.addCookies([toPlaywrightCookie(target.cookie, BASE_URL)])
  const studentPage = await studentContext.newPage()
  await studentPage.goto('/dashboard/student')
  await expect(studentPage).toHaveURL(/\/dashboard\/student$/)

  const page = await adminPage(browser)
  await searchFor(page, target.name)
  await rowOf(page, target.name).getByRole('button', { name: `停用 ${target.name}` }).click()
  const dialog = page.getByRole('dialog', { name: `停用 ${target.name}` })
  await dialog.getByRole('button', { name: '確認停用' }).click()
  await expect(dialog.getByRole('alert')).toContainText('理由')
  await dialog.getByLabel(/理由/).fill('休學')
  await dialog.getByRole('button', { name: '確認停用' }).click()
  await expect(dialog.getByRole('status')).toContainText('已停用')
  await dialog.getByRole('button', { name: '關閉' }).click()
  await expect(rowOf(page, target.name)).toContainText('已停用')

  // 舊分頁做下一個動作（重新載入）→ 被帶去登入頁。
  await studentPage.reload()
  await expect(studentPage).toHaveURL(/\/login/)
  // 也不能再用密碼登入。
  await studentPage.getByLabel('Email').fill(target.email)
  await studentPage.getByLabel('密碼', { exact: true }).fill(PASSWORD)
  await studentPage.getByRole('button', { name: '登入', exact: true }).click()
  await expect(studentPage.getByRole('alert')).toBeVisible()
  await expect(studentPage).toHaveURL(/\/login/)

  // 恢復 → 可以再登入。
  await rowOf(page, target.name).getByRole('button', { name: `恢復 ${target.name}` }).click()
  const restore = page.getByRole('dialog', { name: `恢復 ${target.name}` })
  await restore.getByLabel(/理由/).fill('復學')
  await restore.getByRole('button', { name: '確認恢復' }).click()
  await expect(restore.getByRole('status')).toContainText('已恢復')
  await restore.getByRole('button', { name: '關閉' }).click()
  await expect(rowOf(page, target.name)).toContainText('已核准')

  await studentPage.goto('/login')
  await studentPage.getByLabel('Email').fill(target.email)
  await studentPage.getByLabel('密碼', { exact: true }).fill(PASSWORD)
  await studentPage.getByRole('button', { name: '登入', exact: true }).click()
  await studentPage.waitForURL(/\/dashboard\/student/, { timeout: 15_000 })
  await studentContext.close()
})

test('做完的樣子 3：勾選部分與全部篩選結果匯出 UTF-8 CSV，學號保留前導零、含系級', async ({ browser }) => {
  const page = await adminPage(browser)
  await searchFor(page, tag)

  await rowOf(page, students[1]!.name).getByRole('checkbox').check()
  await rowOf(page, students[2]!.name).getByRole('checkbox').check()
  await expect(page.getByTestId('selected-count')).toHaveText('已勾選 2 筆')

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '匯出勾選的 CSV' }).click()])
  expect(download.suggestedFilename()).toMatch(/^帳號名單-\d{8}-\d{4}\.csv$/)
  const bytes = await fs.readFile(await download.path())
  expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
  const lines = bytes.toString('utf8').slice(1).trimEnd().split('\r\n')
  expect(lines[0]).toBe('"姓名","學號","系級","屆別","手機","登入 Email","聯絡 Email","角色","狀態"')
  expect(lines).toHaveLength(3)
  const row2 = lines.find((l) => l.startsWith(`"${students[1]!.name}"`))!
  expect(row2).toContain(`"${students[1]!.studentNo}"`)
  expect(students[1]!.studentNo.startsWith('0')).toBe(true)
  expect(row2).toContain('"資管二乙"')
  expect(row2).toContain(`"${cohortCode}"`)
  expect(row2).toMatch(/"學生","已核准"$/)
  await expect(page.getByRole('status')).toContainText('已匯出 2 筆')

  // 全部篩選結果（不限分頁）：這一輪的四個人。
  const [all] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /匯出全部篩選結果（4 筆）/ }).click()])
  const text = (await fs.readFile(await all.path())).toString('utf8')
  expect(text.slice(1).trimEnd().split('\r\n')).toHaveLength(5)
})

test('匯出每次重新授權：未登入 401、學生 403', async ({ playwright, browser }) => {
  const anon = await playwright.request.newContext({ baseURL: BASE_URL })
  const body = { kind: 'filter', filter: {} }
  const anonResponse = await anon.post('/api/admin/accounts/export', { data: body, headers: { origin: new URL(BASE_URL).origin } })
  expect(anonResponse.status()).toBe(401)
  await anon.dispose()

  const context = await browser.newContext()
  const page = await context.newPage()
  const studentSession = await sharedTestSession(page.request, 'student')
  const response = await page.request.post('/api/admin/accounts/export', {
    data: body,
    headers: { origin: new URL(BASE_URL).origin, cookie: studentSession.cookie },
  })
  expect(response.status()).toBe(403)
  expect(response.headers()['content-type']).toContain('application/json')
  await context.close()
})

test('做完的樣子 4：批次停用貼學號，先預覽命中／已停用／找不到／重複再執行', async ({ browser }) => {
  const page = await adminPage(browser)
  // 先把 4 號單獨停用，好讓預覽裡有「已停用」。
  await searchFor(page, students[3]!.name)
  await rowOf(page, students[3]!.name).getByRole('button', { name: `停用 ${students[3]!.name}` }).click()
  const single = page.getByRole('dialog', { name: `停用 ${students[3]!.name}` })
  await single.getByLabel(/理由/).fill('先停')
  await single.getByRole('button', { name: '確認停用' }).click()
  await expect(single.getByRole('status')).toContainText('已停用')
  await single.getByRole('button', { name: '關閉' }).click()

  await searchFor(page, tag)
  await page.getByRole('button', { name: '批次停用（TXT）' }).click()
  const dialog = page.getByRole('dialog', { name: '批次停用' })
  // 格式不對：整份退件並指出行號。
  await dialog.getByLabel('或直接貼上學號').fill(`${students[1]!.studentNo},${students[1]!.name}`)
  await dialog.getByRole('button', { name: '預覽' }).click()
  await expect(dialog.getByRole('alert')).toContainText('第 1 行不是學號')

  const text = [students[1]!.studentNo, '', students[2]!.studentNo, students[3]!.studentNo, `9${prefix}999`, students[1]!.studentNo].join('\n')
  await dialog.getByLabel('或直接貼上學號').fill(text)
  await dialog.getByRole('button', { name: '預覽' }).click()
  await expect(dialog.getByTestId('bulk-hits')).toContainText('2')
  await expect(dialog.getByTestId('bulk-already')).toContainText('1')
  await expect(dialog.getByTestId('bulk-not-found')).toContainText('1')
  await expect(dialog.getByTestId('bulk-duplicates')).toContainText('1')
  await expect(dialog.getByRole('region', { name: '將停用' })).toContainText(students[1]!.name)

  await dialog.getByLabel(/理由/).fill('畢業')
  await dialog.getByRole('button', { name: '確認停用 2 個帳號' }).click()
  await expect(dialog.getByRole('status')).toContainText('2 個帳號')
  await dialog.getByRole('button', { name: '關閉' }).click()

  await expect(rowOf(page, students[1]!.name)).toContainText('已停用')
  await expect(rowOf(page, students[2]!.name)).toContainText('已停用')
  await expect(rowOf(page, students[0]!.name)).toContainText('已核准')
})
