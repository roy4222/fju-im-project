import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { expect, request as playwrightRequest, test, type BrowserContext, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { sharedTestSession, toPlaywrightCookie } from './session'

/**
 * VB-8 GA4（AC-VI-68、AC-VI-69 的頁面段、AC-VI-78 的 `page_view`、`video_play` 段）。
 *
 * - 量測 ID 是**執行期**環境變數，CI 與測試站都沒有。所以設了 ID 的情境由這支自己另起一個
 *   `next start`（同一份 build、同一組環境，只多 `GA4_MEASUREMENT_ID=G-TEST`），主機名跟 BASE_URL 一樣，
 *   登入 cookie 兩邊通用（cookie 不分 port）。
 * - 真的 gtag.js 照常從 Google 載入（測的就是它實際送出什麼）；送出去的請求全部在瀏覽器端攔下、記錄、回 204，
 *   一個都不會真的到 Google。
 * - 沒設 ID 的情境直接打 BASE_URL 那一台（CI 的那一台本來就沒有 ID）。
 *
 * `register_step`（VB-3）、`login`／`forgot_password`（VB-4）各在自己的 spec，不在這裡。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER
const GA_PORT = Number(process.env.GA_E2E_PORT ?? 3917)
const GA_URL = `${new URL(BASE_URL).protocol}//${new URL(BASE_URL).hostname}:${GA_PORT}`
const webRoot = path.join(import.meta.dirname, '..')

test.describe.configure({ mode: 'serial' })

const stamp = `GA${Date.now().toString(36).toUpperCase()}`
const TITLE = `${stamp} 影片作品`

let pool: Pool
let entryId: string
let server: ChildProcess | undefined
let serverLog = ''

/** GA 會把同一批事件併成一個請求：網址帶共用欄位、body 每行一個事件。這裡攤平成「一個事件一筆」。 */
type Hit = Record<string, string>
type Capture = { raw: string[]; hits: Hit[] }

const GOOGLE = /^https:\/\/([a-z0-9-]+\.)*(google-analytics\.com|analytics\.google\.com|googletagmanager\.com)\//

async function capture(context: BrowserContext): Promise<Capture> {
  const result: Capture = { raw: [], hits: [] }
  await context.route(GOOGLE, async (route) => {
    const req = route.request()
    // 載入器本身放行（真的 gtag.js）；其餘一律記下來、不送出。
    if (/^https:\/\/www\.googletagmanager\.com\/gtag\/js\?/.test(req.url())) return route.continue()
    const body = req.postData() ?? ''
    result.raw.push(`${req.url()}\n${body}`)
    const shared = Object.fromEntries(new URL(req.url()).searchParams)
    const lines = body.split(/\r?\n/).filter(Boolean)
    for (const line of lines.length ? lines : ['']) {
      result.hits.push({ ...shared, ...Object.fromEntries(new URLSearchParams(line)) })
    }
    await route.fulfill({ status: 204, body: '' })
  })
  return result
}

const events = (c: Capture, name: string) => c.hits.filter((hit) => hit.en === name)

function watchCsp(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (message) => {
    if (/Content Security Policy/i.test(message.text())) errors.push(message.text())
  })
  return errors
}

async function waitForHealth(url: string) {
  for (let i = 0; i < 90; i += 1) {
    if (server?.exitCode != null) break
    try {
      if ((await fetch(`${url}/api/health`)).ok) return
    } catch {
      // 還沒起來
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(`G-TEST 的 next start 沒有起來（${url}）：\n${serverLog.slice(-2000)}`)
}

test.beforeAll(async () => {
  test.setTimeout(180_000)
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備資料')
  pool = new Pool({ connectionString: ownerUrl, max: 2 })

  // 一個已發布、有 YouTube 影片的作品（作品頁會嵌 iframe）。
  // 一個 request context 只註冊一個帳號：帶著前一個的 cookie 再註冊會被 Better Auth 的 Origin 檢查擋。
  const register = async (role: 'admin' | 'student') => {
    const context = await playwrightRequest.newContext({ baseURL: BASE_URL })
    try {
      return await sharedTestSession(context, role)
    } finally {
      await context.dispose()
    }
  }
  const admin = await register('admin')
  await register('student')
  const one = async (sql: string, params: unknown[]) => String((await pool.query(sql, params)).rows[0]!.id)
  const cohortId = await one(
    `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
     values (gen_random_uuid(), $1, $1, 'active', '2099-06-30', 'system') returning id`,
    [stamp],
  )
  const groupId = await one(
    `insert into groups (id, cohort_id, code, group_type, established_real_at, established_business_at, created_by_kind)
     values (gen_random_uuid(), $1, 'G01', 'general', now(), now(), 'system') returning id`,
    [cohortId],
  )
  entryId = await one(
    `insert into showcase_entries (id, cohort_id, group_id, status, created_by_user_id) values (gen_random_uuid(), $1, $2, 'draft', $3) returning id`,
    [cohortId, groupId, admin.userId],
  )
  await pool.query(
    `insert into showcase_drafts (entry_id, title, summary, summary_checksum, video_url)
     values ($1, $2, '影片作品摘要', encode(sha256(convert_to('影片作品摘要', 'UTF8')), 'hex'), 'https://youtu.be/dQw4w9WgXcQ')`,
    [entryId, TITLE],
  )
  const versionId = await one(
    `insert into showcase_versions (id, entry_id, version_no, title, summary, summary_checksum, video_url, authorization_kind,
                                    authorization_ref, pii_check, created_by_user_id, created_real_at)
     select gen_random_uuid(), entry_id, 1, title, summary, summary_checksum, video_url, 'external', gen_random_uuid(),
            '{"passed": true}'::jsonb, $2, now()
       from showcase_drafts where entry_id = $1 returning id`,
    [entryId, admin.userId],
  )
  await pool.query(`update showcase_entries set status = 'published', current_version_id = $2 where id = $1`, [entryId, versionId])

  server = spawn(process.execPath, [path.join(webRoot, 'node_modules/next/dist/bin/next'), 'start', '-p', String(GA_PORT)], {
    cwd: webRoot,
    // BETTER_AUTH_URL 指向這一台：同分頁登入、登出的案例要在這一台走真的登入表單。
    env: { ...process.env, GA4_MEASUREMENT_ID: 'G-TEST', PORT: String(GA_PORT), BETTER_AUTH_URL: GA_URL },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  server.stdout?.on('data', (chunk) => (serverLog += chunk))
  server.stderr?.on('data', (chunk) => (serverLog += chunk))
  await waitForHealth(GA_URL)
})

test.afterAll(async () => {
  server?.kill('SIGTERM')
  await pool?.end()
})

/** 所有攔到的內容串起來，個資一個字都不能出現（含 URL 編碼）。 */
function expectNoPii(c: Capture, forbidden: string[]) {
  const all = c.raw.join('\n')
  for (const value of forbidden) {
    expect(all, value).not.toContain(value)
    expect(all, `${value}（編碼）`).not.toContain(encodeURIComponent(value))
  }
}

/** 每個 page_view 的位置是來源＋路由名稱、referrer 空、標題是路由名稱；沒有 user_id。 */
function expectDeidentifiedPageViews(c: Capture) {
  for (const hit of c.hits) {
    expect(hit.uid, '不送 user_id').toBeUndefined()
    expect(hit['ep.user_id']).toBeUndefined()
    if (hit.dl !== undefined) expect(hit.dl).toMatch(new RegExp(`^${GA_URL.replace(/[.:/]/g, '\\$&')}/[a-z0-9/:()-]*$`))
    if (hit.dr !== undefined) expect(hit.dr).toBe('')
  }
  for (const hit of events(c, 'page_view')) {
    expect(hit.dl, 'page_view 帶 page_location').toBeDefined()
    expect(hit.dt, '標題是路由名稱').toBe(hit.dl!.slice(GA_URL.length))
  }
  // 增強型評估事件一個都沒有（只有我們自己送的事件，加上 GA 自己的 session／engagement 記號）。
  const names = new Set(c.hits.map((hit) => hit.en).filter(Boolean))
  for (const name of ['scroll', 'click', 'view_search_results', 'file_download', 'form_start', 'form_submit', 'video_start']) {
    expect(names.has(name), name).toBe(false)
  }
}

test('AC-VI-68 訪客：設了 ID 才載入；page_view 只送路由名稱、角色 guest，client navigation 也有自己的 page_view', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: GA_URL })
  const c = await capture(context)
  const page = await context.newPage()
  const cspErrors = watchCsp(page)

  const response = await page.goto('/')
  expect(await response!.text()).toContain('googletagmanager.com/gtag/js?id=G-TEST')
  const loader = page.locator('script[src^="https://www.googletagmanager.com/gtag/js?id=G-TEST"]')
  await expect(loader).toHaveCount(1)
  // 瀏覽器載入後會把 nonce 屬性藏起來，值只留在 property 上。
  expect(await loader.evaluate((el: HTMLScriptElement) => el.nonce?.length ?? 0)).toBeGreaterThan(0)
  await expect.poll(() => events(c, 'page_view').map((hit) => hit.dt), { timeout: 15_000 }).toContain('/')

  // client navigation（點連結，不重新載入）：/ → /news。
  await page.locator('a[href="/news"]:visible').first().click()
  await expect(page).toHaveURL(/\/news$/)
  await expect.poll(() => events(c, 'page_view').map((hit) => hit.dt), { timeout: 15_000 }).toContain('/news')

  await page.goto('/reset-password?token=TESTTOKEN123')
  await expect.poll(() => events(c, 'page_view').map((hit) => hit.dt), { timeout: 15_000 }).toContain('/reset-password')
  // 作品頁訪客看不到（進行中屆別要登入）會被導去登入頁：送的是導向後的 /login，不是作品頁。
  await page.goto(`/projects/${entryId}`)
  await expect.poll(() => events(c, 'page_view').map((hit) => hit.dt), { timeout: 15_000 }).toContain('/login')
  // 離開頁面讓 GA 把排隊中的事件送出來。
  await page.goto('about:blank')

  expect(c.hits.length).toBeGreaterThan(0)
  for (const hit of c.hits.filter((h) => h['up.role'] !== undefined)) expect(hit['up.role']).toBe('guest')
  expect(c.hits.some((hit) => hit['up.role'] === 'guest'), '至少一個請求帶角色').toBe(true)
  expectDeidentifiedPageViews(c)
  expectNoPii(c, ['TESTTOKEN123', 'token=', '?q=', entryId, TITLE])
  expect(cspErrors).toEqual([])
  await context.close()
})

test('AC-VI-68、AC-VI-78 學生：搜尋字不外流、角色 student；作品頁影片載入送 video_play，不帶作品或影片 ID', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: GA_URL })
  const student = await sharedTestSession(context.request, 'student')
  await context.addCookies([toPlaywrightCookie(student.cookie, GA_URL)])
  // 嵌入的 YouTube 播放器換成假的頁面（iframe 照樣觸發 load）。
  await context.route('https://www.youtube.com/embed/**', (route) => route.fulfill({ contentType: 'text/html', body: '<p>stub player</p>' }))
  const c = await capture(context)
  const page = await context.newPage()
  const cspErrors = watchCsp(page)

  const pageViews = () => events(c, 'page_view').length
  for (const q of ['王小明', 'wang@example.com', stamp]) {
    const before = pageViews()
    await page.goto(`/projects?q=${encodeURIComponent(q)}`)
    await expect.poll(pageViews, { timeout: 15_000 }).toBeGreaterThan(before)
  }
  await page.getByTestId('project-card').filter({ hasText: TITLE }).click()
  await expect(page).toHaveURL(new RegExp(`/projects/${entryId}$`))
  await expect(page.getByTestId('video-embed')).toHaveAttribute('src', 'https://www.youtube.com/embed/dQw4w9WgXcQ')

  await expect.poll(() => events(c, 'video_play').length, { timeout: 15_000 }).toBeGreaterThan(0)
  await expect.poll(() => events(c, 'page_view').map((hit) => hit.dt), { timeout: 15_000 }).toEqual(
    expect.arrayContaining(['/projects', '/projects/:id']),
  )
  await page.goto('/')
  await page.goto('about:blank')

  const video = events(c, 'video_play')[0]!
  console.log(`攔到的 video_play：${JSON.stringify(video)}`)
  expect(video.dl).toBe(`${GA_URL}/projects/:id`)
  expect(video.dt).toBe('/projects/:id')
  // 事件參數（ep.*／epn.*）只有去識別的頁面欄位，沒有任何作品或影片的值。
  const params = Object.keys(video).filter((key) => /^epn?\./.test(key))
  for (const key of params) expect(['ep.page_location', 'ep.page_referrer', 'ep.page_title'], key).toContain(key)

  for (const hit of c.hits.filter((h) => h['up.role'] !== undefined)) expect(hit['up.role']).toBe('student')
  expect(c.hits.some((hit) => hit['up.role'] === 'student')).toBe(true)
  expectDeidentifiedPageViews(c)
  expectNoPii(c, ['王小明', 'wang@example.com', '?q=', stamp, entryId, 'dQw4w9WgXcQ', student.email])
  expect(cspErrors).toEqual([])
  await context.close()
})

test('AC-VI-68 同分頁登入、登出（不整頁重載）：之後的 page_view 角色跟著變成 student、再回到 guest', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: GA_URL })
  const student = await sharedTestSession(context.request, 'student')
  const c = await capture(context)
  const page = await context.newPage()
  const roleViews = (role: string) => events(c, 'page_view').filter((hit) => hit['up.role'] === role)

  await page.goto('/')
  await expect.poll(() => roleViews('guest').length, { timeout: 15_000 }).toBeGreaterThan(0)
  // 整頁重載會把這個記號洗掉；最後還在就證明全程是 client navigation。
  await page.evaluate(() => ((window as unknown as { __sameDocument: boolean }).__sameDocument = true))

  await page.locator('a[href^="/login"]:visible').first().click()
  await expect(page).toHaveURL(/\/login/)
  await page.getByLabel('Email').fill(student.email)
  await page.getByLabel('密碼', { exact: true }).fill('E2e-Password-Correct-9')
  await page.getByRole('button', { name: '登入', exact: true }).click()
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 })
  await expect.poll(() => roleViews('student').length, { timeout: 15_000 }).toBeGreaterThan(0)
  const afterLogin = events(c, 'page_view').length

  await page.getByRole('button', { name: '帳號選單' }).click()
  await page.getByRole('menuitem', { name: '登出' }).click()
  await expect(page).toHaveURL(/\/login$/)
  await expect
    .poll(() => events(c, 'page_view').slice(afterLogin).map((hit) => hit['up.role']), { timeout: 15_000 })
    .toContain('guest')
  expect(await page.evaluate(() => (window as unknown as { __sameDocument?: boolean }).__sameDocument)).toBe(true)

  // 登入後送的 page_view 角色都是 student，登出後都是 guest；GA 的 dataLayer 也看得到兩次更新。
  const views = events(c, 'page_view')
  console.log(`登入／登出前後的 page_view：${JSON.stringify(views.map((hit) => [hit.dt, hit['up.role']]))}`)
  expect(views.slice(afterLogin).every((hit) => hit['up.role'] === 'guest')).toBe(true)
  const updates = await page.evaluate(() =>
    ((window as unknown as { dataLayer: IArguments[] }).dataLayer ?? [])
      .map((entry) => Array.from(entry))
      .filter((args) => args[0] === 'set' && args[1] === 'user_properties')
      .map((args) => (args[2] as { role: string }).role),
  )
  expect(updates).toEqual(expect.arrayContaining(['student', 'guest']))
  expectNoPii(c, [student.email])
  await context.close()
})

test('AC-VI-68 沒設 ID：HTML 沒有 googletagmanager，整趟沒有任何往 Google 分析的請求', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: BASE_URL })
  const requests: string[] = []
  context.on('request', (req) => {
    if (GOOGLE.test(req.url())) requests.push(req.url())
  })
  await context.route('https://www.youtube.com/embed/**', (route) => route.fulfill({ contentType: 'text/html', body: '<p>stub player</p>' }))
  const page = await context.newPage()

  for (const target of ['/', '/news', `/projects/${entryId}`, '/login']) {
    const response = await page.goto(target)
    expect((await response!.text()).match(/googletagmanager/g) ?? [], target).toEqual([])
  }
  await page.goto('/')
  await page.locator('a[href="/news"]:visible').first().click()
  await expect(page).toHaveURL(/\/news$/)
  await page.goto('about:blank')
  expect(requests).toEqual([])
  await context.close()
})
