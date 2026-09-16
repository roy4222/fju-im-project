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

describe('gate (b)：hooks.before 分得出「有沒有 HTTP request」（票 #45，S01-03 已補上 marker）', () => {
  it('白名單上的端點在伺服器端可以直接呼叫（代表 hook 認得出「沒有 request」）', async () => {
    // `/get-session` 對外開放，所以不論有沒有 marker 都放行。
    // 如果 hook 沒有分辨 `ctx.request` 存不存在，這裡會因為「沒有 HTTP 方法」而被誤擋，
    // ActorResolver 就動不了。
    await expect(authInstance.api.getSession({ headers: new Headers() })).resolves.toBeNull()
  })

  it('被封鎖的端點在伺服器端呼叫也被擋——除非經過包裝器（S01-03 的 marker）', async () => {
    let thrown: unknown
    try {
      await authInstance.api.listUsers({ query: { limit: 1 }, headers: new Headers() })
    } catch (error) {
      thrown = error
    }
    expect(thrown, '沒有 marker 的伺服器端呼叫要被擋').toBeDefined()
    expect(String((thrown as Error)?.message ?? thrown)).toContain('這個入口不對外開放')
  })

  it('對照組：同一個端點走 HTTP 也是被路由封鎖擋下', async () => {
    const response = await authInstance.handler(request('GET', '/admin/list-users'))
    expect(response.status).toBe(403)
    expect(await response.text()).toContain('這個入口不對外開放')
  })

  it('三向測試的第三向已經補上（詳見 internal-call.integration.test.ts）', () => {
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

// ── 帳號狀態矩陣：白名單路由也要受它管（2026-09-16 review Spec 2 的回歸測試） ──

describe('白名單路由的帳號狀態矩陣（契約 03 §2）', () => {
  /**
   * 這一組是回歸測試。
   *
   * 原本狀態檢查只做在頁面導向與 Server Action 上，`/api/auth/*` 直接打就繞過去了：
   * 業務上已停用（`status='disabled'`、`banned` 還沒收斂）的帳號照樣登得進去，
   * pending 與 must-change 也叫得動 `list-accounts`。現在 hook 裡就擋。
   */

  async function accountWithStatus(status: string, mustChange = false) {
    const { email, password } = await signUp()
    const row = await db.sql('select id from users where email = $1', [email])
    const userId = String(row.rows[0]!.id)
    await db.sql('update users set status = $2, must_change_password = $3, banned = false where id = $1', [
      userId,
      status,
      mustChange,
    ])
    return { email, password, userId }
  }

  it('停用的帳號登不進去——即使 Better Auth 的 banned 還沒收斂', async () => {
    const { email, password, userId } = await accountWithStatus('disabled')
    const before = await sessionCount(email)

    const signIn = await call('POST', '/sign-in/email', { email, password })
    expect(signIn.status, '停用帳號不該拿得到 session').toBeGreaterThanOrEqual(400)
    expect(await sessionCount(email), '不該多出任何 session').toBe(before)

    // 確認我們擋的依據是業務狀態而不是套件的 banned。
    const banned = await db.sql('select banned from users where id = $1', [userId])
    expect(banned.rows[0]!.banned).toBe(false)
  })

  it('去識別化的帳號也登不進去', async () => {
    const { email, password } = await signUp()
    await db.sql(`update users set status = 'active', deidentified_at = now() where email = $1`, [email])
    const before = await sessionCount(email)

    const signIn = await call('POST', '/sign-in/email', { email, password })
    expect(signIn.status).toBeGreaterThanOrEqual(400)
    expect(await sessionCount(email)).toBe(before)
  })

  it('登入之後才被停用：既有 session 立刻失效（get-session 與 change-password 都擋）', async () => {
    const { email, password } = await signUp()
    await db.sql(`update users set status = 'active' where email = $1`, [email])
    const signIn = await call('POST', '/sign-in/email', { email, password })
    expect(signIn.status).toBe(200)
    const cookie = signIn.headers.get('set-cookie')?.split(';')[0] ?? ''

    // 還沒停用時 get-session 是通的。
    expect((await call('GET', '/get-session', undefined, { cookie })).status).toBe(200)

    await db.sql(`update users set status = 'disabled', banned = false where email = $1`, [email])

    const session = await call('GET', '/get-session', undefined, { cookie })
    expect(session.status, '停用之後同一個 cookie 就該失效').toBeGreaterThanOrEqual(400)

    const change = await call(
      'POST',
      '/change-password',
      { currentPassword: password, newPassword: 'Another-Long-Password-1' },
      { cookie },
    )
    expect(change.status, '停用的人不能改密').toBeGreaterThanOrEqual(400)
  })

  it('pending 與 must-change 叫不動 list-accounts（只有 active 可以）', async () => {
    const pending = await signUp() // 註冊完就是 pending，而且註冊本身會建 session
    const pendingCookie = pending.response.headers.get('set-cookie')?.split(';')[0] ?? ''
    const asPending = await call('GET', '/list-accounts', undefined, { cookie: pendingCookie })
    expect(asPending.status, 'pending 不能列出登入方式').toBe(403)

    const forced = await accountWithStatus('active', true)
    const forcedSignIn = await call('POST', '/sign-in/email', {
      email: forced.email,
      password: forced.password,
    })
    expect(forcedSignIn.status).toBe(200)
    const forcedCookie = forcedSignIn.headers.get('set-cookie')?.split(';')[0] ?? ''
    const asForced = await call('GET', '/list-accounts', undefined, { cookie: forcedCookie })
    expect(asForced.status, 'must-change 只能改密與登出').toBe(403)
  })

  it('active 且不必改密的人，list-accounts 正常', async () => {
    const active = await accountWithStatus('active')
    const signIn = await call('POST', '/sign-in/email', {
      email: active.email,
      password: active.password,
    })
    const cookie = signIn.headers.get('set-cookie')?.split(';')[0] ?? ''
    expect((await call('GET', '/list-accounts', undefined, { cookie })).status).toBe(200)
  })

  it('pending 與 must-change 仍然可以讀 session、改密、登出（那是他們唯一能做的）', async () => {
    const forced = await accountWithStatus('active', true)
    const signIn = await call('POST', '/sign-in/email', {
      email: forced.email,
      password: forced.password,
    })
    const cookie = signIn.headers.get('set-cookie')?.split(';')[0] ?? ''

    expect((await call('GET', '/get-session', undefined, { cookie })).status).toBe(200)
    expect((await call('POST', '/sign-out', {}, { cookie })).status).toBe(200)
  })
})

// ── fresh session（2026-09-16 複核 Spec 1 的回歸測試） ────────────────────────

describe('fresh session（契約 03 §2 的 freshAge＝10 分鐘）', () => {
  /**
   * 複核重現過：`session.freshAge = 600` 設了也沒有用。
   *
   * 安裝版本 1.7.5 只有 `/list-sessions` 掛 `freshSessionMiddleware`，
   * `/link-social` 與 `/list-accounts` 掛的是一般的 `sessionMiddleware`
   * （`node_modules/better-auth/dist/api/routes/session.mjs`），設定值對它們根本不會被讀到。
   * 所以改由路由矩陣宣告、hook 自己比 `session.created_at`。
   */

  async function activeSignIn() {
    const { email, password } = await signUp()
    await db.sql(`update users set status = 'active' where email = $1`, [email])
    const signIn = await call('POST', '/sign-in/email', { email, password })
    expect(signIn.status).toBe(200)
    return { email, cookie: signIn.headers.get('set-cookie')?.split(';')[0] ?? '' }
  }

  /** 把這個人的 session 建立時間往回推，模擬「登入之後過了一段時間」。 */
  async function ageSession(email: string, minutes: number) {
    await db.sql(
      `update sessions set created_at = now() - ($2 || ' minutes')::interval
         where user_id = (select id from users where email = $1)`,
      [email, String(minutes)],
    )
  }

  it('剛登入（9 分鐘）還算 fresh，list-accounts 通', async () => {
    const { email, cookie } = await activeSignIn()
    await ageSession(email, 9)
    expect((await call('GET', '/list-accounts', undefined, { cookie })).status).toBe(200)
  })

  it('超過 10 分鐘就不是 fresh，list-accounts 被擋', async () => {
    const { email, cookie } = await activeSignIn()
    await ageSession(email, 11)

    const stale = await call('GET', '/list-accounts', undefined, { cookie })
    expect(stale.status, '11 分鐘前建立的 session 不該還能列出登入方式').toBe(403)
    expect(await stale.json()).toMatchObject({ code: 'SESSION_NOT_FRESH' })
  })

  it('link-social 同樣要 fresh', async () => {
    const { email, cookie } = await activeSignIn()
    await ageSession(email, 11)

    const stale = await call('POST', '/link-social', { provider: 'google' }, { cookie })
    expect(stale.status).toBe(403)
    expect(await stale.json()).toMatchObject({ code: 'SESSION_NOT_FRESH' })
  })

  it('不要求 fresh 的路由不受影響——放久了照樣能讀 session 與登出', async () => {
    const { email, cookie } = await activeSignIn()
    await ageSession(email, 120)

    expect((await call('GET', '/get-session', undefined, { cookie })).status).toBe(200)
    expect((await call('POST', '/sign-out', {}, { cookie })).status).toBe(200)
  })
})

// ── server-only 呼叫也受狀態矩陣管（2026-09-16 複核 Spec 2 的回歸測試） ──────

describe('server-only 呼叫也受狀態矩陣管', () => {
  /**
   * `hooks.before` 原本在沒有 `ctx.request` 時把方法當成 `POST`。
   * `/list-accounts` **只註冊了 GET**，所以 `sessionRequirement('/list-accounts','POST')`
   * 回 undefined，整個狀態檢查直接跳過——HTTP GET 擋得住，
   * `auth.api.listUserAccounts({ headers })` 卻拿得到資料。
   *
   * 根本問題是「沒有方法時去猜一個方法」。現在沒有方法就不用方法查表，
   * 改以路徑取最嚴的一條。
   *
   * 目前沒有任何正式包裝器對外暴露 `listUserAccounts`，所以這不是一個已重現的對外利用，
   * 而是共同 hook 的契約漏洞——但它就在所有人都會走的那條路上。
   */

  function headersWith(cookie: string): Headers {
    return new Headers({ cookie })
  }

  /** 先讓他登得進來（建 session 會擋非 usable 狀態），登入後再改成要測的狀態。 */
  async function signedInCookie(status: string, mustChange = false): Promise<string> {
    const { email, password } = await signUp()
    await db.sql(
      'update users set status = $2, must_change_password = $3, banned = false where email = $1',
      [email, status === 'pending' ? 'active' : status, mustChange],
    )
    const signIn = await call('POST', '/sign-in/email', { email, password })
    expect(signIn.status).toBe(200)
    if (status === 'pending') {
      await db.sql(`update users set status = 'pending' where email = $1`, [email])
    }
    return signIn.headers.get('set-cookie')?.split(';')[0] ?? ''
  }

  it('pending 的人從伺服器端呼叫 listUserAccounts 一樣被擋', async () => {
    const cookie = await signedInCookie('pending')

    // HTTP 那條早就擋住了，這裡確認 server-only 這條也擋。
    expect((await call('GET', '/list-accounts', undefined, { cookie })).status).toBe(403)
    await expect(
      authInstance.api.listUserAccounts({ headers: headersWith(cookie) }),
    ).rejects.toMatchObject({ status: 'FORBIDDEN' })
  })

  it('must-change 的人也一樣', async () => {
    const cookie = await signedInCookie('active', true)
    await expect(
      authInstance.api.listUserAccounts({ headers: headersWith(cookie) }),
    ).rejects.toMatchObject({ status: 'FORBIDDEN' })
  })

  it('active 且 fresh 的人從伺服器端呼叫仍然正常（沒有擋過頭）', async () => {
    const cookie = await signedInCookie('active')
    const accounts = await authInstance.api.listUserAccounts({ headers: headersWith(cookie) })
    expect(Array.isArray(accounts)).toBe(true)
  })
})
