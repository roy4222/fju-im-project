import { expect, request as playwrightRequest, test, type APIResponse, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, sharedTestSession, toPlaywrightCookie, type TestSession } from './session'

/**
 * T13（設計方案 §14-1，N-21、N-26）：直接在瀏覽器打開附件網址。
 *
 * 1. 訪客帶 `sec-fetch-dest: document` → 303 到 `/login?next=%2Fapi%2Ffiles%2F<id>`、帶 no-store；
 *    同一個網址不帶標頭（程式抓取）→ 維持 401 JSON。
 * 2. 訪客用真的瀏覽器開 → 落在登入頁；用本屆學生登入 → 瀏覽器直接下載。
 * 3. 別屆學生與「公告下架後的本屆學生」→ 303 到 `/403`，兩個回應逐位元相同（不洩漏是哪一種）；
 *    瀏覽器落在中文的無權限頁。
 *
 * 公告用真的後台三步驟表單發布、真的下架按鈕下架；屆別與學生用 owner 連線直接插。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER
/** `createTestSession` 註冊時用的密碼（e2e/session.ts）。 */
const PASSWORD = 'E2e-Password-Correct-9'

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()
const CODE = `T13-${stamp}`
const PDF = Buffer.from('%PDF-1.4\n% e2e T13 附件\n')
const TITLE = `${CODE} 期中說明`
const DOCUMENT = { 'sec-fetch-dest': 'document' }

let pool: Pool
let cohortId: string
let student: TestSession
let outsider: TestSession
let itemId: string
let fileId: string

function ymd(date: Date): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}

async function newStudent(cohort: string, i: number): Promise<TestSession> {
  const context = await playwrightRequest.newContext({ baseURL: BASE_URL })
  const session = await createTestSession(context, 'student')
  await context.dispose()
  const studentNo = `413${String(Date.now()).slice(-5)}${i}`
  await pool.query(
    `insert into user_profiles (user_id, display_name, name_normalized, student_no, cohort_id, contact_email)
     values ($1, $2, $2, $3, $4, $5)
     on conflict (user_id) do update set student_no = excluded.student_no, cohort_id = excluded.cohort_id`,
    [session.userId, `附件學生${i}`, studentNo, cohort, `t13-${i}-${stamp.toLowerCase()}@contact.example.com`],
  )
  await pool.query('insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)', [
    cohort,
    studentNo,
    session.userId,
  ])
  return session
}

test.beforeAll(async () => {
  test.setTimeout(180_000)
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備與核對資料')
  pool = new Pool({ connectionString: ownerUrl, max: 2 })

  const now = new Date()
  const adminContext = await playwrightRequest.newContext({ baseURL: BASE_URL })
  const admin = await sharedTestSession(adminContext, 'admin')
  await adminContext.dispose()
  // 業務鐘拉回真實時間（別的 spec 可能把模擬鐘推到別處）。
  await pool.query(
    `insert into business_clock_overrides (id, environment, business_at, real_at, set_by_user_id, reason)
     values (gen_random_uuid(), 'staging', now(), now(), $1, 'e2e T13：回到真實時間')`,
    [admin.userId],
  )
  const insertCohort = async (code: string) =>
    String(
      (
        await pool.query<{ id: string }>(
          `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
           values (gen_random_uuid(), $1, $1, 'active', $2, 'system') returning id`,
          [code, ymd(new Date(now.getTime() + 300 * 86_400_000))],
        )
      ).rows[0]!.id,
    )
  cohortId = await insertCohort(CODE)
  const otherCohortId = await insertCohort(`${CODE}-X`)
  for (const [i, d] of [-10, 30, 90, 150].entries()) {
    await pool.query(
      `insert into cohort_stages (id, cohort_id, seq, name, start_date, created_by_kind)
       values (gen_random_uuid(), $1, $2, $3, $4, 'system')`,
      [cohortId, i + 1, ['成組期', '期中', '期末', '成果'][i], ymd(new Date(now.getTime() + d * 86_400_000))],
    )
  }
  student = await newStudent(cohortId, 1)
  outsider = await newStudent(otherCohortId, 9)
})

test.afterAll(async () => {
  await pool?.end()
})

async function asAdmin(page: Page) {
  await page.context().clearCookies()
  await page.context().addCookies([toPlaywrightCookie((await sharedTestSession(page.request, 'admin')).cookie, BASE_URL)])
}

/** 以某人身分（或訪客）抓附件，不跟著導向。 */
async function fetchFile(
  as: TestSession | null,
  headers: Record<string, string> = {},
  id: string = fileId,
): Promise<APIResponse> {
  const context = await playwrightRequest.newContext({ baseURL: BASE_URL })
  return context.get(`/api/files/${encodeURIComponent(id)}`, {
    headers: as ? { ...headers, cookie: as.cookie } : headers,
    maxRedirects: 0,
  })
}

/** 逐位元比對用：狀態、標頭、內容。`date` 與 CSP 的 nonce 每個請求都不同，拿掉與遮掉，其餘原樣比。 */
async function snapshot(response: APIResponse) {
  const headers = response.headers()
  delete headers['date']
  const csp = headers['content-security-policy']
  if (csp) headers['content-security-policy'] = csp.replace(/'nonce-[^']+'/g, "'nonce-*'")
  return { status: response.status(), headers, body: (await response.body()).toString('base64') }
}

test('系辦發布「本屆學生」公告並附 PDF', async ({ page }) => {
  await asAdmin(page)
  await page.goto(`/dashboard/admin/affairs?cohort=${cohortId}`)
  await page.getByRole('button', { name: '新增項目' }).click()
  const dialog = page.getByRole('dialog', { name: '新增項目' })
  await dialog.getByRole('radio', { name: /公告/ }).check()
  await dialog.getByLabel('標題').fill(TITLE)
  await dialog.getByLabel('發布對象').selectOption('cohort_students')
  await dialog.getByRole('button', { name: '下一步' }).click()
  await dialog.getByLabel('說明', { exact: true }).fill('<p>附件是說明會簡章。</p>')
  await dialog.locator('input[type=file]').setInputFiles({ name: '說明會簡章.pdf', mimeType: 'application/pdf', buffer: PDF })
  await expect(dialog.getByRole('link', { name: '說明會簡章.pdf' })).toBeVisible()
  await dialog.getByRole('button', { name: '下一步' }).click()
  await expect(dialog.getByRole('list', { name: '發布前檢查' })).toBeVisible()
  await expect(dialog.locator('[data-ok="no"]')).toHaveCount(0)
  await dialog.getByRole('button', { name: '發布', exact: true }).click()
  await expect(dialog.getByRole('status')).toContainText(`「${TITLE}」已發布`)

  itemId = (
    await pool.query<{ id: string }>('select id from managed_items where cohort_id = $1 and title = $2', [cohortId, TITLE])
  ).rows[0]!.id
  fileId = (await pool.query<{ file_id: string }>('select file_id from item_attachments where item_id = $1', [itemId])).rows[0]!
    .file_id
  // 本屆學生用程式抓得到（下面的「沒權限」才有意義）。
  expect((await fetchFile(student)).status()).toBe(200)
})

test('訪客直接開網址：303 到登入頁、帶 no-store；程式抓取同一個網址仍是 401 JSON', async () => {
  const navigation = await fetchFile(null, DOCUMENT)
  expect(navigation.status()).toBe(303)
  expect(navigation.headers()['location']).toBe(`/login?next=${encodeURIComponent(`/api/files/${fileId}`)}`)
  expect(navigation.headers()['cache-control']).toContain('no-store')
  expect(await navigation.body()).toHaveLength(0)

  // 只認 sec-fetch-dest: document：程式抓取（含只帶 Accept: text/html、沒有 sec-fetch-dest 的）
  // 與 <img>（sec-fetch-dest: image）都維持原本的 JSON。
  for (const headers of [
    {},
    { accept: 'text/html,application/xhtml+xml' },
    { 'sec-fetch-dest': 'image', accept: 'image/*,text/html' },
  ] as Record<string, string>[]) {
    const api = await fetchFile(null, headers)
    expect(api.status()).toBe(401)
    expect(api.headers()['cache-control']).toBe('private, no-store')
    expect(await api.json()).toMatchObject({ ok: false, code: 'UNAUTHENTICATED' })
  }
})

test('訪客在瀏覽器開附件網址 → 登入頁；用本屆學生登入後瀏覽器直接下載', async ({ page }) => {
  await page.context().clearCookies()
  await page.goto(`/api/files/${fileId}`)
  await expect(page).toHaveURL(new RegExp(`/login\\?next=${encodeURIComponent(`/api/files/${fileId}`)}$`))
  await expect(page.getByText('登入後會回到你原本要去的頁面。')).toBeVisible()

  const download = page.waitForEvent('download')
  const fileResponse = page.waitForResponse(
    (r) => r.url().includes(`/api/files/${fileId}`) && r.status() === 200 && /attachment/.test(r.headers()['content-disposition'] ?? ''),
  )
  await page.getByLabel('Email').fill(student.email)
  await page.getByLabel('密碼', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: '登入', exact: true }).click()
  expect((await download).suggestedFilename()).toBe('說明會簡章.pdf')
  expect((await fileResponse).headers()['content-disposition']).toContain('attachment')
})

test('沒權限與已下架：都 303 到 /403、回應逐位元相同；瀏覽器看到中文無權限頁', async ({ page }) => {
  const stranger = await fetchFile(outsider, DOCUMENT)
  expect(stranger.status()).toBe(303)
  expect(stranger.headers()['location']).toBe('/403')
  expect(stranger.headers()['cache-control']).toContain('no-store')
  // 檔案還在時「不是你的」的回應，留著跟下架後比。
  const strangerBefore = await snapshot(stranger)
  // 程式抓取仍是 403 JSON。
  const strangerApi = await fetchFile(outsider)
  expect(strangerApi.status()).toBe(403)
  expect(await strangerApi.json()).toMatchObject({ ok: false, code: 'FORBIDDEN' })

  await page.context().clearCookies()
  await page.context().addCookies([toPlaywrightCookie(outsider.cookie, BASE_URL)])
  await page.goto(`/api/files/${fileId}`)
  await expect(page).toHaveURL(/\/403$/)
  await expect(page.getByRole('link', { name: '回到自己的首頁' })).toBeVisible()

  // 系辦下架這則公告。
  await asAdmin(page)
  await page.goto(`/dashboard/admin/editor/${itemId}`)
  await page.getByRole('button', { name: '下架', exact: true }).click()
  await page.getByRole('dialog', { name: '下架這個項目？' }).getByRole('button', { name: '確認下架' }).click()
  await expect(page.getByTestId('item-status')).toHaveText('已下架')

  // 本屆學生再開：與下架前別屆學生拿到的回應一模一樣（不洩漏「已下架」與「不是你的」的差別）；
  // 不存在的 id、不是 UUID 的 id 也一樣。
  const archived = await fetchFile(student, DOCUMENT)
  expect(archived.headers()['location']).toBe('/403')
  expect(await snapshot(archived)).toEqual(strangerBefore)
  expect(await snapshot(await fetchFile(student, DOCUMENT, crypto.randomUUID()))).toEqual(strangerBefore)
  expect(await snapshot(await fetchFile(student, DOCUMENT, 'not-a-uuid'))).toEqual(strangerBefore)
})
