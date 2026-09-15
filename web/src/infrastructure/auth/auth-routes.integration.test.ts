import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  assertTestDatabaseReachable,
  createIsolatedDatabase,
  TEST_DATABASE_URL,
  type IsolatedDatabase,
} from '../../../test/db'
import { migratedSchema } from '../../../test/migrations'
import { ALLOWED_ROUTES, BLOCKED_ROUTE_REASONS, routeAccess } from '@/infrastructure/auth/route-matrix'

/**
 * S01-02：把 Better Auth 掛上網站，並證明不該對外的入口真的打不進去。
 *
 * 這支跑的是**真的 Better Auth 實例**打**真的 PostgreSQL**（隔離 schema），
 * 請求是真的 `Request` 物件經真的 route handler，不是對著設定物件做斷言。
 *
 * 兩個「安裝後才做得到」的 gate 也在這裡（票 #45 第 4 節）：
 * (a) 實際 route table 與矩陣逐路由對照；
 * (b) `hooks.before` 在 server-only 呼叫時 `ctx.request` 不存在。
 */

const BASE_URL = 'http://127.0.0.1:3000'

let db: IsolatedDatabase
let handlers: typeof import('@/infrastructure/auth/wrapper').authRouteHandlers
let authInstance: ReturnType<typeof import('@/infrastructure/auth/auth-instance').getAuth>

beforeAll(async () => {
  await assertTestDatabaseReachable()
  db = await createIsolatedDatabase({ label: 'auth-routes', setup: migratedSchema })

  const url = new URL(TEST_DATABASE_URL)
  url.searchParams.set('options', `-c search_path=${db.schemaName}`)

  vi.resetModules()
  vi.stubEnv('DATABASE_URL', url.toString())
  vi.stubEnv('BETTER_AUTH_SECRET', 'integration-test-secret-integration-test')
  vi.stubEnv('BETTER_AUTH_URL', BASE_URL)
  vi.stubEnv('GOOGLE_CLIENT_ID', 'test-client-id')
  vi.stubEnv('GOOGLE_CLIENT_SECRET', 'test-client-secret')

  handlers = (await import('@/infrastructure/auth/wrapper')).authRouteHandlers
  authInstance = (await import('@/infrastructure/auth/auth-instance')).getAuth()
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await db?.close()
})

function request(method: 'GET' | 'POST', path: string, body?: unknown, headers: HeadersInit = {}): Request {
  return new Request(`${BASE_URL}/api/auth${path}`, {
    method,
    headers: { 'content-type': 'application/json', origin: BASE_URL, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

function call(method: 'GET' | 'POST', path: string, body?: unknown, headers?: HeadersInit): Promise<Response> {
  return handlers[method](request(method, path, body, headers))
}

async function sessionCount(email: string): Promise<number> {
  const rows = await db.sql(
    `select count(*)::int as n from sessions s join users u on u.id = s.user_id where u.email = $1`,
    [email],
  )
  return Number(rows.rows[0]!.n)
}

let signUpCounter = 0
async function signUp(): Promise<{ email: string; password: string; response: Response }> {
  signUpCounter += 1
  const email = `s01-02-${Date.now()}-${signUpCounter}@example.com`
  const password = 'Correct-Horse-Battery-9'
  const response = await call('POST', '/sign-up/email', { email, password, name: '測試使用者' })
  return { email, password, response }
}

// ── Gate (a)：安裝版本的實際 route table 與矩陣逐條對照 ──────────────────────

describe('gate (a)：實際 route table 覆核（票 #45、模組 01 §12）', () => {
  /** 從實例讀出這個版本真正掛了哪些端點。 */
  function installedRoutes(): { path: string; methods: string[] }[] {
    const rows: { path: string; methods: string[] }[] = []
    for (const endpoint of Object.values(authInstance.api) as unknown[]) {
      const ep = endpoint as { path?: string; options?: { method?: string | string[] } }
      if (typeof ep?.path !== 'string') continue
      const method = ep.options?.method
      rows.push({ path: ep.path, methods: Array.isArray(method) ? method : [String(method)] })
    }
    return rows.sort((a, b) => a.path.localeCompare(b.path))
  }

  it('每一條實際存在的路由都被矩陣分類到（多長出來的端點不會靜靜對外開）', () => {
    const unclassified: string[] = []
    for (const { path } of installedRoutes()) {
      const isAllowed = ALLOWED_ROUTES.some((r) => r.path === path)
      const hasReason = path in BLOCKED_ROUTE_REASONS
      if (!isAllowed && !hasReason) unclassified.push(path)
    }
    expect(
      unclassified,
      '這些端點在安裝版本裡存在，但 route-matrix.ts 沒有分類。它們現在是預設封鎖的（安全），' +
        '但請到 BLOCKED_ROUTE_REASONS 補上理由，或加進白名單。',
    ).toEqual([])
  })

  it('矩陣裡列的路徑都真的存在（避免照著舊文件擋一個不存在的端點）', () => {
    const installed = new Set(installedRoutes().map((r) => r.path))
    const missing: string[] = []
    for (const route of ALLOWED_ROUTES) if (!installed.has(route.path)) missing.push(`白名單 ${route.path}`)
    for (const path of Object.keys(BLOCKED_ROUTE_REASONS)) {
      // `/set-password` 在 1.7.5 的 route table 讀不到 path（端點物件沒帶），另行處理。
      if (path === '/set-password') continue
      if (!installed.has(path)) missing.push(`封鎖清單 ${path}`)
    }
    expect(missing).toEqual([])
  })

  it('白名單列的方法與實際端點宣告的方法一致（GET／POST 都對）', () => {
    const byPath = new Map(installedRoutes().map((r) => [r.path, r.methods]))
    const mismatched: string[] = []
    for (const route of ALLOWED_ROUTES) {
      const actual = byPath.get(route.path)
      if (!actual) continue
      for (const method of route.methods) {
        if (!actual.includes(method)) mismatched.push(`${route.path} 矩陣寫 ${method}，實際是 ${actual.join('|')}`)
      }
    }
    expect(mismatched).toEqual([])
  })

  it('每一條 admin 路由都被擋（GET 與 POST 都試）', () => {
    const adminPaths = installedRoutes()
      .map((r) => r.path)
      .filter((p) => p.startsWith('/admin/'))
    expect(adminPaths.length, '沒抓到任何 admin 路由，gate 失去意義').toBeGreaterThan(10)
    for (const path of adminPaths) {
      expect(routeAccess(path, 'GET'), `${path} GET 應該被擋`).toBe('blocked')
      expect(routeAccess(path, 'POST'), `${path} POST 應該被擋`).toBe('blocked')
    }
  })
})

// ── 真的打進去：封鎖路由 403、白名單路由可用 ────────────────────────────────

describe('封鎖路由對外一律 403', () => {
  const blockedSamples: [('GET' | 'POST'), string][] = [
    ['GET', '/admin/list-users'],
    ['POST', '/admin/list-users'],
    ['POST', '/admin/ban-user'],
    ['POST', '/admin/set-user-password'],
    ['POST', '/admin/impersonate-user'],
    ['POST', '/update-user'],
    ['POST', '/change-email'],
    ['POST', '/delete-user'],
    ['POST', '/unlink-account'],
    ['POST', '/request-password-reset'],
    ['POST', '/reset-password'],
    ['POST', '/send-verification-email'],
    ['GET', '/verify-email'],
    ['GET', '/list-sessions'],
    ['POST', '/revoke-other-sessions'],
    ['GET', '/account-info'],
  ]

  it.each(blockedSamples)('%s %s → 403', async (method, path) => {
    const response = await call(method, path, method === 'POST' ? {} : undefined)
    expect(response.status).toBe(403)
    const body = (await response.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('FORBIDDEN')
  })

  it('帶著真的登入 cookie 打 admin 路由，一樣 403（管理員身分也不行）', async () => {
    const { email, password } = await signUp()
    const signIn = await call('POST', '/sign-in/email', { email, password })
    expect(signIn.status).toBe(200)
    const cookie = signIn.headers.get('set-cookie') ?? ''
    expect(cookie).not.toBe('')

    // 這個帳號在 users.role 上直接標成 admin——就算是管理員，HTTP 入口也不開。
    await db.sql(`update users set role = 'admin', status = 'active' where email = $1`, [email])

    for (const [method, path] of [['GET', '/admin/list-users'], ['POST', '/admin/ban-user']] as const) {
      const response = await call(method, path, method === 'POST' ? { userId: 'x' } : undefined, { cookie })
      expect(response.status, `${method} ${path} 帶管理員 session 仍應 403`).toBe(403)
    }
  })

  it('第二層：繞過 wrapper 的白名單、直接打 auth.handler，hooks.before 照樣擋下', async () => {
    const response = await authInstance.handler(request('GET', '/admin/list-users'))
    expect(response.status).toBe(403)
    const body = (await response.json()) as { code?: string; message?: string }
    expect(body.code ?? body.message).toBeTruthy()
  })
})

// ── Gate (b)：server-only 呼叫時 ctx.request 不存在 ─────────────────────────

describe('gate (b)：hooks.before 在 server-only 呼叫時 ctx.request 不存在（票 #45）', () => {
  it('伺服器端直接呼叫被封鎖的端點，不會被「路由封鎖」擋下（代表 hook 看不到 request）', async () => {
    let thrown: unknown
    try {
      await authInstance.api.listUsers({ query: { limit: 1 }, headers: new Headers() })
    } catch (error) {
      thrown = error
    }
    // 一定會失敗（沒有 session），但**不能**是我們的路由封鎖訊息——
    // 那個訊息只在 ctx.request 存在時才會丟出來。
    expect(thrown, 'server-only 呼叫仍然應該因為沒有 session 而失敗').toBeDefined()
    expect(String((thrown as Error)?.message ?? thrown)).not.toContain('這個入口不對外開放')
  })

  it('對照組：同一個端點走 HTTP 就是被路由封鎖擋下', async () => {
    const response = await authInstance.handler(request('GET', '/admin/list-users'))
    expect(response.status).toBe(403)
    expect(await response.text()).toContain('這個入口不對外開放')
  })

  it('S01-03 之前的已知缺口：沒有 marker 的伺服器端呼叫還沒被擋（三向測試的第三向）', () => {
    // 這條刻意寫成文件式斷言，提醒 review：marker（AsyncLocalStorage）是 S01-03 的範圍，
    // 本票只做到「ctx.request 存在就擋」。S01-03 會把這一條改成真的拒絕。
    expect(routeAccess('/admin/list-users', 'GET')).toBe('blocked')
  })
})

// ── 白名單路由真的能用，而且三個 hook 有效 ──────────────────────────────────

describe('白名單路由與 hooks', () => {
  it('密碼註冊成功，而且帳號被強制標成 pending', async () => {
    const { email, response } = await signUp()
    expect(response.status).toBe(200)

    const row = await db.sql('select status, must_change_password, id from users where email = $1', [email])
    expect(row.rowCount).toBe(1)
    expect(row.rows[0]!.status).toBe('pending')
    expect(row.rows[0]!.must_change_password).toBe(false)

    // 註冊完套件直接建 session；契約 03 §2 允許 pending 持有受限 session，
    // 但業務動作的放行仍由 ActorResolver 判（S01-03）。
    expect(await sessionCount(email)).toBe(1)
  })

  it('新帳號的 id 是 uuidv7（版本位元是 7）', async () => {
    const { email } = await signUp()
    const row = await db.sql('select id::text as id from users where email = $1', [email])
    expect(String(row.rows[0]!.id)[14], 'uuid 第 15 個字元是版本號').toBe('7')
  })

  it('請求體裡偷帶 status=active 沒有用（input:false ＋ hook 兩層）', async () => {
    signUpCounter += 1
    const email = `s01-02-inject-${Date.now()}-${signUpCounter}@example.com`
    const response = await call('POST', '/sign-up/email', {
      email,
      password: 'Correct-Horse-Battery-9',
      name: '偷帶狀態',
      status: 'active',
      mustChangePassword: false,
    })
    expect(response.status).toBe(200)
    const row = await db.sql('select status from users where email = $1', [email])
    expect(row.rows[0]!.status).toBe('pending')
  })

  it('密碼登入建立的 session 記成 password', async () => {
    const { email, password } = await signUp()
    const signIn = await call('POST', '/sign-in/email', { email, password })
    expect(signIn.status).toBe(200)

    const rows = await db.sql(
      `select s.login_method from sessions s join users u on u.id = s.user_id where u.email = $1`,
      [email],
    )
    expect(rows.rowCount).toBeGreaterThan(0)
    for (const row of rows.rows) expect(row.login_method).toBe('password')
  })

  it('登出可用，被登出的那一筆 session 列不見了（其他裝置不受影響）', async () => {
    // 註冊本身就會建一筆 session（套件的行為：註冊完直接是登入狀態；
    // 這對 pending 帳號是可以的——契約 03 §2 寫 pending 也能取得受限 session）。
    const { email, password } = await signUp()
    const signIn = await call('POST', '/sign-in/email', { email, password })
    const cookie = signIn.headers.get('set-cookie') ?? ''

    const before = await sessionCount(email)
    expect(before, '註冊一筆 + 再登入一筆').toBe(2)

    const signOut = await call('POST', '/sign-out', {}, { cookie })
    expect(signOut.status).toBe(200)

    // 登出只撤自己這一條；另一條（註冊時建的）還在——撤全部是停用與改密用例的事。
    expect(await sessionCount(email)).toBe(1)
  })

  it('get-session 拿得到剛登入的 session', async () => {
    const { email, password } = await signUp()
    const signIn = await call('POST', '/sign-in/email', { email, password })
    const cookie = signIn.headers.get('set-cookie') ?? ''

    const session = await call('GET', '/get-session', undefined, { cookie })
    expect(session.status).toBe(200)
    const body = (await session.json()) as { user?: { email?: string; status?: string } } | null
    expect(body?.user?.email).toBe(email)
  })

  it('錯密碼登入失敗，而且沒有多出任何 session', async () => {
    const { email } = await signUp()
    const before = await sessionCount(email)

    const signIn = await call('POST', '/sign-in/email', { email, password: 'wrong-password-123' })
    expect(signIn.status).toBeGreaterThanOrEqual(400)
    expect(await sessionCount(email)).toBe(before)
  })
})

// ── 設定值（契約 03 §2、§3） ────────────────────────────────────────────────

describe('設定值', () => {
  it('fresh session 認定為 10 分鐘', () => {
    expect(authInstance.options.session?.freshAge).toBe(600)
  })

  it('cookie 快取關閉（停用要立刻生效）', () => {
    expect(authInstance.options.session?.cookieCache?.enabled).toBe(false)
  })

  it('關掉同 Email 的隱含帳號合併', () => {
    expect(authInstance.options.account?.accountLinking?.disableImplicitLinking).toBe(true)
  })

  it('主鍵由應用產生（uuidv7），不是套件預設', () => {
    const generate = authInstance.options.advanced?.database?.generateId
    expect(typeof generate).toBe('function')
  })
})
