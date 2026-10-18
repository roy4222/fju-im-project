import type { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AccountDirectoryCommand,
  ActorResolver,
  AvatarCommand,
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

  await resetLimiters()
  const a = await member(['admin'])
  admin = { userId: a.userId, headers: headersOf(a.cookie) }
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
