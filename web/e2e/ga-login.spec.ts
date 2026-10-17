import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { expect, request as playwrightRequest, test, type BrowserContext } from '@playwright/test'
import { createTestSession, type TestSession } from './session'

/**
 * VB-4 的 GA4 事件（B 設計方案 §7.3.1；AC-VI-78 的 `login`、`forgot_password` 段，▶R2-2）。
 *
 * - 跟 `ga.spec.ts` 同一個作法：另起一個 `next start`（同一份 build，只多 `GA4_MEASUREMENT_ID=G-TEST`），
 *   真的 gtag.js 照常載入，往 Google 分析的請求全部在瀏覽器端攔下、記錄、回 204。
 * - `login`：密碼登入成功時 Server Action 寫一次性 cookie `fju_ga_login=password`，前台 `page-view.tsx`
 *   讀到就清掉、送一次。Google 那一段（VB-5）由 `google-oauth.integration.test.ts` 驗 Set-Cookie。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const GA_PORT = Number(process.env.GA_LOGIN_E2E_PORT ?? 3918)
const GA_URL = `${new URL(BASE_URL).protocol}//${new URL(BASE_URL).hostname}:${GA_PORT}`
const webRoot = path.join(import.meta.dirname, '..')
const PASSWORD = 'E2e-Password-Correct-9'

test.describe.configure({ mode: 'serial' })

let server: ChildProcess | undefined
let serverLog = ''
let student: TestSession

type Hit = Record<string, string>
type Capture = { raw: string[]; hits: Hit[] }

const GOOGLE = /^https:\/\/([a-z0-9-]+\.)*(google-analytics\.com|analytics\.google\.com|googletagmanager\.com)\//

async function capture(context: BrowserContext): Promise<Capture> {
  const result: Capture = { raw: [], hits: [] }
  await context.route(GOOGLE, async (route) => {
    const req = route.request()
    if (/^https:\/\/www\.googletagmanager\.com\/gtag\/js\?/.test(req.url())) return route.continue()
    const body = req.postData() ?? ''
    result.raw.push(`${req.url()}\n${body}`)
    const shared = Object.fromEntries(new URL(req.url()).searchParams)
    const lines = body.split('\n').filter(Boolean)
    for (const line of lines.length ? lines : ['']) {
      result.hits.push({ ...shared, ...Object.fromEntries(new URLSearchParams(line)) })
    }
    await route.fulfill({ status: 204, body: '' })
  })
  return result
}

const events = (c: Capture, name: string) => c.hits.filter((hit) => hit.en === name)

let ipCounter = 0
function uniqueIp(): string {
  ipCounter += 1
  return `10.254.${Math.floor(Math.random() * 250)}.${(ipCounter % 250) + 1}`
}

async function newContext(browser: import('@playwright/test').Browser) {
  return browser.newContext({ baseURL: GA_URL, extraHTTPHeaders: { 'x-real-ip': uniqueIp() } })
}

function expectNoPii(c: Capture, forbidden: string[]) {
  const all = c.raw.join('\n')
  for (const value of forbidden) {
    expect(all, value).not.toContain(value)
    expect(all, `${value}（編碼）`).not.toContain(encodeURIComponent(value))
  }
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
  const api = await playwrightRequest.newContext({ baseURL: BASE_URL })
  try {
    student = await createTestSession(api, 'student')
  } finally {
    await api.dispose()
  }
  server = spawn(process.execPath, [path.join(webRoot, 'node_modules/next/dist/bin/next'), 'start', '-p', String(GA_PORT)], {
    cwd: webRoot,
    env: { ...process.env, GA4_MEASUREMENT_ID: 'G-TEST', PORT: String(GA_PORT), BETTER_AUTH_URL: GA_URL },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  server.stdout?.on('data', (chunk) => (serverLog += chunk))
  server.stderr?.on('data', (chunk) => (serverLog += chunk))
  await waitForHealth(GA_URL)
})

test.afterAll(() => {
  server?.kill('SIGTERM')
})

test('AC-VI-78 login (a)(d)：首頁 client navigation 到 /login、密碼登入 → 只送一次 login（method=password），送完 cookie 已清', async ({ browser }) => {
  const context = await newContext(browser)
  const c = await capture(context)
  const page = await context.newPage()

  await page.goto('/')
  await expect.poll(() => events(c, 'page_view').length, { timeout: 15_000 }).toBeGreaterThan(0)
  await page.evaluate(() => ((window as unknown as { __same: boolean }).__same = true))
  await page.locator('a[href^="/login"]:visible').first().click()
  await expect(page).toHaveURL(/\/login/)
  // 到登入頁是 client navigation（document.referrer 不會更新，這就是不用 referrer 推測的原因）。
  expect(await page.evaluate(() => (window as unknown as { __same?: boolean }).__same)).toBe(true)
  await page.getByLabel('Email').fill(student.email)
  await page.getByLabel('密碼', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: '登入', exact: true }).click()
  await expect(page).toHaveURL(/\/dashboard\/student/, { timeout: 15_000 })

  await expect.poll(() => events(c, 'login').length, { timeout: 15_000 }).toBe(1)
  expect(events(c, 'login')[0]!['ep.method']).toBe('password')
  // (d) 讀到就清：瀏覽器裡已經沒有這個 cookie（HttpOnly 的話 document.cookie 本來就看不到，所以也查 cookie jar）。
  expect(await page.evaluate(() => document.cookie)).not.toContain('fju_ga_login')
  expect((await context.cookies()).map((cookie) => cookie.name)).not.toContain('fju_ga_login')

  // 之後的導頁不再送 login。
  const viewsBefore = events(c, 'page_view').length
  await page.goto('/news')
  await page.goto('/rules')
  await expect.poll(() => events(c, 'page_view').length, { timeout: 15_000 }).toBeGreaterThan(viewsBefore + 1)
  expect(events(c, 'login')).toHaveLength(1)
  expectNoPii(c, [student.email])
  await context.close()
})

test('AC-VI-78 login (b)：密碼錯 → 零次 login、沒有寫 cookie', async ({ browser }) => {
  const context = await newContext(browser)
  const c = await capture(context)
  const page = await context.newPage()
  await page.goto('/login')
  await expect.poll(() => events(c, 'page_view').length, { timeout: 15_000 }).toBeGreaterThan(0)
  await page.getByLabel('Email').fill(student.email)
  await page.getByLabel('密碼', { exact: true }).fill('Wrong-Password-000')
  await page.getByRole('button', { name: '登入', exact: true }).click()
  await expect(page.getByTestId('login-card').getByRole('alert')).toHaveText('Email 或密碼不正確。')
  expect((await context.cookies()).map((cookie) => cookie.name)).not.toContain('fju_ga_login')
  // 再換一頁讓 page-view 有機會讀 cookie：仍然零次。
  await page.goto('/')
  await expect.poll(() => events(c, 'page_view').length, { timeout: 15_000 }).toBeGreaterThan(1)
  expect(events(c, 'login')).toEqual([])
  await context.close()
})

test('AC-VI-78 forgot_password：登入卡按「忘記密碼？」送一次 forgot_password，沒有個資', async ({ browser }) => {
  const context = await newContext(browser)
  const c = await capture(context)
  const page = await context.newPage()
  await page.goto('/login')
  await expect.poll(() => events(c, 'page_view').length, { timeout: 15_000 }).toBeGreaterThan(0)
  await page.getByLabel('Email').fill(student.email)
  await page.getByTestId('login-card').locator('a[href="/forgot-password"]').click()
  await expect(page).toHaveURL(/\/login\?mode=forgot$/)
  await expect.poll(() => events(c, 'forgot_password').length, { timeout: 15_000 }).toBe(1)
  const [hit] = events(c, 'forgot_password')
  expect(Object.keys(hit!).filter((key) => key.startsWith('ep.'))).toEqual([])
  expectNoPii(c, [student.email])
  await context.close()
})
