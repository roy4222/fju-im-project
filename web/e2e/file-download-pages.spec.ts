import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, request as playwrightRequest, test, type APIResponse, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { PUBLIC_IMAGE_MAX_AGE_SECONDS } from '../src/application/ops/files'
import { createItemInDialog, formReady, openAdvanced } from './create-item'
import { createTestSession, sharedTestSession, toPlaywrightCookie, type TestSession } from './session'

/**
 * T13（設計方案 §14-1，N-21、N-26）：直接在瀏覽器打開附件網址。
 *
 * 1. 訪客帶 `sec-fetch-dest: document` → 303 到 `/login?next=%2Fapi%2Ffiles%2F<id>`、帶 no-store；
 *    同一個網址不帶標頭（程式抓取）→ 維持 401 JSON。
 * 2. 訪客用真的瀏覽器開 → 落在登入頁；用本屆學生登入 → 瀏覽器直接下載。
 * 3. 別屆學生與「公告下架後的本屆學生」→ 303 到 `/403`，兩個回應逐位元相同（不洩漏是哪一種）；
 *    瀏覽器落在中文的「找不到這個頁面」（不說沒有權限）。
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
  // C1-06：清單「新增公告」→ 選類型 → 一頁式共用表單。
  await createItemInDialog(page, {
    kind: /公告/,
    title: TITLE,
    audience: 'cohort_students',
    html: '<p>附件是說明會簡章。</p>',
    file: { name: '說明會簡章.pdf', buffer: PDF },
  })

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

test('沒權限與已下架：都 303 到 /403、回應逐位元相同；瀏覽器看到中文「找不到這個頁面」', async ({ page }) => {
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
  await expect(page.getByRole('heading', { name: '找不到這個頁面' })).toBeVisible()
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

/**
 * V4（第 1 批訪客，設計方案 §3.4；AC-V18～V25、V35）：公開圖片讓瀏覽器快取，私有檔與非圖片檔絕不快取。
 *
 * 可快取＝訪客走同一條下載政策也放行（`publicRead`）**而且** `mime_detected` 是 PNG／JPEG。資料都走真的後台畫面建
 * （海報、公告封面與附件、首頁大圖都是真的上傳），每一步都用 API 抓回應標頭核對：
 * - 草稿海報、沒獎項的已發布海報、「本屆學生」公告的 PNG 附件、公開公告的 PDF 附件：`private, no-store`、沒有 ETag、
 *   帶 `If-None-Match` 也照樣 200；
 * - 有獎項的海報、公開公告的 PNG 封面、首頁現任大圖：`public, max-age=…, must-revalidate`＋強 ETag，帶 ETag 回 304；
 * - 下架、換圖之後帶舊 ETag：先授權再看 ETag，拿到 401／303，不是 304。
 * 304 與 HEAD 不漏檔案描述子：找出本機 app 程序（聽 BASE_URL 那個埠的程序），連打 50 次 304、20 次 HEAD 前後數它開著的檔。
 */
test.describe('V4 公開圖片可快取；私有檔與非圖片檔不快取', () => {
  const V4 = `${CODE}-V4`
  const PUBLIC_CACHE = `public, max-age=${PUBLIC_IMAGE_MAX_AGE_SECONDS}, must-revalidate`
  /** 1×1 的真 PNG（上傳收檔會看簽章，`mime_detected = image/png`）。 */
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')
  /**
   * 海報：真 PNG 後面補 512 KB（收檔只看簽章）。要大過串流一次讀的量：小檔一讀就到結尾、自己關檔，
   * 304 沒取消串流也看不出漏檔案描述子，AC-V19 的 fd 檢查就沒有意義。
   */
  const BIG_PNG = Buffer.concat([PNG, Buffer.alloc(512 * 1024)])
  /** 4×3 的真 PNG（首頁大圖）。 */
  const HERO = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAD0lEQVR4nGNgME5DIJwcAIc5By0Ywt6kAAAAAElFTkSuQmCC', 'base64')

  let posterId: string
  let coverId: string
  let publicPdfId: string
  let publicItemId: string

  async function storedFile(id: string) {
    const row = (
      await pool.query<{ checksum: string; mime_detected: string; storage_key: string }>(
        'select checksum, mime_detected, storage_key from stored_files where id = $1',
        [id],
      )
    ).rows[0]!
    return row
  }

  /** 可快取：200 全檔、公開快取標頭、強 ETag＝checksum；其他下載標頭照舊。 */
  async function expectPublic(response: APIResponse, id: string) {
    const { checksum } = await storedFile(id)
    const headers = response.headers()
    expect(response.status()).toBe(200)
    expect(headers['cache-control']).toBe(PUBLIC_CACHE)
    expect(headers['etag']).toBe(`"${checksum}"`)
    expect(headers['content-disposition']).toMatch(/^attachment;/)
    expect(headers['x-content-type-options']).toBe('nosniff')
    // CSP 與 c0f32bd 相同、跟私有下載同一套（V4 不動 CSP；AC-V18 依主腦 10/16 裁定在 A 改成這樣）。
    // 下載路由自己設的 `default-src 'none'; sandbox` 會被 `proxy.ts` 蓋成全站 CSP（改版前就是如此）；
    // 例外是預覽路由 `/api/files/<id>/preview`（A-06）：proxy 的 matcher 排除它，標頭由路由自己給（見檔尾的 A-06 區塊）。
    const privateCsp = (await fetchFile(null, {}, crypto.randomUUID())).headers()['content-security-policy']
    expect(headers['content-security-policy']?.replace(/'nonce-[^']+'/g, "'nonce-*'")).toBe(privateCsp?.replace(/'nonce-[^']+'/g, "'nonce-*'"))
    expect(headers['x-file-checksum-sha256']).toBe(checksum)
    expect(headers['content-length']).toBe(String((await response.body()).length))
  }

  /** 不可快取：`private, no-store`、沒有 ETag。 */
  function expectPrivate(response: APIResponse, status: number) {
    expect(response.status()).toBe(status)
    expect(response.headers()['cache-control']).toBe('private, no-store')
    expect(response.headers()['etag']).toBeUndefined()
  }

  /** 200 全檔但不可快取，帶 `If-None-Match` 也照樣 200 全檔（不看 ETag、不回 304）。 */
  async function expectPrivateDownload(as: TestSession | null, id: string) {
    const { checksum } = await storedFile(id)
    for (const headers of [{}, { 'if-none-match': `"${checksum}"` }] as Record<string, string>[]) {
      const response = await fetchFile(as, headers, id)
      expectPrivate(response, 200)
      expect(response.headers()['content-disposition']).toMatch(/^attachment;/)
      expect(response.headers()['x-content-type-options']).toBe('nosniff')
      expect(response.headers()['x-file-checksum-sha256']).toBe(checksum)
      expect((await response.body()).length).toBeGreaterThan(0)
    }
  }

  /** 全頁共用表單（C1-06）發布一則公告（可帶封面與附件），回項目 ID。封面在進階設定。 */
  async function publishItem(
    page: Page,
    input: { title: string; audience: 'public' | 'cohort_students'; cover?: Buffer; attachment?: { name: string; mimeType: string; buffer: Buffer } },
  ): Promise<string> {
    await asAdmin(page)
    await page.goto(`/dashboard/admin/editor/new?cohort=${cohortId}`)
    const form = await formReady(page)
    await form.locator('#ed-title').fill(input.title)
    await page.locator('#ed-body').fill('V4 快取標頭的測試公告。')
    await form.getByLabel('誰看得到').selectOption(input.audience)
    if (input.cover) {
      await openAdvanced(form)
      await form.locator('label', { hasText: '上傳封面' }).locator('input[type=file]').setInputFiles({ name: 'cover.png', mimeType: 'image/png', buffer: input.cover })
      await expect(form.getByRole('img', { name: '封面預覽' })).toBeVisible()
    }
    if (input.attachment) {
      await form.getByLabel('加入附件').setInputFiles(input.attachment)
      await expect(form.getByRole('list', { name: '附件' })).toContainText(input.attachment.name)
    }
    await form.getByRole('button', { name: '發布', exact: true }).click()
    await expect(page).toHaveURL(/\/dashboard\/admin\/affairs\?/)
    return (await pool.query<{ id: string }>('select id from managed_items where cohort_id = $1 and title = $2', [cohortId, input.title])).rows[0]!.id
  }

  test.beforeAll(async () => {
    await pool.query(
      `insert into groups (id, cohort_id, code, group_type, established_real_at, established_business_at, created_by_kind)
       values (gen_random_uuid(), $1, 'G01', 'general', now(), now(), 'system')`,
      [cohortId],
    )
  })

  test('AC-V24：草稿海報只在草稿上 → 系辦拿得到但不可快取；沒獎項的已發布海報 → 學生拿得到但不可快取、訪客 401', async ({ page }) => {
    await asAdmin(page)
    await page.goto(`/dashboard/admin/showcase?cohort=${cohortId}`)
    const create = page.getByRole('form', { name: '建立成果展示草稿' })
    await create.getByLabel('組別').selectOption({ label: 'G01' })
    await create.getByRole('button', { name: '建立草稿' }).click()
    await expect(create.getByRole('status')).toContainText('已替 G01 建立成果展示草稿')
    const g01 = page.getByTestId('showcase-draft').filter({ hasText: 'G01' })
    await g01.getByLabel('題目').fill(`${V4} 快取海報`)
    await g01.getByLabel('摘要').fill('V4 測試用的作品。')
    await g01.getByLabel('選擇海報圖檔').setInputFiles({ name: 'poster.png', mimeType: 'image/png', buffer: BIG_PNG })
    await expect(g01.getByTestId('poster-name')).toContainText('poster.png')
    await g01.getByRole('button', { name: '儲存草稿' }).click()
    await expect(g01.getByRole('status')).toContainText('G01 的成果展示草稿已儲存')

    const draft = (
      await pool.query<{ entry_id: string; poster_file_id: string }>(
        `select d.entry_id, d.poster_file_id from showcase_drafts d join showcase_entries e on e.id = d.entry_id where e.cohort_id = $1`,
        [cohortId],
      )
    ).rows[0]!
    posterId = draft.poster_file_id
    expect((await storedFile(posterId)).mime_detected).toBe('image/png')
    const admin = await sharedTestSession(page.request, 'admin')
    // 草稿海報 D：系辦 200 不可快取；訪客 401。
    await expectPrivateDownload(admin, posterId)
    expectPrivate(await fetchFile(null, {}, posterId), 401)

    // 發布（沒有獎項）→ 海報 U：登入的學生 200 不可快取；訪客 401。
    await g01.getByLabel(/已取得這組同學同意公開/).check()
    await g01.getByRole('button', { name: '發布', exact: true }).click()
    await expect(g01.getByRole('group', { name: '公開' }).getByRole('status')).toContainText('已發布（第 1 版）')
    expect(
      (await pool.query('select v.poster_file_id from showcase_entries e join showcase_versions v on v.id = e.current_version_id where e.id = $1', [draft.entry_id]))
        .rows[0]!.poster_file_id,
    ).toBe(posterId)
    await expectPrivateDownload(student, posterId)
    expectPrivate(await fetchFile(null, {}, posterId), 401)
  })

  test('AC-V18、V23：有獎項的已發布海報 → 訪客與學生都拿到公開快取標頭與 ETag', async ({ page }) => {
    await asAdmin(page)
    await page.goto(`/dashboard/admin/showcase?cohort=${cohortId}`)
    const awardForm = page.getByTestId('showcase-draft').filter({ hasText: 'G01' }).getByRole('form', { name: /的獎項/ })
    await awardForm.getByLabel('獎項等級').selectOption('excellent')
    await awardForm.getByLabel(/獎項名稱/).fill('V4 優秀專題')
    await awardForm.getByRole('button', { name: '儲存獎項' }).click()
    await expect(awardForm.getByRole('status')).toContainText('V4 優秀專題')

    await expectPublic(await fetchFile(null, {}, posterId), posterId)
    await expectPublic(await fetchFile(student, {}, posterId), posterId)
  })

  test('AC-V19：帶對的 ETag（含 W/ 與多值）回 304、沒有 body；帶錯的回 200 全檔；連打 50 次 304（＋20 次 HEAD）不漏檔案描述子', async () => {
    const { checksum, storage_key } = await storedFile(posterId)
    for (const ifNoneMatch of [`"${checksum}"`, `W/"${checksum}"`, `"x", "${checksum}"`]) {
      const response = await fetchFile(null, { 'if-none-match': ifNoneMatch }, posterId)
      expect(response.status(), ifNoneMatch).toBe(304)
      expect(response.headers()['cache-control']).toBe(PUBLIC_CACHE)
      expect(response.headers()['etag']).toBe(`"${checksum}"`)
      expect(response.headers()['content-length']).toBeUndefined()
      expect((await response.body()).length).toBe(0)
    }
    await expectPublic(await fetchFile(null, { 'if-none-match': '"not-this-one"' }, posterId), posterId)

    const pid = await serverPid()
    test.skip(pid === null, `找不到本機聽 ${BASE_URL} 的 app 程序（例如 app 在容器裡），fd 檢查只在本機 next start 上跑`)
    const before = await openFiles(pid!)
    const context = await playwrightRequest.newContext({ baseURL: BASE_URL })
    for (let i = 0; i < 50; i++) {
      const response = await context.get(`/api/files/${posterId}`, { headers: { 'if-none-match': `"${checksum}"` } })
      expect(response.status()).toBe(304)
    }
    // HEAD 也一樣（Next 拿 GET 回 HEAD）：只有標頭、不漏檔案描述子。
    for (let i = 0; i < 20; i++) {
      const response = await context.head(`/api/files/${posterId}`)
      expect(response.status()).toBe(200)
      expect(response.headers()['cache-control']).toBe(PUBLIC_CACHE)
    }
    await context.dispose()
    // 檔案描述子用 /proc/<pid>/fd 數（等同 `lsof -p <pid>`）：這張海報的本體一個都不該開著，開著的一般檔案總數也不增加。
    await expect.poll(async () => (await openFiles(pid!)).filter((f) => f.endsWith(storage_key)).length).toBe(0)
    const after = await openFiles(pid!)
    expect(after.length, `打之前 ${before.length} 個、之後 ${after.length} 個`).toBeLessThanOrEqual(before.length)
  })

  test('AC-V21、V35：公開公告的 PNG 封面可快取；同一則的 PDF 附件不可快取；下架後封面帶舊 ETag 是 401 不是 304', async ({ page }) => {
    publicItemId = await publishItem(page, {
      title: `${V4} 公開公告`,
      audience: 'public',
      cover: PNG,
      attachment: { name: '公開簡章.pdf', mimeType: 'application/pdf', buffer: PDF },
    })
    const item = (
      await pool.query<{ cover_file_id: string }>(
        'select v.cover_file_id from managed_items m join item_versions v on v.id = m.current_content_version_id where m.id = $1',
        [publicItemId],
      )
    ).rows[0]!
    coverId = item.cover_file_id
    publicPdfId = (await pool.query<{ file_id: string }>('select file_id from item_attachments where item_id = $1', [publicItemId])).rows[0]!.file_id
    expect((await storedFile(coverId)).mime_detected).toBe('image/png')
    expect((await storedFile(publicPdfId)).mime_detected).toBe('application/pdf')

    // AC-V35：訪客政策放行的 PDF，訪客與本屆學生各兩次（含帶 If-None-Match）都 200 全檔、不可快取。
    await expectPrivateDownload(null, publicPdfId)
    await expectPrivateDownload(student, publicPdfId)

    // AC-V21：封面公開可快取；系辦下架後訪客帶舊 ETag → 401（不是 304），系辦仍拿得到但不可快取。
    await expectPublic(await fetchFile(null, {}, coverId), coverId)
    const etag = (await fetchFile(null, {}, coverId)).headers()['etag']!
    await page.goto(`/dashboard/admin/editor/${publicItemId}`)
    await page.getByRole('button', { name: '下架', exact: true }).click()
    await page.getByRole('dialog', { name: '下架這個項目？' }).getByRole('button', { name: '確認下架' }).click()
    await expect(page.getByTestId('item-status')).toHaveText('已下架')
    for (const headers of [{}, { 'if-none-match': etag }] as Record<string, string>[]) expectPrivate(await fetchFile(null, headers, coverId), 401)
    const navigation = await fetchFile(null, { ...DOCUMENT, 'if-none-match': etag }, coverId)
    expect(navigation.status()).toBe(303)
    expect(navigation.headers()['cache-control']).toBe('private, no-store')
    await expectPrivateDownload(await sharedTestSession(page.request, 'admin'), coverId)
  })

  test('AC-V22：「本屆學生」公告的 PNG 附件 → 本屆學生拿得到但不可快取（是圖片也一樣）；訪客 401', async ({ page }) => {
    const itemId = await publishItem(page, {
      title: `${V4} 本屆學生公告`,
      audience: 'cohort_students',
      attachment: { name: '學生限定.png', mimeType: 'image/png', buffer: PNG },
    })
    const id = (await pool.query<{ file_id: string }>('select file_id from item_attachments where item_id = $1', [itemId])).rows[0]!.file_id
    expect((await storedFile(id)).mime_detected).toBe('image/png')
    await expectPrivateDownload(student, id)
    expectPrivate(await fetchFile(null, {}, id), 401)
  })

  test('AC-V20：首頁大圖換圖前公開可快取；換圖後舊圖帶 ETag 是 401、document 是 303，新圖公開', async ({ page }) => {
    // 首頁是全站共用的：只在前台編輯模式的「首頁橫幅」視窗上傳兩張圖（不按儲存，標語與說明都不動；C2-17 起首頁設定在前台改），
    // 用 owner 連線切 `hero_file_id`，結束一定切回原值，把跟 `front-edit-site-texts.spec` 重疊的時間壓到最短。
    // 前台編輯模式要新註冊的系辦用密碼從登入頁登入（`hooks.after` 設 `fju_office` 提示 cookie）。
    const api = await playwrightRequest.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { origin: new URL(BASE_URL).origin } })
    const editor = await createTestSession(api, 'admin')
    await api.dispose()
    await page.context().clearCookies()
    await page.goto('/login')
    await page.getByLabel('Email').fill(editor.email)
    await page.getByLabel('密碼', { exact: true }).fill(PASSWORD)
    await page.getByRole('button', { name: '登入', exact: true }).click()
    await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 })
    await page.goto('/')
    await page.getByRole('button', { name: '編輯頁面' }).click()
    const layer = page.getByTestId('front-edit-layer')
    const upload = async (name: string) => {
      await layer.getByRole('button', { name: '編輯「首頁橫幅」' }).click()
      const dialog = page.getByRole('dialog', { name: '編輯首頁橫幅' })
      await dialog.getByLabel('選擇首頁大圖').setInputFiles({ name, mimeType: 'image/png', buffer: HERO })
      await expect(dialog.getByTestId('hero-name')).toContainText(name)
      await dialog.getByRole('button', { name: '取消' }).click()
      await expect(dialog).toHaveCount(0)
      let id = ''
      await expect
        .poll(async () => {
          id = (await pool.query<{ id: string }>(`select id from stored_files where original_name = $1 and status = 'stored'`, [name])).rows[0]?.id ?? ''
          return id
        })
        .not.toBe('')
      return id
    }
    const f0 = await upload(`${V4}-hero-0.png`)
    const f1 = await upload(`${V4}-hero-1.png`)
    const admin = await sharedTestSession(page.request, 'admin')
    const original = (await pool.query<{ hero_file_id: string | null }>('select hero_file_id from home_settings where id = 1')).rows[0]
    const setHero = (id: string | null) =>
      pool.query(
        `insert into home_settings (id, hero_file_id, updated_by_user_id) values (1, $1, $2)
         on conflict (id) do update set hero_file_id = excluded.hero_file_id`,
        [id, admin.userId],
      )
    try {
      await setHero(f0)
      await expectPublic(await fetchFile(null, {}, f0), f0)
      const etag = (await fetchFile(null, {}, f0)).headers()['etag']!
      await setHero(f1)
      for (const headers of [{}, { 'if-none-match': etag }] as Record<string, string>[]) expectPrivate(await fetchFile(null, headers, f0), 401)
      const navigation = await fetchFile(null, { ...DOCUMENT, 'if-none-match': etag }, f0)
      expect(navigation.status()).toBe(303)
      expect(navigation.headers()['location']).toBe(`/login?next=${encodeURIComponent(`/api/files/${f0}`)}`)
      expect(navigation.headers()['cache-control']).toContain('no-store')
      await expectPublic(await fetchFile(null, {}, f1), f1)
    } finally {
      if (original) await pool.query('update home_settings set hero_file_id = $1 where id = 1', [original.hero_file_id])
      else await pool.query('delete from home_settings where id = 1')
    }
  })

  test('AC-V25：不存在的 UUID、不是 UUID：JSON 401／303 都 private, no-store、沒有 ETag', async () => {
    for (const id of [crypto.randomUUID(), 'not-a-uuid']) {
      const api = await fetchFile(null, {}, id)
      expectPrivate(api, 401)
      expect(await api.json()).toMatchObject({ ok: false, code: 'UNAUTHENTICATED' })
      const navigation = await fetchFile(null, DOCUMENT, id)
      expect(navigation.status()).toBe(303)
      expect(navigation.headers()['cache-control']).toBe('private, no-store')
      expect(navigation.headers()['etag']).toBeUndefined()
    }
  })
})

/**
 * A-06（B 設計方案 §5；AC-A-17～20、AC-A-47、AC-A-48、AC-TE-11B 標頭與拒絕段）：檔案預覽端點 `/api/files/<id>/preview`。
 *
 * 權限跟下載路由同一個函式：評分老師 T1（G03 的有效評分指派）拿得到、沒指派的老師 T2 跟下載同樣被拒、指派結束後再開也被拒。
 * 只有 PDF 與點陣圖 inline（`frame-ancestors 'self'`＋`SAMEORIGIN`）；docx 與內含 `<script>` 的 SVG 一律 302 回下載。
 * 全站頁面仍是 `frame-ancestors 'none'`＋`DENY`，`frame-src` 只多 `'self'`，同站頁面真的嵌得進預覽。
 *
 * 繳交版本與檔案列直接用 owner 連線建（繳交流程是別張票的事）；檔案本體寫進 app 的 `FILES_ROOT`。
 * 上傳收檔不收 SVG（類型白名單沒有它），所以「有人上傳了 SVG」只能這樣模擬：預覽看的是 `mime_detected`。
 * 結束指派用 owner 連線寫「移除評審」會寫的欄位（`valid_to`、`ended_*`、`removal_choice`、`reason`）；
 * 移除畫面本身在 grading-results.spec 驗，這裡要證的是「授權每次請求重算」。
 */
test.describe('A-06 檔案預覽端點：權限同下載、只內嵌 PDF／圖片、只讓本站嵌入', () => {
  const PREVIEW_PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n')
  const PREVIEW_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAD0lEQVR4nGNgME5DIJwcAIc5By0Ywt6kAAAAAElFTkSuQmCC', 'base64')
  const EVIL_SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>document.title="pwned"</script><rect width="10" height="10"/></svg>')
  const DOCX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(60)])
  const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  const files: Record<'pdf' | 'png' | 'svg' | 'docx', string> = { pdf: '', png: '', svg: '', docx: '' }
  let t1: TestSession
  let t2: TestSession
  let adminUserId: string
  let assignmentId: string

  async function fetchPreview(as: TestSession | null, headers: Record<string, string> = {}, id: string = files.pdf): Promise<APIResponse> {
    const context = await playwrightRequest.newContext({ baseURL: BASE_URL })
    return context.get(`/api/files/${encodeURIComponent(id)}/preview`, {
      headers: as ? { ...headers, cookie: as.cookie } : headers,
      maxRedirects: 0,
    })
  }

  /** 同一個請求打兩條路由：狀態、導向、快取標頭與內容都要相同（AC-A-47；proxy 加的全站標頭只在下載那條，不比）。 */
  async function expectSameDenial(as: TestSession | null, headers: Record<string, string>, id: string) {
    const [preview, download] = [await fetchPreview(as, headers, id), await fetchFile(as, headers, id)]
    expect(preview.status()).toBe(download.status())
    expect(preview.headers()['location']).toBe(download.headers()['location'])
    expect(preview.headers()['cache-control']).toBe('private, no-store')
    expect(download.headers()['cache-control']).toBe('private, no-store')
    expect(preview.headers()['content-disposition']).toBeUndefined()
    expect((await preview.body()).toString()).toBe((await download.body()).toString())
    return preview
  }

  test.beforeAll(async () => {
    test.setTimeout(120_000)
    const filesRoot = process.env.FILES_ROOT
    test.skip(!filesRoot, '要把檔案本體寫進 app 的 FILES_ROOT（verify 與 CI 都會設）')
    const fresh = async () => {
      const context = await playwrightRequest.newContext({ baseURL: BASE_URL })
      try {
        return await createTestSession(context, 'teacher')
      } finally {
        await context.dispose()
      }
    }
    t1 = await fresh()
    t2 = await fresh()
    const adminContext = await playwrightRequest.newContext({ baseURL: BASE_URL })
    adminUserId = (await sharedTestSession(adminContext, 'admin')).userId
    await adminContext.dispose()

    const groupId = (
      await pool.query<{ id: string }>(
        `insert into groups (id, cohort_id, code, group_type, established_real_at, established_business_at, created_by_kind)
         values (gen_random_uuid(), $1, 'G03', 'general', now(), now(), 'system') returning id`,
        [cohortId],
      )
    ).rows[0]!.id
    assignmentId = (
      await pool.query<{ id: string }>(
        `insert into evaluator_assignments (id, group_id, stage_key, teacher_user_id, valid_from, assigned_by_user_id)
         values (gen_random_uuid(), $1, 'mid', $2, now() - interval '1 hour', $3) returning id`,
        [groupId, t1.userId, adminUserId],
      )
    ).rows[0]!.id
    const itemRow = await pool.query<{ id: string }>(
      `insert into managed_items (id, cohort_id, placement, audience_kind, title, created_by_kind)
       values (gen_random_uuid(), $1, 'news', 'public', $2, 'system') returning id`,
      [cohortId, `${CODE} 期中報告繳交`],
    )
    // C 階段起評分老師只讀得到自己評分項目連到的作業（C1-02 §3.2）：把 mid 連到這份作業。
    await pool.query(
      `insert into grading_stage_settings (cohort_id, stage_key, item_id, updated_by_user_id) values ($1, 'mid', $2, $3)`,
      [cohortId, itemRow.rows[0]!.id, adminUserId],
    )
    const schema = await pool.query<{ id: string }>(
      `insert into form_schema_versions (id, item_id, version_no, schema, created_by_user_id) values (gen_random_uuid(), $1, 1, '{"fields":[]}'::jsonb, $2) returning id`,
      [itemRow.rows[0]!.id, adminUserId],
    )
    const versionId = (
      await pool.query<{ id: string }>(
        `insert into submission_versions
           (id, item_id, receiver_kind, receiver_id, version_no, schema_version_id, answers, submitted_by_user_id,
            received_real_at, received_business_at, request_id, membership_snapshot, deadline_version_at_submit)
         values (gen_random_uuid(), $1, 'group', $2, 1, $3, '{}'::jsonb, $4, now(), now(), gen_random_uuid(), '[]'::jsonb, 1) returning id`,
        [itemRow.rows[0]!.id, groupId, schema.rows[0]!.id, student.userId],
      )
    ).rows[0]!.id

    const put = async (field: keyof typeof files, name: string, mime: string, extension: string, bytes: Buffer) => {
      const id = crypto.randomUUID()
      const storageKey = `e2e-a06/${stamp}/${id}`
      await fs.mkdir(path.join(filesRoot!, path.dirname(storageKey)), { recursive: true })
      await fs.writeFile(path.join(filesRoot!, storageKey), bytes)
      const checksum = createHash('sha256').update(bytes).digest('hex')
      await pool.query(
        `insert into stored_files (id, owner_user_id, scope, cohort_id, purpose, original_name, size_bytes, mime_declared, mime_detected,
                                   extension, checksum, status, storage_key, uploaded_real_at, finalized_at)
         values ($1, $2, 'cohort', $3, 'submission', $4, $5, $6, $6, $7, $8, 'stored', $9, now(), now())`,
        [id, student.userId, cohortId, name, bytes.length, mime, extension, checksum, storageKey],
      )
      await pool.query(`insert into submission_files (submission_version_id, file_id, field_key, checksum) values ($1, $2, $3, $4)`, [
        versionId,
        id,
        field,
        checksum,
      ])
      await pool.query(`insert into file_references (id, file_id, ref_type, ref_id) values (gen_random_uuid(), $1, 'submission_version', $2)`, [
        id,
        versionId,
      ])
      files[field] = id
    }
    await put('pdf', '期中報告.pdf', 'application/pdf', 'pdf', PREVIEW_PDF)
    await put('png', '系統架構圖.png', 'image/png', 'png', PREVIEW_PNG)
    await put('svg', '流程圖.svg', 'image/svg+xml', 'svg', EVIL_SVG)
    await put('docx', '會議紀錄.docx', DOCX_MIME, 'docx', DOCX)
  })

  test('T1（G03 評分老師）預覽 PDF：200、inline、只讓本站嵌入、nosniff、不被 proxy 蓋成全站 CSP；下載仍是 attachment＋DENY', async () => {
    const response = await fetchPreview(t1)
    const headers = response.headers()
    expect(response.status()).toBe(200)
    expect(headers['content-type']).toBe('application/pdf')
    expect(headers['content-disposition']).toMatch(/^inline;/)
    expect(headers['content-disposition']).toContain(`filename*=UTF-8''${encodeURIComponent('期中報告.pdf')}`)
    expect(headers['x-frame-options']).toBe('SAMEORIGIN')
    expect(headers['x-content-type-options']).toBe('nosniff')
    // spike 結論：PDF 不加 sandbox（Chrome 在 iframe sandbox 屬性下顯示不了 PDF）；全站 CSP（nonce、frame-ancestors 'none'）沒蓋上來。
    expect(headers['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'self'")
    expect(headers['cache-control']).toBe('private, no-store')
    expect(await response.body()).toEqual(PREVIEW_PDF)

    const png = await fetchPreview(t1, {}, files.png)
    expect(png.status()).toBe(200)
    expect(png.headers()['content-disposition']).toMatch(/^inline;/)
    expect(png.headers()['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'self'; sandbox")
    expect(png.headers()['x-frame-options']).toBe('SAMEORIGIN')

    const download = await fetchFile(t1, {}, files.pdf)
    expect(download.status()).toBe(200)
    expect(download.headers()['content-disposition']).toMatch(/^attachment;/)
    expect(download.headers()['x-frame-options']).toBe('DENY')
    expect(download.headers()['content-security-policy']).toContain("frame-ancestors 'none'")
  })

  test('AC-A-17：未登入開預覽 → 跟下載同樣的 401 JSON；瀏覽器直接開導去登入頁、登入後回到預覽', async () => {
    for (const id of [files.pdf, crypto.randomUUID(), 'not-a-uuid']) {
      const api = await expectSameDenial(null, {}, id)
      expect(api.status()).toBe(401)
      expect(await api.json()).toMatchObject({ ok: false, code: 'UNAUTHENTICATED' })
      // iframe 裡被拒也是 JSON，不導頁。
      expect((await expectSameDenial(null, { 'sec-fetch-dest': 'iframe' }, id)).status()).toBe(401)
    }
    const navigation = await fetchPreview(null, DOCUMENT)
    expect(navigation.status()).toBe(303)
    expect(navigation.headers()['location']).toBe(`/login?next=${encodeURIComponent(`/api/files/${files.pdf}/preview`)}`)
    expect(navigation.headers()['cache-control']).toBe('private, no-store')
  })

  test('AC-A-18：docx 開預覽 → 302 到下載路由，跟著走最後是 attachment', async ({ page }) => {
    const response = await fetchPreview(t1, {}, files.docx)
    expect(response.status()).toBe(302)
    expect(response.headers()['location']).toBe(`/api/files/${files.docx}`)
    expect(response.headers()['content-disposition']).toBeUndefined()
    expect((await response.body()).length).toBe(0)

    // 跟著導向走要用瀏覽器的 cookie 罐：手動帶的 cookie 標頭不會跟到導向後的請求。
    await page.context().clearCookies()
    await page.context().addCookies([toPlaywrightCookie(t1.cookie, BASE_URL)])
    const followed = await page.request.get(`/api/files/${files.docx}/preview`)
    expect(followed.status()).toBe(200)
    expect(followed.url()).toBe(`${BASE_URL}/api/files/${files.docx}`)
    expect(followed.headers()['content-disposition']).toMatch(/^attachment;/)
    expect(followed.headers()['content-type']).toBe(DOCX_MIME)
  })

  test('AC-A-20：內含 <script> 的 SVG 開預覽 → 302 下載，不內嵌；瀏覽器開這個網址是下載、腳本沒有跑', async ({ page }) => {
    const response = await fetchPreview(t1, {}, files.svg)
    expect(response.status()).toBe(302)
    expect(response.headers()['location']).toBe(`/api/files/${files.svg}`)
    expect((await response.body()).length).toBe(0)

    await page.context().clearCookies()
    await page.context().addCookies([toPlaywrightCookie(t1.cookie, BASE_URL)])
    await page.goto('/dashboard/teacher/grading')
    const title = await page.title()
    const download = page.waitForEvent('download')
    await page.evaluate((url) => {
      window.location.href = url
    }, `/api/files/${files.svg}/preview`)
    expect((await download).suggestedFilename()).toBe('流程圖.svg')
    expect(await page.title()).toBe(title)
  })

  test('AC-A-19：頁面仍是 DENY＋frame-ancestors none、frame-src 多 self；同站頁面真的嵌得進預覽', async ({ page }) => {
    await page.context().clearCookies()
    for (const url of ['/', '/dashboard/teacher/grading']) {
      if (url !== '/') await page.context().addCookies([toPlaywrightCookie(t1.cookie, BASE_URL)])
      const response = await page.goto(url)
      const headers = response!.headers()
      expect(headers['x-frame-options'], url).toBe('DENY')
      expect(headers['content-security-policy'], url).toContain("frame-ancestors 'none'")
      expect(headers['content-security-policy'], url).toContain("frame-src 'self' https://www.youtube.com https://challenges.cloudflare.com;")
    }

    // 評分頁內嵌（A-07 會做成按鈕）：同站 iframe 載得到預覽的圖片，沒有被 frame-src／frame-ancestors 擋下。
    const violations: string[] = []
    page.on('console', (m) => {
      if (/Refused to (frame|display)/.test(m.text())) violations.push(m.text())
    })
    const embed = (src: string) =>
      page.evaluate((s) => {
        const frame = document.createElement('iframe')
        frame.src = s
        frame.title = s
        document.body.append(frame)
      }, src)
    const previewLoaded = page.waitForResponse((r) => r.url().endsWith(`/api/files/${files.png}/preview`))
    await embed(`/api/files/${files.png}/preview`)
    expect((await previewLoaded).status()).toBe(200)
    await expect
      .poll(async () => {
        const frame = page.frames().find((f) => f.url().endsWith(`/api/files/${files.png}/preview`))
        return frame ? frame.evaluate(() => document.querySelector('img')?.naturalWidth ?? 0) : -1
      })
      .toBe(4)
    expect(violations).toEqual([])
  })

  test('AC-A-47：沒有 G03 指派的老師 T2 開預覽 → 跟下載同一個結果（403／導 /403），沒有檔案內容', async () => {
    for (const id of [files.pdf, files.png, files.docx, files.svg]) {
      const api = await expectSameDenial(t2, {}, id)
      expect(api.status()).toBe(403)
      expect(await api.json()).toMatchObject({ ok: false, code: 'FORBIDDEN' })
      const navigation = await expectSameDenial(t2, DOCUMENT, id)
      expect(navigation.status()).toBe(303)
      expect(navigation.headers()['location']).toBe('/403')
    }
  })

  test('AC-A-48：T1 先預覽成功；指派結束後同一個 session 再開同一個網址 → 被拒（同下載），授權沒有快取', async ({ page }) => {
    await page.context().clearCookies()
    await page.context().addCookies([toPlaywrightCookie(t1.cookie, BASE_URL)])
    const url = `/api/files/${files.png}/preview`
    const before = await page.request.get(url, { maxRedirects: 0 })
    expect(before.status()).toBe(200)

    const ended = await pool.query(
      `update evaluator_assignments
          set valid_to = now(), ended_real_at = now(), ended_by_user_id = $2, removal_choice = 'keep', reason = 'e2e A-06：結束評分指派'
        where id = $1 and valid_to is null`,
      [assignmentId, adminUserId],
    )
    expect(ended.rowCount).toBe(1)

    const after = await page.request.get(url, { maxRedirects: 0 })
    expect(after.status()).toBe(403)
    expect(await after.json()).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect((await page.request.get(`/api/files/${files.png}`, { maxRedirects: 0 })).status()).toBe(403)
    await expectSameDenial(t1, {}, files.pdf)
  })
})

/**
 * 本機 app 程序：聽 BASE_URL 那個埠的程序（讀 /proc/net/tcp* 找 LISTEN 的 socket inode，再對 /proc/<pid>/fd）。
 * 也可以用 `E2E_SERVER_PID` 直接指定。不是 Linux、或 app 在容器裡（只看得到轉發的程序）就回 null。
 */
async function serverPid(): Promise<number | null> {
  if (process.env.E2E_SERVER_PID) return Number(process.env.E2E_SERVER_PID)
  const url = new URL(BASE_URL)
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
  const inodes = new Set<string>()
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    const text = await fs.readFile(table, 'utf8').catch(() => '')
    for (const line of text.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/)
      if (cols.length < 10 || cols[3] !== '0A') continue
      if (parseInt(cols[1]!.split(':')[1]!, 16) === port) inodes.add(cols[9]!)
    }
  }
  if (inodes.size === 0) return null
  for (const entry of await fs.readdir('/proc').catch(() => [] as string[])) {
    if (!/^\d+$/.test(entry)) continue
    const fds = await fs.readdir(`/proc/${entry}/fd`).catch(() => [] as string[])
    for (const fd of fds) {
      const link = await fs.readlink(`/proc/${entry}/fd/${fd}`).catch(() => '')
      const inode = /^socket:\[(\d+)\]$/.exec(link)?.[1]
      if (inode && inodes.has(inode)) {
        // 只認跑 node 的程序（Caddy 之類的轉發程序不算）。
        const cmdline = await fs.readFile(`/proc/${entry}/cmdline`, 'utf8').catch(() => '')
        return /node|next/.test(cmdline) ? Number(entry) : null
      }
    }
  }
  return null
}

/** 程序開著的一般檔案（不含 socket、pipe、/dev）。 */
async function openFiles(pid: number): Promise<string[]> {
  const links = await Promise.all(
    (await fs.readdir(`/proc/${pid}/fd`)).map((fd) => fs.readlink(`/proc/${pid}/fd/${fd}`).catch(() => '')),
  )
  return links.filter((l) => l.startsWith('/') && !l.startsWith('/dev/'))
}
