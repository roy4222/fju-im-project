import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { expect, test, type BrowserContext } from '@playwright/test'
import { Pool } from 'pg'

/**
 * VB-3 GA4 `register_step`（AC-VI-78 的註冊段；B 設計方案 §7.3.1、總表第 8 節第 4 項）。
 *
 * 跟 `ga.spec.ts` 同一套作法：量測 ID 是執行期環境變數，所以這支自己另起一個 `next start`
 * （同一份 build、同一組環境，只多 `GA4_MEASUREMENT_ID=G-TEST`），送往 Google 的請求全部在瀏覽器端攔下記錄、回 204。
 * 走完三步：`ep.step` 依序 1、2、3、done；payload 不含 Email、姓名、學號。沒設 ID 的那一台（BASE_URL）零請求。
 *
 * 要擷取模式（`MAIL_CAPTURE=1`）：第 2 步的驗證碼從 `mail_outbox` 讀。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER
const GA_PORT = Number(process.env.GA_REGISTER_E2E_PORT ?? 3918)
const GA_URL = `${new URL(BASE_URL).protocol}//${new URL(BASE_URL).hostname}:${GA_PORT}`
const webRoot = path.join(import.meta.dirname, '..')
const run = Date.now().toString(36)
const PASSWORD = 'Ga-Register-Password-2026'

test.describe.configure({ mode: 'serial' })

let pool: Pool
let server: ChildProcess | undefined
let serverLog = ''

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

const steps = (c: Capture) => c.hits.filter((hit) => hit.en === 'register_step').map((hit) => hit['ep.step'] ?? hit['epn.step'])

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

async function latestOtp(email: string): Promise<string> {
  for (let i = 0; i < 50; i += 1) {
    const row = await pool.query<{ body_text: string | null }>(
      `select body_text from mail_outbox where to_email = $1 and template = 'email_otp' order by created_at desc limit 1`,
      [email],
    )
    const otp = /(\d{6})/.exec(row.rows[0]?.body_text ?? '')?.[1]
    if (otp) return otp
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`mail_outbox 沒有 ${email} 的驗證碼（e2e 要 MAIL_CAPTURE=1）`)
}

test.beforeAll(async () => {
  test.setTimeout(180_000)
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能讀 mail_outbox')
  pool = new Pool({ connectionString: ownerUrl, max: 1 })
  server = spawn(process.execPath, [path.join(webRoot, 'node_modules/next/dist/bin/next'), 'start', '-p', String(GA_PORT)], {
    cwd: webRoot,
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

test('AC-VI-78 register_step：走完三步，step 依序 1、2、3、done；不含 Email、姓名、學號', async ({ browser }) => {
  const email = `vb3-ga-${run}@example.com`
  const name = `GA測試${run}`
  const studentNo = `4${String(Date.now()).slice(-8)}`
  const context = await browser.newContext({ baseURL: GA_URL, extraHTTPHeaders: { 'x-real-ip': `10.232.${Date.now() % 200}.1` } })
  const c = await capture(context)
  const page = await context.newPage()

  await page.goto('/register')
  await expect.poll(() => steps(c), { timeout: 15_000 }).toEqual(['1'])
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByLabel('密碼', { exact: true }).fill(PASSWORD)
  await page.getByLabel('確認密碼').fill(PASSWORD)
  await page.getByRole('button', { name: '建立帳號' }).click()
  await expect(page).toHaveURL(/\/register\/verify$/)
  await expect.poll(() => steps(c), { timeout: 15_000 }).toEqual(['1', '2'])

  await page.getByLabel('驗證碼第 1 位').fill(await latestOtp(email))
  await expect(page).toHaveURL(/\/register\/apply$/)
  await expect.poll(() => steps(c), { timeout: 15_000 }).toEqual(['1', '2', '3'])

  await page.getByLabel('姓名').fill(name)
  await page.getByLabel('學號').fill(studentNo)
  await page.getByLabel('系級').fill('資管二甲')
  await page.getByLabel('手機').fill('0912-345-678')
  await page.getByRole('button', { name: '送出申請' }).click()
  await expect(page).toHaveURL(/\/register\/pending$/)
  // 離開頁面讓 GA 把排隊中的事件送出來。
  await page.goto('about:blank')
  await expect.poll(() => steps(c), { timeout: 15_000 }).toEqual(['1', '2', '3', 'done'])

  const all = c.raw.join('\n')
  for (const value of [email, name, studentNo, '0912-345-678']) {
    expect(all, value).not.toContain(value)
    expect(all, `${value}（編碼）`).not.toContain(encodeURIComponent(value))
  }
  // register_step 只帶 step 一個自訂參數。
  for (const hit of c.hits.filter((h) => h.en === 'register_step')) {
    expect(Object.keys(hit).filter((k) => /^epn?\./.test(k))).toEqual([hit['ep.step'] !== undefined ? 'ep.step' : 'epn.step'])
  }
  await context.close()
})

test('沒設 GA ID 的那一台：註冊第 1 步零請求、HTML 不含 googletagmanager', async ({ page }) => {
  const requests: string[] = []
  page.on('request', (request) => {
    if (GOOGLE.test(request.url())) requests.push(request.url())
  })
  const response = await page.goto(`${BASE_URL}/register`)
  expect(await response!.text()).not.toContain('googletagmanager')
  await page.waitForLoadState('networkidle')
  expect(requests).toEqual([])
})
