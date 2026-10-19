import type { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AccountDirectoryCommand,
  ActorResolver,
  AvatarCommand,
  RegistrationCommand,
  ResolvedActor,
  TeacherSetupCommand,
} from '@/application/accounts'
import {
  assertTestDatabaseReachable,
  createIsolatedDatabase,
  poolAsRole,
  TEST_DATABASE_URL,
  type IsolatedDatabase,
} from '../../../test/db'
import { migratedSchema } from '../../../test/migrations'

/**
 * SH-B1 身分快取：TTL 60 秒下每個失效點（B 設計方案 §4.1、§4.2；AC-SH-73、74、75、85）。
 *
 * 每一案都是「動作前命中（第二次 resolve 0 句 SQL）→ 動作 → 下一次 resolve 拿到新值」。
 * 動作一律走真的入口：command 物件、或直接打 `/api/auth/*` 的 HTTP handler（不經 `wrapper.ts` 的 Server Action 包裝）。
 * SQL 句數算的是共用連線池（Better Auth 與 resolver 都用它）的 `query` 呼叫次數。
 * **不得以 TTL 0 的 e2e 代替**（▶R-5），所以這裡明確設 `IDENTITY_CACHE_TTL_SECONDS=60`。
 *
 * Astra r2 P1：同一張 cookie 的等價寫法（Set-Cookie 原樣、全解碼、只解碼一部分、加引號、簽章末字元 base64 可塑）
 * 套件都認、都是同一個 session——登出其中一種之後，其餘寫法也不能再命中（鍵正規化＋ sessionToken 次要索引）。
 */

const BASE_URL = 'http://127.0.0.1:3000'
const PASSWORD = 'Correct-Horse-Battery-9'

let db: IsolatedDatabase
let app: Pool
let handlers: typeof import('@/infrastructure/auth/wrapper').authRouteHandlers
let resolver: ActorResolver
let directory: AccountDirectoryCommand
let accounts: import('@/infrastructure/accounts/account-command').PgAccountCommand
let avatars: AvatarCommand
let teacherSetup: TeacherSetupCommand
let registration: RegistrationCommand
let openCohort: string
let rosterVersion: string
let sharedPool: Pool
let resetLimiters: () => Promise<void>
let admin: { userId: string; headers: Headers }
let cache: () => import('@/infrastructure/auth/identity-cache').IdentityCache

let seq = 0
const requestId = () => `88888888-8888-4888-8888-${String(++seq).padStart(12, '0')}`
const uniqueEmail = (tag: string) => `shb1-${tag}-${Date.now()}-${++seq}@example.com`

async function one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
  return (await db.sql(sql, params)).rows[0] as T
}

let ipSeq = 0
function call(method: 'GET' | 'POST', path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return handlers[method](
    new Request(`${BASE_URL}/api/auth${path}`, {
      method,
      headers: { 'content-type': 'application/json', origin: BASE_URL, 'x-real-ip': `198.51.100.${(++ipSeq % 250) + 1}`, ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
}

const cookieOf = (response: Response) => (response.headers.get('set-cookie') ?? '').split(';')[0]!
const headersOf = (cookie: string) => new Headers({ cookie })
const NAME = 'better-auth.session_token'

/**
 * 同一張 cookie 的等價寫法（套件 better-call `parseCookies`：去引號、有 `%` 就 decodeURIComponent，再驗簽）：
 * Set-Cookie 原樣（簽章被 `encodeURIComponent` 過：`%2F`、`%2B`、`%3D`）、全解碼、只把 `=` 編碼、加引號。
 * 解碼後都是同一個字串，所以快取應該只有一個鍵。
 */
function spellings(cookie: string): Record<string, string> {
  const value = cookie.slice(cookie.indexOf('=') + 1)
  const decoded = decodeURIComponent(value)
  expect(decoded, 'Set-Cookie 原樣一定含 %3D').not.toBe(value)
  return {
    原樣: `${NAME}=${value}`,
    全解碼: `${NAME}=${decoded}`,
    半解碼: `${NAME}=${decoded.replace(/=$/, '%3D')}`,
    引號: `${NAME}="${decoded}"`,
  }
}

/**
 * 簽章（32 位元組 → 44 字元 base64、一個 `=`）最後一個資料字元只有高 4 位元有用，低 2 位元是補位；
 * `atob` 對四種寫法解出同一組位元組，套件的 HMAC 驗證全部通過。這四種**解碼後仍是不同字串**，只靠正規化清不掉。
 */
function signatureVariants(cookie: string): string[] {
  const value = decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1))
  const dot = value.lastIndexOf('.')
  const token = value.slice(0, dot)
  const signature = value.slice(dot + 1)
  expect(signature).toHaveLength(44)
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const index = alphabet.indexOf(signature[42]!)
  return [0, 1, 2, 3].map((bits) => `${NAME}=${token}.${signature.slice(0, 42)}${alphabet[(index & ~3) | bits]}=`)
}

/** 套件自己認不認這張 cookie（`/get-session` 不經我們的快取）。 */
async function packageSees(cookie: string): Promise<string | undefined> {
  const response = await call('GET', '/get-session', undefined, { cookie })
  expect(response.status).toBe(200)
  const session = (await response.json()) as { user?: { id?: string } } | null
  return session?.user?.id
}

async function signIn(email: string, password = PASSWORD): Promise<string> {
  const response = await call('POST', '/sign-in/email', { email, password })
  expect(response.status, `${email} 登入`).toBe(200)
  return cookieOf(response)
}

/** 一個 active 的帳號（已驗證 Email、有 profile）＋給定角色＋一張登入 cookie。 */
async function member(roles: readonly ('student' | 'teacher' | 'admin')[], { profile = true } = {}) {
  const email = uniqueEmail(roles.join('-') || 'none')
  const response = await call('POST', '/sign-up/email', { email, password: PASSWORD, name: '快取測試' })
  expect(response.status).toBe(200)
  const { id: userId } = await one<{ id: string }>('select id from users where email = $1', [email])
  await db.sql(`update users set status = 'active', email_verified = true where id = $1`, [userId])
  if (roles.includes('admin')) await db.sql(`update users set role = 'admin' where id = $1`, [userId])
  if (profile) {
    await db.sql(
      `insert into user_profiles (user_id, display_name, name_normalized, contact_email) values ($1, '快取測試', '快取測試', $2)`,
      [userId, email],
    )
  }
  for (const role of roles) {
    await db.sql(
      `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at) values (gen_random_uuid(), $1, $2, $1, now())`,
      [userId, role],
    )
  }
  return { userId, email, cookie: cookieOf(response) }
}

/** 跑 `work` 期間共用連線池送出的 SQL 句數。 */
async function countQueries<T>(work: () => Promise<T>): Promise<{ result: T; queries: number }> {
  const spy = vi.spyOn(sharedPool, 'query')
  try {
    const result = await work()
    return { result, queries: spy.mock.calls.length }
  } finally {
    spy.mockRestore()
  }
}

/** 暖快取並確認命中：第一次照常讀資料庫，第二次 0 句、拿到同一個結果。 */
async function warm(cookie: string): Promise<ResolvedActor & { kind: 'authenticated' }> {
  const first = await resolver.resolve(headersOf(cookie))
  expect(first.kind).toBe('authenticated')
  const second = await countQueries(() => resolver.resolve(headersOf(cookie)))
  expect(second.queries, '第二次 resolve 應該命中快取').toBe(0)
  expect(second.result).toEqual(first)
  return first as ResolvedActor & { kind: 'authenticated' }
}

const resolve = (cookie: string) => resolver.resolve(headersOf(cookie))

function adminActor(): ResolvedActor {
  return { kind: 'authenticated', userId: admin.userId, roles: ['admin'], status: 'active', mustChangePassword: false, cohortMemberships: [] }
}

/** 只假 `Date`（套件判斷 session 到期、resolver 判斷快取到期都看它）；計時器照真的跑。 */
function travel(ms: number): void {
  const now = Date.now()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(now + ms)
}

beforeAll(async () => {
  await assertTestDatabaseReachable()
  db = await createIsolatedDatabase({ label: 'shb1-identity-cache', setup: migratedSchema })
  app = await poolAsRole(db, 'fju_app')

  const url = new URL(TEST_DATABASE_URL)
  url.username = 'fju_app'
  url.password = process.env.TEST_FJU_APP_PASSWORD ?? 'fju_app_local_test'
  url.searchParams.set('options', `-c search_path=${db.schemaName}`)

  vi.resetModules()
  vi.stubEnv('DATABASE_URL', url.toString())
  vi.stubEnv('BETTER_AUTH_SECRET', 'integration-test-secret-integration-test')
  vi.stubEnv('BETTER_AUTH_URL', BASE_URL)
  vi.stubEnv('TURNSTILE_SITE_KEY', '')
  vi.stubEnv('TURNSTILE_SECRET_KEY', '')
  vi.stubEnv('MAIL_CAPTURE', '1')
  vi.stubEnv('IDENTITY_CACHE_TTL_SECONDS', '60')

  handlers = (await import('@/infrastructure/auth/wrapper')).authRouteHandlers
  const instance = await import('@/infrastructure/auth/auth-instance')
  const signUpLimit = await import('@/infrastructure/auth/sign-up-rate-limit')
  const signInLimit = await import('@/infrastructure/auth/sign-in-rate-limit')
  resetLimiters = async () => {
    instance.resetEmailOtpLimiters()
    signUpLimit.resetSignUpLimiter()
    signInLimit.resetSignInLimiter()
  }
  sharedPool = (await import('@/infrastructure/db/client')).getPool()
  const { getIdentityCache } = await import('@/infrastructure/auth/identity-cache')
  expect(getIdentityCache().ttlSeconds).toBe(60)
  cache = getIdentityCache
  resolver = new (await import('@/infrastructure/auth/actor-resolver')).DbActorResolver()

  const { PgAuditWriter } = await import('@/infrastructure/ops/audit-writer')
  const { PgOperationLedger } = await import('@/infrastructure/ops/operation-ledger')
  const { PgAccountDirectoryCommand } = await import('@/infrastructure/accounts/account-directory-command')
  const { PgAccountCommand } = await import('@/infrastructure/accounts/account-command')
  const { PgAvatarCommand } = await import('@/infrastructure/accounts/avatar-store')
  const { PgTeacherSetupCommand } = await import('@/infrastructure/accounts/teacher-setup')
  directory = new PgAccountDirectoryCommand({ audit: new PgAuditWriter(), ledger: new PgOperationLedger(() => app), db: () => app })
  accounts = new PgAccountCommand({ audit: new PgAuditWriter(), ledger: new PgOperationLedger(() => app), db: () => app })
  // 選預設圖不碰檔案儲存。
  avatars = new PgAvatarCommand({ db: () => app, audit: new PgAuditWriter(), files: {} as never })
  teacherSetup = new PgTeacherSetupCommand({ audit: new PgAuditWriter(), db: () => app })
  const { PgRegistrationCommand } = await import('@/infrastructure/accounts/registration-command')
  const { PgCohortStatusQuery } = await import('@/infrastructure/cohorts/pg-cohorts')
  // 不注入 mail：審核結果信與快取無關。
  registration = new PgRegistrationCommand({
    audit: new PgAuditWriter(),
    ledger: new PgOperationLedger(() => app),
    db: () => app,
    cohorts: new PgCohortStatusQuery(() => app),
  })

  await resetLimiters()
  const a = await member(['admin'])
  admin = { userId: a.userId, headers: headersOf(a.cookie) }

  // 註冊審核（AC-SH-74 j）：一個開放註冊的屆別＋一版名單；每案自己加名單列。
  openCohort = (
    await one<{ id: string }>(
      `insert into cohorts (id, code, name, created_by_kind, is_registration_open)
       values (gen_random_uuid(), 'SHB1B', 'SH-B1b 屆', 'system', true) returning id`,
    )
  ).id
  rosterVersion = (
    await one<{ id: string }>(
      `insert into roster_versions (id, cohort_id, imported_by_user_id, imported_real_at, summary)
       values (gen_random_uuid(), $1, $2, now(), '{}'::jsonb) returning id`,
      [openCohort, a.userId],
    )
  ).id
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await app?.end()
  await db?.close()
})

beforeEach(async () => {
  await resetLimiters()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('命中（AC-SH-73）', () => {
  it('同一張 cookie 第二次 resolve 0 句 SQL；沒有 cookie 不進快取', async () => {
    const s = await member(['student'])
    const first = await countQueries(() => resolve(s.cookie))
    expect(first.result).toMatchObject({ kind: 'authenticated', userId: s.userId, roles: ['student'] })
    expect(first.queries).toBeGreaterThan(0)
    await warm(s.cookie)

    const sizeBefore = cache().size
    expect(await resolver.resolve(new Headers())).toEqual({ kind: 'anonymous' })
    // 亂編的 cookie：簽章對不上，套件不認，也不會被存進來。
    expect((await resolve('better-auth.session_token=not-a-real-token.bad-signature')).kind).toBe('anonymous')
    expect(cache().size).toBe(sizeBefore)
  })
})

describe('cookie 有歧義時不用快取（Sol r1 P1）', () => {
  it('同名兩張、secure＋一般混用、__Secure- 那張是別人的：都拿不到別人的身分，而且不查也不存快取', async () => {
    const a = await member(['admin'])
    const b = await member(['student'])
    expect((await warm(a.cookie)).roles).toContain('admin')
    await warm(b.cookie)
    const sizeBefore = cache().size
    const aSecure = `__Secure-better-auth.session_token=${a.cookie.slice(a.cookie.indexOf('=') + 1)}`
    for (const cookie of [`${b.cookie}; ${a.cookie}`, `${a.cookie}; ${b.cookie}`, `${b.cookie}; ${aSecure}`, `${aSecure}; ${b.cookie}`]) {
      const { result, queries } = await countQueries(() => resolve(cookie))
      expect(queries, `${cookie.slice(0, 40)}… 應該走未快取的路`).toBeGreaterThan(0)
      // 套件自己挑哪一張是它的事；我們只要求結果跟「沒有快取」時一樣，絕不是快取裡另一個人的。
      const uncached = await new (await import('@/infrastructure/auth/actor-resolver')).DbActorResolver({
        cache: new (await import('@/infrastructure/auth/identity-cache')).IdentityCache({ ttlSeconds: 0 }),
      }).resolve(headersOf(cookie))
      expect(result).toEqual(uncached)
    }
    expect(cache().size).toBe(sizeBefore)
  })
})

describe('同一張 cookie 的等價寫法（Astra r2 P1）', () => {
  it('套件實際讀的 cookie 名稱就是快取認的那個；第一次 resolve 之後快取已登記、沒被停用', async () => {
    const { getAuth } = await import('@/infrastructure/auth/auth-instance')
    const { authCookies } = await getAuth().$context
    expect(authCookies.sessionToken.name).toBe(NAME)
    const s = await member(['student'])
    await warm(s.cookie)
    expect(cache().sessionCookieName).toBe(NAME)
    expect(cache().disabledReason).toBeNull()
  })

  it('原樣、全解碼、半解碼、引號：套件都認、快取只有一個鍵；暖過其中一種，其餘寫法第一次就命中（0 句 SQL）', async () => {
    const s = await member(['student'])
    const forms = spellings(s.cookie)
    for (const [label, cookie] of Object.entries(forms)) expect(await packageSees(cookie), label).toBe(s.userId)
    const sizeBefore = cache().size
    await warm(forms.原樣!)
    expect(cache().size).toBe(sizeBefore + 1)
    for (const [label, cookie] of Object.entries(forms)) {
      const { result, queries } = await countQueries(() => resolve(cookie))
      expect(queries, `${label} 應該命中同一個鍵`).toBe(0)
      expect(result).toMatchObject({ kind: 'authenticated', userId: s.userId })
    }
    expect(cache().size).toBe(sizeBefore + 1)
  })

  /** 原樣、全解碼、半解碼各暖一次（這三種 r1 的程式也會各存一筆）；引號寫法只 resolve 一次（r1 不存它、現在歸到同一個鍵）。 */
  async function warmAll(forms: Record<string, string>): Promise<void> {
    for (const [label, cookie] of Object.entries(forms)) {
      if (label === '引號') expect((await resolve(cookie)).kind).toBe('authenticated')
      else await warm(cookie)
    }
  }

  it('四種寫法都暖過 → 用其中一種 POST /sign-out → 四種寫法下一次全部 anonymous', async () => {
    const s = await member(['student'])
    const forms = spellings(s.cookie)
    await warmAll(forms)
    const response = await call('POST', '/sign-out', undefined, { cookie: forms.全解碼! })
    expect(response.status).toBe(200)
    for (const [label, cookie] of Object.entries(forms)) {
      expect(await packageSees(cookie), `${label}：套件已經不認`).toBeUndefined()
      expect((await resolve(cookie)).kind, `${label}：登出後不得再命中`).toBe('anonymous')
    }
  })

  it('簽章末字元的四種 base64 寫法：套件都認、各是一個鍵（次要索引）；用其中一種登出 → 四種全部 anonymous', async () => {
    const s = await member(['student'])
    const variants = signatureVariants(s.cookie)
    expect(new Set(variants).size).toBe(4)
    for (const cookie of variants) expect(await packageSees(cookie), cookie.slice(-6)).toBe(s.userId)
    const sizeBefore = cache().size
    for (const cookie of variants) await warm(cookie)
    expect(cache().size).toBe(sizeBefore + 4)
    expect((await call('POST', '/sign-out', undefined, { cookie: variants[3]! })).status).toBe(200)
    for (const cookie of variants) expect((await resolve(cookie)).kind, `${cookie.slice(-6)}：登出後不得再命中`).toBe('anonymous')
    expect(cache().size).toBe(sizeBefore)
  })

  it('等價寫法與簽章變體都暖過 → 用其中一種 change-password → 全部 anonymous（userId 索引）', async () => {
    const s = await member(['student'])
    const forms = spellings(s.cookie)
    const all = [...Object.values(forms), ...signatureVariants(s.cookie)]
    await warmAll(forms)
    for (const cookie of signatureVariants(s.cookie)) await warm(cookie)
    const response = await call(
      'POST',
      '/change-password',
      { currentPassword: PASSWORD, newPassword: 'Changed-Password-2027', revokeOtherSessions: false },
      { cookie: spellings(s.cookie).半解碼! },
    )
    expect(response.status).toBe(200)
    for (const cookie of all) expect((await resolve(cookie)).kind, cookie.slice(-10)).toBe('anonymous')
  })

  it('正規化失敗（`%` 解不開、引號只開不關）與歧義（同名兩張）：不讀不存，結果跟套件一致', async () => {
    const s = await member(['student'])
    await warm(s.cookie)
    const sizeBefore = cache().size
    const decoded = spellings(s.cookie).全解碼!
    const bad = [
      s.cookie.replace('%3D', '%ZZ'),
      `${decoded.slice(0, NAME.length + 1)}"${decoded.slice(NAME.length + 1)}`,
      `${s.cookie}; ${s.cookie}`,
    ]
    for (const cookie of bad) {
      // 解不開、引號不配對的，套件連資料庫都不查就拒絕（0 句也是走套件的路）；同名兩張套件取第一張，那就一定是查過資料庫的。
      const expected = await packageSees(cookie)
      const { result, queries } = await countQueries(() => resolve(cookie))
      expect(result.kind === 'authenticated' ? result.userId : undefined, cookie.slice(-12)).toBe(expected)
      if (expected) expect(queries, `${cookie.slice(-12)} 是登入身分，必須來自資料庫而不是快取`).toBeGreaterThan(0)
    }
    expect(cache().size).toBe(sizeBefore)
  })
})

describe('每個失效點下一次請求生效（AC-SH-74）', () => {
  it('(a) 系辦停用 → 同一張 cookie 下一次 anonymous', async () => {
    const s = await member(['student'])
    await warm(s.cookie)
    const result = await directory.disable(adminActor(), { userId: s.userId, reason: '畢業離校', requestId: requestId() }, { headers: admin.headers })
    expect(result).toMatchObject({ ok: true })
    expect((await resolve(s.cookie)).kind).toBe('anonymous')
  })

  it('(b) 撤管理員角色（revokeRole → #changeAdminRole）→ 下一次 roles 不含 admin', async () => {
    const other = await member(['teacher', 'admin'], { profile: true })
    await db.sql(`update user_profiles set profile_completed_at = now() where user_id = $1`, [other.userId])
    expect((await warm(other.cookie)).roles).toContain('admin')
    const result = await accounts.revokeRole(adminActor(), { userId: other.userId, role: 'admin', reason: '職務異動', requestId: requestId() })
    expect(result).toMatchObject({ ok: true })
    const after = await resolve(other.cookie)
    expect(after).toMatchObject({ kind: 'authenticated', roles: ['teacher'] })
  })

  it('(c) 直接 POST /api/auth/sign-out（HTTP，不經 wrapper）→ 舊 cookie 下一次 anonymous', async () => {
    const s = await member(['student'])
    await warm(s.cookie)
    const response = await call('POST', '/sign-out', undefined, { cookie: s.cookie })
    expect(response.status).toBe(200)
    expect((await resolve(s.cookie)).kind).toBe('anonymous')
  })

  it('(d) 暖快取前就 2 秒後到期的 session：時鐘越過到期（未滿 60 秒）→ anonymous', async () => {
    const s = await member(['student'])
    // 「不記得我」的 session：套件讀它時不會自動延長到期（`session.mjs` 的 dontRememberMe），到期就是真的到期。
    // 一般 session 剩不到 6 天時，套件每次讀都會延長，那樣就做不出「2 秒後到期」。
    const response = await call('POST', '/sign-in/email', { email: s.email, password: PASSWORD, rememberMe: false })
    expect(response.status).toBe(200)
    const cookie = response.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
    expect(cookie).toContain('dont_remember')
    const { id } = await one<{ id: string }>('select id from sessions where user_id = $1 order by created_at desc limit 1', [s.userId])
    // 暖快取「之前」把到期時間設好（▶R2-4：暖起來之後再改 DB 改不到 Map 裡的到期時間）。
    await db.sql(`update sessions set expires_at = now() + interval '2 seconds' where id = $1`, [id])
    await warm(cookie)
    travel(3_000)
    expect((await resolve(cookie)).kind).toBe('anonymous')
  })

  it('(e) change-password（強制撤其他 session）→ 其他 cookie 下一次 anonymous', async () => {
    const s = await member(['student'])
    const other = await signIn(s.email)
    await warm(s.cookie)
    await warm(other)
    const response = await call(
      'POST',
      '/change-password',
      { currentPassword: PASSWORD, newPassword: 'Changed-Password-2026', revokeOtherSessions: false },
      { cookie: s.cookie },
    )
    expect(response.status).toBe(200)
    expect((await resolve(other)).kind).toBe('anonymous')
    expect((await resolve(s.cookie)).kind).toBe('anonymous')
  })

  it('(f) 忘記密碼 → reset-password 成功 → 舊 cookie 下一次 anonymous', async () => {
    const s = await member(['student'])
    await warm(s.cookie)
    expect((await call('POST', '/request-password-reset', { email: s.email, redirectTo: '/reset-password' })).status).toBe(200)
    let body: string | undefined
    for (let i = 0; i < 50 && !body; i += 1) {
      const row = await one<{ body_text: string } | undefined>(
        `select body_text from mail_outbox where to_email = $1 and template = 'password_reset' order by created_at desc limit 1`,
        [s.email],
      )
      body = row?.body_text
      if (!body) await new Promise((r) => setTimeout(r, 50))
    }
    const token = decodeURIComponent(body!.match(/token=([^。\s]+)/)![1]!)
    const response = await call('POST', '/reset-password', { token, newPassword: 'Reset-Password-2026' })
    expect(response.status).toBe(200)
    expect((await resolve(s.cookie)).kind).toBe('anonymous')
  })

  it('(g) 系辦核發暫時密碼 → 舊 cookie 下一次 anonymous；用臨時密碼登入後 mustChangePassword = true', async () => {
    const s = await member(['student'])
    await warm(s.cookie)
    const issued = await accounts.issueTemporaryPassword(adminActor(), admin.headers, {
      userId: s.userId,
      verificationMethod: 'id_document',
      verificationNote: '系辦櫃台核對學生證',
      reason: '忘記密碼',
      requestId: requestId(),
    })
    expect(issued).toMatchObject({ ok: true })
    expect((await resolve(s.cookie)).kind).toBe('anonymous')
    const fresh = await signIn(s.email, (issued as { secret: string }).secret)
    expect(await resolve(fresh)).toMatchObject({ kind: 'authenticated', userId: s.userId, mustChangePassword: true })
  })

  it('(h) 換頭像 → 下一次 avatarPreset 是新值', async () => {
    const s = await member(['student'])
    const before = await warm(s.cookie)
    expect(before.avatarPreset).toBeNull()
    expect(await avatars.updateAvatar(before, { preset: 7 })).toMatchObject({ ok: true })
    expect(await resolve(s.cookie)).toMatchObject({ kind: 'authenticated', avatarPreset: 7 })
  })

  it('(i) 老師完成首次設定 → 下一次 teacherSetupPending = false，命中時不多跑 needsSetup 那句', async () => {
    const t = await member(['teacher'], { profile: false })
    const before = await warm(t.cookie)
    expect(before.teacherSetupPending).toBe(true)
    expect(
      await teacherSetup.complete(before, { displayName: '陳老師', phone: '', contactEmail: 'chen-shb1@example.com' }),
    ).toMatchObject({ ok: true })
    const after = await warm(t.cookie)
    expect(after.teacherSetupPending).toBe(false)
  })

  it('(j) 孤兒帳號補身分（repairOrphan，待審一併開通）→ 下一次就有角色、不再是待審', async () => {
    const p = await member([], { profile: false })
    await db.sql(`update users set status = 'pending' where id = $1`, [p.userId])
    expect(await warm(p.cookie)).toMatchObject({ status: 'pending', roles: [] })
    const repaired = await accounts.repairOrphan(adminActor(), { userId: p.userId, role: 'teacher', reason: '補建老師身分', requestId: requestId() })
    expect(repaired).toMatchObject({ ok: true, receipt: { activated: true } })
    expect(await resolve(p.cookie)).toMatchObject({ kind: 'authenticated', status: 'active', roles: ['teacher'], teacherSetupPending: true })
  })
})

describe('註冊審核的失效點（AC-SH-74 j，SH-B1b）', () => {
  let studentNoSeq = 0

  /**
   * 待審的申請人：名單上有他（學號＋姓名同一列）。名單 Email 預設跟登入 Email 不同——C2-12 起密碼註冊且 Email 已驗證、
   * 三欄同列會自動開通，這裡要的是留在待審（姓名不同會被批次核准略過，所以改 Email）；只有 Google 案例名單 Email 相同。用密碼登入的 cookie 已送出第 1 版申請。
   * 回傳前已暖快取並確認命中，快照是 `pending`、沒有角色。
   */
  async function applicant({ google = false } = {}) {
    const p = await member([], { profile: false })
    await db.sql(`update users set status = 'pending' where id = $1`, [p.userId])
    const studentNo = `4119${String(++studentNoSeq).padStart(5, '0')}`
    await db.sql(
      `insert into roster_entries (id, roster_version_id, student_no, name_raw, name_normalized, department_class, email)
       values (gen_random_uuid(), $1, $2, '快取測試', '快取測試', '資管二甲', $3)`,
      [rosterVersion, studentNo, google ? p.email : `roster-${p.email}`],
    )
    if (google) {
      await db.sql(
        `insert into accounts (id, account_id, provider_id, user_id, created_at, updated_at)
         values (gen_random_uuid(), $1, 'google', $2, now(), now())`,
        [`sub-${p.email}`, p.userId],
      )
    }
    const actor = await warm(p.cookie)
    expect(actor).toMatchObject({ status: 'pending', roles: [] })
    const fields = { appliedName: '快取測試', studentNo, departmentClass: '資管二甲', phone: '0912-345-678', contactEmail: p.email }
    return { ...p, actor, fields }
  }

  async function submitted() {
    const p = await applicant()
    const sent = await registration.reviseMine(p.actor, p.fields, null)
    expect(sent).toMatchObject({ ok: true, receipt: { revision: 1 } })
    expect(sent.ok && sent.receipt.autoApproved).toBeFalsy()
    const applicationId = (sent as { receipt: { applicationId: string } }).receipt.applicationId
    // 送申請不改身分快照，快取照樣命中。
    await warm(p.cookie)
    return { ...p, applicationId }
  }

  const approval = { verificationMethod: 'id_document', verificationNote: '櫃台核對學生證', reason: '' }

  it('(j-核准) 系辦核准 → 同一張 cookie 下一次就是已開通的學生', async () => {
    const p = await submitted()
    const result = await registration.approve(adminActor(), {
      applicationId: p.applicationId,
      revision: 1,
      ...approval,
      cohortId: null,
      requestId: requestId(),
    })
    expect(result).toMatchObject({ ok: true, receipt: { decision: 'approved' } })
    expect(await resolve(p.cookie)).toMatchObject({ kind: 'authenticated', status: 'active', roles: ['student'] })
  })

  it('(j-批次) 批次核准兩位 → 兩人同一張 cookie 下一次都已開通', async () => {
    const a = await submitted()
    const b = await submitted()
    const result = await registration.approveMany(adminActor(), {
      items: [a, b].map((p) => ({ applicationId: p.applicationId, revision: 1, requestId: requestId() })),
      previewSkipped: [],
      ...approval,
    })
    expect(result).toMatchObject({ ok: true, receipt: { skipped: [] } })
    expect(result.ok && result.receipt.approved).toHaveLength(2)
    for (const p of [a, b]) {
      expect(await resolve(p.cookie)).toMatchObject({ kind: 'authenticated', status: 'active', roles: ['student'] })
    }
  })

  it('(j-退回) 系辦退回 → 下一次 resolve 回資料庫讀（快照仍是待審）；本人看到的申請狀態立即是退回', async () => {
    const p = await submitted()
    const result = await registration.reject(adminActor(), {
      applicationId: p.applicationId,
      revision: 1,
      reason: '學號與學生證不符',
      requestId: requestId(),
    })
    expect(result).toMatchObject({ ok: true, receipt: { decision: 'rejected' } })
    // 身分快照不含申請狀態（退回後帳號仍是待審），所以只能驗「快取已清」：下一次要查資料庫。
    const next = await countQueries(() => resolve(p.cookie))
    expect(next.queries, '退回後同一張 cookie 應該回資料庫讀').toBeGreaterThan(0)
    expect(next.result).toMatchObject({ kind: 'authenticated', status: 'pending', roles: [] })
    // 待審頁讀的那條路（`viewMine`）直接讀資料庫，不經身分快取。
    const mine = await registration.viewMine(next.result)
    expect(mine).toMatchObject({ ok: true, receipt: { state: 'rejected', rejection: { reason: '學號與學生證不符' } } })
  })

  it('(j-自動開通) VB-6：Google 來、Email＋學號＋姓名命中開放屆別 → 送出即開通，同一張 cookie 下一次就是學生', async () => {
    const p = await applicant({ google: true })
    // 這張 cookie 是密碼登入的；自動開通看的是用例收到的 actor（同 registration-command 整合測試），快取以 userId 清。
    const googleActor = { ...p.actor, loginMethod: 'google' } as ResolvedActor
    const sent = await registration.reviseMine(googleActor, p.fields, null)
    expect(sent).toMatchObject({ ok: true, receipt: { revision: 1, autoApproved: true } })
    expect(await resolve(p.cookie)).toMatchObject({ kind: 'authenticated', status: 'active', roles: ['student'] })
  })
})

describe('沒經過入口的改動最多 60 秒生效（AC-SH-75，Q189）', () => {
  it('直接 update users set status = disabled：立刻仍 authenticated，撥快 61 秒 → anonymous', async () => {
    const s = await member(['student'])
    await warm(s.cookie)
    await db.sql(`update users set status = 'disabled' where id = $1`, [s.userId])
    expect((await resolve(s.cookie)).kind).toBe('authenticated')
    travel(61_000)
    expect((await resolve(s.cookie)).kind).toBe('anonymous')
  })
})
