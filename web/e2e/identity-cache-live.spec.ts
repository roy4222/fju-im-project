import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import path from 'node:path'
import { expect, request as playwrightRequest, test, type APIRequestContext } from '@playwright/test'
import { Pool } from 'pg'
import { ADMIN_HOME } from './fingerprints'
import { createTestSession } from './session'

/**
 * SH-B1 身分快取在**真的 build＋start**（TTL 60）下的跨入口失效（Sol r1 P1）。
 *
 * 其他 e2e 都在 `IDENTITY_CACHE_TTL_SECONDS=0` 下跑，所以這個檔自己用同一份 build 另起一個 `next start`，
 * 帶 TTL 60、連同一個資料庫。要抓的是整合測試看不到的事：Next 把 Route Handler（`/api/auth/*`）與 RSC 頁面
 * 分開打包，模組變數各有一份——HTTP 登出清了 Route Handler 那份，頁面讀的那份還在，舊 cookie 照樣 200。
 *
 * - 暖管理頁（同一張 cookie 兩次 200）→ HTTP 登出／改密碼／重設密碼 → 同一張 cookie 下一次導 `/login`。
 * - 同名兩張 cookie、secure 與一般名稱混用：絕不拿到快取裡另一個人的管理頁。
 * - 先確認這台真的開著快取：直接改 DB 停用，暖過的 cookie 仍 200（Q189 接受的 60 秒延遲）。
 */

const ownerUrl = process.env.DATABASE_URL_OWNER
const PASSWORD = 'E2e-Password-Correct-9'
const COOKIE = 'better-auth.session_token'

let server: ChildProcess | undefined
let serverLog = ''
let baseUrl = ''
let api: APIRequestContext

async function owner<T>(fn: (pool: Pool) => Promise<T>): Promise<T> {
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER')
  const pool = new Pool({ connectionString: ownerUrl, max: 1 })
  try {
    return await fn(pool)
  } finally {
    await pool.end()
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('拿不到 port'))))
    })
  })
}

/** 只帶指定的 cookie、不跟轉址。 */
async function open(pathname: string, cookie: string) {
  const device = await playwrightRequest.newContext({ baseURL: baseUrl })
  try {
    const response = await device.get(pathname, { headers: { cookie }, maxRedirects: 0 })
    return { status: response.status(), location: response.headers()['location'] ?? '', body: await response.text() }
  } finally {
    await device.dispose()
  }
}

async function post(pathname: string, data: unknown, cookie?: string) {
  const device = await playwrightRequest.newContext({ baseURL: baseUrl })
  try {
    const response = await device.post(`/api/auth${pathname}`, {
      headers: { origin: baseUrl, 'x-real-ip': `10.251.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`, ...(cookie ? { cookie } : {}) },
      data,
    })
    return { status: response.status(), setCookie: response.headers()['set-cookie'] ?? '', body: await response.text() }
  } finally {
    await device.dispose()
  }
}

/** 暖快取：同一張 cookie 兩次都是管理頁。 */
async function warmAdmin(cookie: string) {
  for (let i = 0; i < 2; i += 1) {
    const page = await open('/dashboard/admin', cookie)
    expect(page.status).toBe(200)
    expect(page.body).toContain(ADMIN_HOME)
  }
}

async function expectSignedOut(cookie: string) {
  const page = await open('/dashboard/admin', cookie)
  expect([302, 303, 307, 308]).toContain(page.status)
  expect(page.location).toContain('/login')
  expect(page.body).not.toContain(ADMIN_HOME)
}

async function signIn(email: string, password = PASSWORD): Promise<string> {
  const response = await post('/sign-in/email', { email, password })
  expect(response.status, response.body).toBe(200)
  return response.setCookie.split(/,(?=[^;]+=)/)[0]!.split(';')[0]!
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  const port = await freePort()
  baseUrl = `http://127.0.0.1:${port}`
  // verify 與 CI 都在 web/ 下跑 playwright。
  const webDir = process.cwd()
  server = spawn(path.join(webDir, 'node_modules', '.bin', 'next'), ['start', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: webDir,
    env: { ...process.env, IDENTITY_CACHE_TTL_SECONDS: '60', MAIL_CAPTURE: '1', BASE_URL: baseUrl, BETTER_AUTH_URL: baseUrl },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  server.stdout?.on('data', (d: Buffer) => (serverLog += d.toString()))
  server.stderr?.on('data', (d: Buffer) => (serverLog += d.toString()))
  const deadline = Date.now() + 60_000
  for (;;) {
    if (server.exitCode !== null) throw new Error(`TTL 60 的 app 提早結束：\n${serverLog}`)
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) break
    } catch {
      // 還沒起來
    }
    if (Date.now() > deadline) throw new Error(`TTL 60 的 app 60 秒內沒起來：\n${serverLog}`)
    await new Promise((r) => setTimeout(r, 500))
  }
  // 註冊用的 context 會留著前一次的 cookie，帶 cookie 的 POST 套件要 Origin。
  api = await playwrightRequest.newContext({ baseURL: baseUrl, extraHTTPHeaders: { origin: baseUrl } })
})

test.afterAll(async () => {
  await api?.dispose()
  server?.kill('SIGTERM')
})

test('這台開著快取：暖過的 cookie 在直接改 DB 停用後仍 200（最多 60 秒延遲，Q189）', async () => {
  const admin = await createTestSession(api, 'admin')
  await warmAdmin(admin.cookie)
  await owner((pool) => pool.query(`update users set status = 'disabled' where id = $1`, [admin.userId]))
  expect((await open('/dashboard/admin', admin.cookie)).status).toBe(200)
  expect(serverLog).toContain('identity cache: ttl 60s')
})

test('HTTP 登出 → 同一張 cookie 下一次就導 /login（Route Handler 與頁面共用同一份快取）', async () => {
  const admin = await createTestSession(api, 'admin')
  await warmAdmin(admin.cookie)
  expect((await post('/sign-out', {}, admin.cookie)).status).toBe(200)
  const session = await open('/api/auth/get-session', admin.cookie)
  expect(session.body).toBe('null')
  await expectSignedOut(admin.cookie)
})

test('HTTP 改密碼 → 兩張暖過的 cookie 下一次都導 /login', async () => {
  const admin = await createTestSession(api, 'admin')
  const other = await signIn(admin.email)
  await warmAdmin(admin.cookie)
  await warmAdmin(other)
  const changed = await post('/change-password', { currentPassword: PASSWORD, newPassword: 'E2e-Password-Changed-9' }, admin.cookie)
  expect(changed.status, changed.body).toBe(200)
  await expectSignedOut(other)
  await expectSignedOut(admin.cookie)
})

test('HTTP 忘記密碼 → 重設密碼 → 暖過的舊 cookie 下一次導 /login', async () => {
  const admin = await createTestSession(api, 'admin')
  await warmAdmin(admin.cookie)
  expect((await post('/request-password-reset', { email: admin.email, redirectTo: '/reset-password' })).status).toBe(200)
  let body = ''
  for (let i = 0; i < 50 && !body; i += 1) {
    const rows = await owner((pool) =>
      pool.query<{ body_text: string | null }>(
        `select body_text from mail_outbox where to_email = $1 and template = 'password_reset' order by created_at desc limit 1`,
        [admin.email],
      ),
    )
    body = rows.rows[0]?.body_text ?? ''
    if (!body) await new Promise((r) => setTimeout(r, 100))
  }
  const token = decodeURIComponent(body.match(/token=([^。\s]+)/)![1]!)
  const reset = await post('/reset-password', { token, newPassword: 'E2e-Password-Reset-9' })
  expect(reset.status, reset.body).toBe(200)
  await expectSignedOut(admin.cookie)
})

test('cookie 有歧義（同名兩張、secure＋一般混用）：絕不拿到快取裡另一個人的管理頁', async () => {
  const admin = await createTestSession(api, 'admin')
  const student = await createTestSession(api, 'student')
  await warmAdmin(admin.cookie)
  expect((await open('/dashboard/student', student.cookie)).status).toBe(200)
  const adminValue = admin.cookie.slice(admin.cookie.indexOf('=') + 1)
  const adminSecure = `__Secure-${COOKIE}=${adminValue}`
  for (const cookie of [
    `${student.cookie}; ${admin.cookie}`,
    `${admin.cookie}; ${student.cookie}`,
    `${student.cookie}; ${adminSecure}`,
    `${adminSecure}; ${student.cookie}`,
  ]) {
    // 是誰由套件決定（`/get-session` 不經我們的快取）；頁面必須跟它一致，不能因為快取把暖過的管理員塞給這個請求。
    const session = JSON.parse((await open('/api/auth/get-session', cookie)).body) as { user?: { id?: string } } | null
    const page = await open('/dashboard/admin', cookie)
    const showsAdmin = page.status === 200 && page.body.includes(ADMIN_HOME)
    expect(showsAdmin, `${cookie.slice(0, 50)}…：套件認的是 ${session?.user?.id ?? '沒有人'}`).toBe(session?.user?.id === admin.userId)
  }
})
