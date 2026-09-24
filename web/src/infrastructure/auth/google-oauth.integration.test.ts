import { createHash } from 'node:crypto'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RegistrationCommand, ResolvedActor, SelfAccountCommand } from '@/application/accounts'
import {
  assertTestDatabaseReachable,
  createIsolatedDatabase,
  poolAsRole,
  TEST_DATABASE_URL,
  type IsolatedDatabase,
} from '../../../test/db'
import { migratedSchema } from '../../../test/migrations'

/**
 * 票 10：Google 登入與本人帳號頁（ACC-13、16、18；模組 01 §2.3、契約 03 §2／§3）。
 *
 * **Google 在 CI 登不了**，所以這裡用一個假的 Google：只替換 token 端點
 * （`https://oauth2.googleapis.com/token`）的 `fetch`，回一個自己組的 id_token。
 * 其餘全部是真的——真的 Better Auth、真的 route handler、真的 state／PKCE、真的 PostgreSQL
 * （隔離 schema、全程 `fju_app`）。套件的 Google provider 對 token 端點回來的 id_token 只解碼
 * 不驗簽（它是 TLS 直接跟 Google 換來的），所以替身不需要簽章。
 *
 * **真實 Google 登入由 Roy 手動驗**（ACC-13／16／18 的真 Google 部分）。
 */

const BASE_URL = 'http://127.0.0.1:3000'
const PASSWORD = 'Correct-Horse-Battery-9'
const CLIENT_ID = 'test-client-id.apps.googleusercontent.com'

let db: IsolatedDatabase
let app: Pool
let handlers: typeof import('@/infrastructure/auth/wrapper').authRouteHandlers
let self: SelfAccountCommand
let registration: RegistrationCommand
let resetSignUpLimiter: () => void
let resetSignInLimiter: () => void
let adminId: string
let cohortId: string

/** 假 Google 這一輪要回的身分；token 端點的替身讀這個。 */
let nextIdentity: { sub: string; email: string; name: string; emailVerified?: boolean } | null = null
/** 最後一次打 token 端點帶的表單（拿來驗 PKCE 的 code_verifier）。 */
let lastTokenRequest: URLSearchParams | null = null
const realFetch = globalThis.fetch

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

let seq = 0
const uniq = (tag: string) => `t10-${tag}-${Date.now()}-${++seq}@example.com`
const requestId = () => `10101010-1010-4010-8010-${String(++seq).padStart(12, '0')}`

async function one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
  return (await db.sql(sql, params)).rows[0] as T
}

beforeAll(async () => {
  await assertTestDatabaseReachable()
  db = await createIsolatedDatabase({ label: 't10-google', setup: migratedSchema })
  app = await poolAsRole(db, 'fju_app')

  const url = new URL(TEST_DATABASE_URL)
  url.username = 'fju_app'
  url.password = process.env.TEST_FJU_APP_PASSWORD ?? 'fju_app_local_test'
  url.searchParams.set('options', `-c search_path=${db.schemaName}`)

  vi.resetModules()
  vi.stubEnv('DATABASE_URL', url.toString())
  vi.stubEnv('BETTER_AUTH_SECRET', 'integration-test-secret-integration-test')
  vi.stubEnv('BETTER_AUTH_URL', BASE_URL)
  vi.stubEnv('GOOGLE_CLIENT_ID', CLIENT_ID)
  vi.stubEnv('GOOGLE_CLIENT_SECRET', 'test-client-secret')

  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (href.startsWith('https://oauth2.googleapis.com/token')) {
      lastTokenRequest = new URLSearchParams(String(init?.body ?? ''))
      const who = nextIdentity
      if (!who) return Response.json({ error: 'invalid_grant' }, { status: 400 })
      const now = Math.floor(Date.now() / 1000)
      const idToken = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({
        iss: 'https://accounts.google.com',
        aud: CLIENT_ID,
        sub: who.sub,
        email: who.email,
        email_verified: who.emailVerified ?? true,
        name: who.name,
        iat: now,
        exp: now + 3600,
      })}.signature-not-checked`
      return Response.json({ access_token: 'at', token_type: 'Bearer', expires_in: 3600, id_token: idToken })
    }
    if (href.startsWith('https://')) throw new Error(`測試不應該連外：${href}`)
    return realFetch(input, init)
  })

  handlers = (await import('@/infrastructure/auth/wrapper')).authRouteHandlers
  resetSignUpLimiter = (await import('@/infrastructure/auth/sign-up-rate-limit')).resetSignUpLimiter
  resetSignInLimiter = (await import('@/infrastructure/auth/sign-in-rate-limit')).resetSignInLimiter
  const { BetterAuthSelfAccountCommand } = await import('@/infrastructure/auth/self-account')
  self = new BetterAuthSelfAccountCommand()
  const { PgRegistrationCommand } = await import('@/infrastructure/accounts/registration-command')
  const { PgAuditWriter } = await import('@/infrastructure/ops/audit-writer')
  const { PgOperationLedger } = await import('@/infrastructure/ops/operation-ledger')
  const { PgCohortStatusQuery } = await import('@/infrastructure/cohorts/pg-cohorts')
  registration = new PgRegistrationCommand({
    audit: new PgAuditWriter(),
    ledger: new PgOperationLedger(() => app),
    db: () => app,
    cohorts: new PgCohortStatusQuery(() => app),
  })

  adminId = String(
    (
      await db.sql(
        `insert into users (id, name, email, email_verified, updated_at, status)
         values (gen_random_uuid(), '系辦 A1', 'a1-t10@example.com', false, now(), 'active') returning id`,
      )
    ).rows[0]!.id,
  )
  cohortId = String(
    (
      await db.sql(
        `insert into cohorts (id, code, name, created_by_kind, is_registration_open)
         values (gen_random_uuid(), '115', '115 學年度專題', 'system', true) returning id`,
      )
    ).rows[0]!.id,
  )
})

afterAll(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await app?.end()
  await db?.close()
})

beforeEach(() => {
  resetSignUpLimiter()
  resetSignInLimiter()
  nextIdentity = null
  lastTokenRequest = null
})

// ── 小工具 ──────────────────────────────────────────────────────────────────

function cookiesFrom(response: Response): string {
  return response.headers
    .getSetCookie()
    .filter((c) => !/Max-Age=0/i.test(c))
    .map((c) => c.split(';')[0])
    .join('; ')
}

let ipSeq = 0
/**
 * 每個請求換一個來源 IP：密碼登入有「IP＋帳號」限速、註冊有每 IP 限速，
 * 測試一口氣打很多次，換 IP 讓各條測試互不影響（`/sign-in/social` 本身已不受套件的 IP 限速）。
 */
const freshIp = () => `203.0.113.${(++ipSeq % 250) + 1}`

function post(path: string, body: unknown, cookie = ''): Promise<Response> {
  return handlers.POST(
    new Request(`${BASE_URL}/api/auth${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE_URL, 'x-real-ip': freshIp(), ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    }),
  )
}

/** 假裝使用者在 Google 同意後被導回來：帶著 state 與（瀏覽器上的）state cookie 打 callback。 */
async function finishAtGoogle(
  start: Response,
  who: { sub: string; email: string; name: string; emailVerified?: boolean } | null,
  cookie = '',
): Promise<{ location: string; cookie: string; authorize: URL }> {
  expect(start.status, await start.clone().text()).toBe(200)
  const { url } = (await start.json()) as { url: string }
  const authorize = new URL(url)
  nextIdentity = who
  const stateCookie = cookiesFrom(start)
  const callback = await handlers.GET(
    new Request(`${BASE_URL}/api/auth/callback/google?code=code-${seq}&state=${authorize.searchParams.get('state')}`, {
      headers: { cookie: [cookie, stateCookie].filter(Boolean).join('; ') },
    }),
  )
  expect(callback.status).toBe(302)
  return { location: callback.headers.get('location') ?? '', cookie: cookiesFrom(callback), authorize }
}

function googleSignIn(who: { sub: string; email: string; name: string; emailVerified?: boolean } | null, overrides: Record<string, string> = {}) {
  return post('/sign-in/social', {
    provider: 'google',
    callbackURL: '/login',
    errorCallbackURL: '/login',
    newUserCallbackURL: '/register/pending?via=google',
    ...overrides,
  }).then((start) => finishAtGoogle(start, who))
}

async function passwordAccount(status: 'pending' | 'active' = 'active'): Promise<{ email: string; userId: string; cookie: string }> {
  const email = uniq('pw')
  const signUp = await post('/sign-up/email', { email, password: PASSWORD, name: '密碼使用者' })
  expect(signUp.status).toBe(200)
  const userId = String((await one<{ id: string }>(`select id from users where email = $1`, [email])).id)
  if (status === 'active') await db.sql(`update users set status = 'active' where id = $1`, [userId])
  const signIn = await post('/sign-in/email', { email, password: PASSWORD })
  expect(signIn.status).toBe(200)
  return { email, userId, cookie: cookiesFrom(signIn) }
}

const headersOf = (cookie: string) => new Headers({ cookie })
const makeStale = (userId: string) =>
  db.sql(`update sessions set created_at = now() - interval '11 minutes' where user_id = $1`, [userId])
const admin = (): ResolvedActor => ({
  kind: 'authenticated',
  userId: adminId,
  roles: ['admin'],
  status: 'active',
  mustChangePassword: false,
  cohortMemberships: [],
})

// ── ACC-13：Google 首次登入 ───────────────────────────────────────────────

describe('Google 首次登入（ACC-13）', () => {
  it('Google 鈕不受套件「10 秒 3 次／IP」限制：同一個 IP 連按 5 次都拿得到授權網址', async () => {
    for (let i = 0; i < 5; i += 1) {
      const start = await handlers.POST(
        new Request(`${BASE_URL}/api/auth/sign-in/social`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: BASE_URL, 'x-real-ip': '198.51.100.77' },
          body: JSON.stringify({ provider: 'google', callbackURL: '/login' }),
        }),
      )
      expect(start.status).toBe(200)
    }
  })

  it('state＋PKCE：授權網址帶 S256 challenge，換 token 時帶的 verifier 對得上', async () => {
    const who = { sub: `sub-pkce-${seq}`, email: uniq('pkce'), name: 'PKCE' }
    const { authorize } = await googleSignIn(who)
    expect(authorize.origin + authorize.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(authorize.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(authorize.searchParams.get('redirect_uri')).toBe(`${BASE_URL}/api/auth/callback/google`)
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorize.searchParams.get('state')).toMatch(/^[\w-]{20,}$/)
    const verifier = lastTokenRequest!.get('code_verifier')!
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(authorize.searchParams.get('code_challenge'))
  })

  it('沒有瀏覽器上的 state cookie（別人丟來的回呼連結）→ 不建帳號也不登入', async () => {
    const start = await post('/sign-in/social', { provider: 'google', callbackURL: '/login', errorCallbackURL: '/login' })
    const { url } = (await start.json()) as { url: string }
    const email = uniq('csrf')
    nextIdentity = { sub: `sub-csrf-${seq}`, email, name: 'CSRF' }
    const callback = await handlers.GET(
      new Request(`${BASE_URL}/api/auth/callback/google?code=x&state=${new URL(url).searchParams.get('state')}`),
    )
    expect(callback.status).toBe(302)
    expect(callback.headers.get('location')).toMatch(/error=/)
    expect(cookiesFrom(callback)).not.toContain('session_token')
    expect(await one(`select count(*)::int as n from users where email = $1`, [email])).toEqual({ n: 0 })
  })

  it('首次進來 → 待審、這次登入方式記 google、導到等待審核頁補資料；補送後核准，最近登入方式記 google', async () => {
    const email = uniq('first')
    const who = { sub: `sub-first-${seq}`, email, name: 'Google 王小明' }
    const first = await googleSignIn(who)
    expect(first.location).toBe('/register/pending?via=google')
    expect(first.cookie).toContain('session_token')

    const user = await one<{ id: string; status: string; name: string }>(`select id, status, name from users where email = $1`, [email])
    expect(user.status).toBe('pending')
    expect(await one(`select login_method from sessions where user_id = $1`, [user.id])).toEqual({ login_method: 'google' })
    // 還沒有申請單：等待審核頁顯示 none，姓名預填 Google 的名字。
    const pending: ResolvedActor = { kind: 'authenticated', userId: user.id, roles: [], status: 'pending', mustChangePassword: false, cohortMemberships: [] }
    expect(await registration.viewMine(pending)).toMatchObject({ ok: true, receipt: { state: 'none', accountName: 'Google 王小明', loginEmail: email } })

    // 補學號、系級、手機 → 第 1 版，跟密碼註冊同一條待審路。
    const revised = await registration.reviseMine(
      pending,
      { appliedName: '王小明', studentNo: '411510001', departmentClass: '資管二甲', phone: '0912-000-111', contactEmail: email },
      null,
    )
    expect(revised).toMatchObject({ ok: true, receipt: { revision: 1 } })
    const application = await one<{ id: string }>(`select id from registration_applications where user_id = $1`, [user.id])

    // 同一個 Google 身分再登入一次：回到同一個帳號，仍是待審。
    const again = await googleSignIn(who)
    expect(again.location).toBe('/login')
    expect(await one(`select count(*)::int as n from users where email = $1`, [email])).toEqual({ n: 1 })

    const approved = await registration.approve(admin(), {
      applicationId: application.id,
      revision: 1,
      verificationMethod: 'id_document',
      verificationNote: '',
      reason: '',
      cohortId,
      requestId: requestId(),
    })
    expect(approved).toMatchObject({ ok: true })
    // 票 7 遺留：核准時的登入方式不再寫死 password。
    expect(await one(`select login_method_last from user_profiles where user_id = $1`, [user.id])).toEqual({ login_method_last: 'google' })

    // 核准後用 Google 直接登入，帳號 ID 不變。
    const later = await googleSignIn(who)
    expect(later.location).toBe('/login')
    const session = await self.viewMine(headersOf(later.cookie))
    expect(session).toMatchObject({ userId: user.id, status: 'active', loginMethods: { google: true, password: false } })
  })

  it('同 Email 已有密碼帳號：未登入時用 Google 進來一律拒絕（account_not_linked），不合併、不建第二個帳號', async () => {
    const { email, userId } = await passwordAccount('active')
    const result = await googleSignIn({ sub: `sub-same-${seq}`, email, name: '同 Email' }, { errorCallbackURL: '/login?next=%2Faccount' })
    expect(result.location).toBe('/login?next=%2Faccount&error=account_not_linked')
    expect(result.cookie).not.toContain('session_token')
    expect(await one(`select count(*)::int as n from users where email = $1`, [email])).toEqual({ n: 1 })
    expect(await one(`select count(*)::int as n from accounts where user_id = $1 and provider_id = 'google'`, [userId])).toEqual({ n: 0 })
  })

  it('停用的 Google 帳號：回來是一般的失敗，不建 session、不說被停用', async () => {
    const email = uniq('disabled')
    const who = { sub: `sub-disabled-${seq}`, email, name: '停用' }
    await googleSignIn(who)
    await db.sql(`update users set status = 'disabled' where email = $1`, [email])
    await db.sql(`delete from sessions where user_id = (select id from users where email = $1)`, [email])
    const result = await googleSignIn(who)
    expect(result.location).toMatch(/^\/login\?error=/)
    expect(result.cookie).not.toContain('session_token')
    expect(await one(`select count(*)::int as n from sessions s join users u on u.id = s.user_id where u.email = $1`, [email])).toEqual({ n: 0 })
  })
})

// ── ACC-07 × 票 10：預授權老師第一次用 Google 登入 ─────────────────────────

describe('系辦預授權的老師第一次用 Google 登入（票 8 × 票 10）', () => {
  /** 票 8 預授權建出來的樣子：active、有效 teacher 角色、一種登入方式都沒有。 */
  async function preauthorizedTeacher(overrides: { status?: string; role?: boolean; withPassword?: boolean } = {}) {
    const email = uniq('preauth')
    const userId = String(
      (
        await db.sql(
          `insert into users (id, name, email, email_verified, updated_at, status)
           values (gen_random_uuid(), $1, $1, false, now(), $2) returning id`,
          [email, overrides.status ?? 'active'],
        )
      ).rows[0]!.id,
    )
    if (overrides.role !== false) {
      await db.sql(
        `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at, reason)
         values (gen_random_uuid(), $1, 'teacher', $2, now(), '系辦預授權老師')`,
        [userId, adminId],
      )
    }
    if (overrides.withPassword) {
      await db.sql(
        `insert into accounts (id, account_id, provider_id, user_id, password, created_at, updated_at)
         values (gen_random_uuid(), $1::text, 'credential', $1::uuid, 'hash', now(), now())`,
        [userId],
      )
    }
    return { email, userId }
  }

  it('同 Email、Google 已驗證 → 綁到預授權帳號並登入（帳號 ID 不變、不建第二個帳號、留稽核）', async () => {
    const t = await preauthorizedTeacher()
    const who = { sub: `sub-preauth-${seq}`, email: t.email.toUpperCase(), name: 'Google 陳老師' }
    const result = await googleSignIn(who)
    expect(result.location).toBe('/login')
    expect(result.cookie).toContain('session_token')
    expect(await one(`select count(*)::int as n from users where lower(email) = $1`, [t.email])).toEqual({ n: 1 })
    expect(await one(`select user_id from accounts where provider_id = 'google' and account_id = $1`, [who.sub])).toEqual({ user_id: t.userId })
    expect(await one(`select count(*)::int as n from audit_events where action = 'account.bind_google_preauthorized' and target_id = $1`, [t.userId])).toEqual({ n: 1 })
    expect(await self.viewMine(headersOf(result.cookie))).toMatchObject({ userId: t.userId, status: 'active', loginMethods: { google: true, password: false } })
    // 姓名不被 Google 改掉（老師之後在補資料頁自己填）。
    expect(await one(`select name from users where id = $1`, [t.userId])).toEqual({ name: t.email })

    // 第二次登入走一般的已連結路徑，不再補、不再多一筆稽核。
    const again = await googleSignIn(who)
    expect(again.cookie).toContain('session_token')
    expect(await one(`select count(*)::int as n from accounts where user_id = $1`, [t.userId])).toEqual({ n: 1 })
    expect(await one(`select count(*)::int as n from audit_events where action = 'account.bind_google_preauthorized' and target_id = $1`, [t.userId])).toEqual({ n: 1 })
  })

  it('Google 沒驗證這個 Email → 不綁，照舊 account_not_linked', async () => {
    const t = await preauthorizedTeacher()
    const result = await googleSignIn({ sub: `sub-unverified-${seq}`, email: t.email, name: '未驗證', emailVerified: false })
    expect(result.location).toMatch(/error=/)
    expect(result.cookie).not.toContain('session_token')
    expect(await one(`select count(*)::int as n from accounts where user_id = $1`, [t.userId])).toEqual({ n: 0 })
  })

  it('已經有密碼的老師（系辦直接新增的）→ 不綁，照舊 account_not_linked：要先用密碼登入再連結', async () => {
    const t = await preauthorizedTeacher({ withPassword: true })
    const result = await googleSignIn({ sub: `sub-direct-${seq}`, email: t.email, name: '直接新增' })
    expect(result.location).toBe('/login?error=account_not_linked')
    expect(await one(`select count(*)::int as n from accounts where user_id = $1 and provider_id = 'google'`, [t.userId])).toEqual({ n: 0 })
  })

  it('別人按「連結 Google」時用了預授權老師 Email 的 Google → 不替老師綁、連結也被拒', async () => {
    const t = await preauthorizedTeacher()
    const other = await passwordAccount('active')
    const start = await post('/link-social', { provider: 'google', callbackURL: '/account?linked=google', errorCallbackURL: '/account' }, other.cookie)
    const result = await finishAtGoogle(start, { sub: `sub-linkpre-${seq}`, email: t.email, name: '陳老師' }, other.cookie)
    expect(result.location).toBe('/account?error=email_does_not_match')
    expect(await one(`select count(*)::int as n from accounts where user_id = $1`, [t.userId])).toEqual({ n: 0 })
    expect(await one(`select count(*)::int as n from accounts where user_id = $1 and provider_id = 'google'`, [other.userId])).toEqual({ n: 0 })
  })

  it('沒有老師角色、或不是 active 的無登入方式帳號 → 不綁', async () => {
    const noRole = await preauthorizedTeacher({ role: false })
    expect((await googleSignIn({ sub: `sub-norole-${seq}`, email: noRole.email, name: '無角色' })).location).toBe('/login?error=account_not_linked')
    const disabled = await preauthorizedTeacher({ status: 'disabled' })
    expect((await googleSignIn({ sub: `sub-disabled-t-${seq}`, email: disabled.email, name: '停用' })).location).toBe('/login?error=account_not_linked')
    expect(await one(`select count(*)::int as n from accounts where user_id in ($1, $2)`, [noRole.userId, disabled.userId])).toEqual({ n: 0 })
  })
})

// ── ACC-16：同人兩種登入方式 ──────────────────────────────────────────────

describe('連結 Google（ACC-16）', () => {
  it('fresh session 連結 → 同一個帳號 ID、兩種方式都回到這個帳號、留稽核', async () => {
    const { email, userId, cookie } = await passwordAccount('active')

    // 用例層先給一個授權網址（伺服器端呼叫，經 hook 的 active＋fresh 檢查）。
    expect(await self.startGoogleLink(headersOf(cookie))).toMatchObject({ ok: true, url: expect.stringContaining('accounts.google.com') })

    // 瀏覽器那一趟（真的 state cookie）用 HTTP 走完。
    const start = await post('/link-social', { provider: 'google', callbackURL: '/account?linked=google', errorCallbackURL: '/account' }, cookie)
    const who = { sub: `sub-link-${seq}`, email, name: '連結者' }
    const linked = await finishAtGoogle(start, who, cookie)
    expect(linked.location).toBe('/account?linked=google')

    expect(await one(`select user_id from accounts where provider_id = 'google' and account_id = $1`, [who.sub])).toEqual({ user_id: userId })
    expect(await one(`select count(*)::int as n from audit_events where action = 'account.link_google' and target_id = $1`, [userId])).toEqual({ n: 1 })
    // 名字、Email 都不因連結而改。
    expect(await one(`select email, name from users where id = $1`, [userId])).toEqual({ email, name: '密碼使用者' })

    // 之後用 Google 登入：同一個帳號、這次登入方式是 google。
    const viaGoogle = await googleSignIn(who)
    expect(viaGoogle.cookie).toContain('session_token')
    expect(await self.viewMine(headersOf(viaGoogle.cookie))).toMatchObject({ userId, loginMethods: { google: true, password: true } })
    // 密碼也還能登入。
    expect((await post('/sign-in/email', { email, password: PASSWORD })).status).toBe(200)
  })

  it('session 超過 10 分鐘：用例與直接打 API 都回 FRESH_SESSION_REQUIRED', async () => {
    const { userId, cookie } = await passwordAccount('active')
    await makeStale(userId)
    expect(await self.startGoogleLink(headersOf(cookie))).toMatchObject({ ok: false, code: 'FRESH_SESSION_REQUIRED' })
    const http = await post('/link-social', { provider: 'google', callbackURL: '/account' }, cookie)
    expect(http.status).toBe(403)
    expect(((await http.json()) as { code?: string }).code).toBe('FRESH_SESSION_REQUIRED')
  })

  it('待審的人不能連結', async () => {
    const { cookie } = await passwordAccount('pending')
    expect(await self.startGoogleLink(headersOf(cookie))).toMatchObject({ ok: false, code: 'ACCOUNT_PENDING' })
    expect((await post('/link-social', { provider: 'google', callbackURL: '/account' }, cookie)).status).toBe(403)
  })

  it('搶綁：已綁在別人身上的 Google 身分被拒（ACCOUNT_LINK_CONFLICT），兩邊都不變（ACC-18 前半）', async () => {
    const owner = await passwordAccount('active')
    const sub = `sub-taken-${seq}`
    await db.sql(
      `insert into accounts (id, account_id, provider_id, user_id, created_at, updated_at)
       values (gen_random_uuid(), $1, 'google', $2, now(), now())`,
      [sub, owner.userId],
    )
    const thief = await passwordAccount('active')
    const start = await post('/link-social', { provider: 'google', callbackURL: '/account?linked=google', errorCallbackURL: '/account' }, thief.cookie)
    const result = await finishAtGoogle(start, { sub, email: thief.email, name: '搶綁' }, thief.cookie)
    expect(result.location).toBe('/account?error=account_already_linked_to_different_user')
    expect(await one(`select user_id from accounts where provider_id = 'google' and account_id = $1`, [sub])).toEqual({ user_id: owner.userId })
    expect(await one(`select count(*)::int as n from accounts where user_id = $1 and provider_id = 'google'`, [thief.userId])).toEqual({ n: 0 })
  })

  it('Google 帳號 Email 跟登入 Email 不同 → 拒絕（登入身分不因連結而多出一個 Email）', async () => {
    const me = await passwordAccount('active')
    const start = await post('/link-social', { provider: 'google', callbackURL: '/account?linked=google', errorCallbackURL: '/account' }, me.cookie)
    const result = await finishAtGoogle(start, { sub: `sub-other-${seq}`, email: uniq('other'), name: '別的' }, me.cookie)
    expect(result.location).toBe('/account?error=email_does_not_match')
    expect(await one(`select count(*)::int as n from accounts where user_id = $1 and provider_id = 'google'`, [me.userId])).toEqual({ n: 0 })
  })
})

// ── ACC-18 後半：替 Google 帳號設密碼 ─────────────────────────────────────

describe('替 Google 帳號設密碼（ACC-18）', () => {
  async function googleOnlyActive() {
    const email = uniq('gonly')
    const who = { sub: `sub-gonly-${seq}`, email, name: '只有 Google' }
    const first = await googleSignIn(who)
    const userId = String((await one<{ id: string }>(`select id from users where email = $1`, [email])).id)
    await db.sql(`update users set status = 'active' where id = $1`, [userId])
    return { email, userId, cookie: first.cookie, who }
  }

  it('fresh 時設定 → 之後用 Email＋密碼登入回到同一個帳號；留稽核；第二次設定被擋', async () => {
    const me = await googleOnlyActive()
    expect(await self.setPassword(headersOf(me.cookie), { newPassword: 'short', passwordConfirm: 'short' })).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
      field: 'newPassword',
    })
    expect(await self.setPassword(headersOf(me.cookie), { newPassword: PASSWORD, passwordConfirm: `${PASSWORD}x` })).toMatchObject({
      ok: false,
      field: 'passwordConfirm',
    })
    expect(await self.setPassword(headersOf(me.cookie), { newPassword: PASSWORD, passwordConfirm: PASSWORD })).toEqual({ ok: true })

    const signIn = await post('/sign-in/email', { email: me.email, password: PASSWORD })
    expect(signIn.status).toBe(200)
    expect(((await signIn.json()) as { user: { id: string } }).user.id).toBe(me.userId)
    expect(await one(`select login_method from sessions where user_id = $1 order by created_at desc limit 1`, [me.userId])).toEqual({
      login_method: 'password',
    })
    expect(await one(`select count(*)::int as n from audit_events where action = 'account.set_password' and target_id = $1`, [me.userId])).toEqual({ n: 1 })
    // 稽核不含密碼。
    expect(JSON.stringify((await db.sql(`select payload from audit_events where target_id = $1`, [me.userId])).rows)).not.toContain(PASSWORD)

    expect(await self.setPassword(headersOf(me.cookie), { newPassword: `${PASSWORD}2`, passwordConfirm: `${PASSWORD}2` })).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
    })
  })

  it('session 不夠新 → FRESH_SESSION_REQUIRED；待審 → ACCOUNT_PENDING', async () => {
    const me = await googleOnlyActive()
    await makeStale(me.userId)
    expect(await self.setPassword(headersOf(me.cookie), { newPassword: PASSWORD, passwordConfirm: PASSWORD })).toMatchObject({
      ok: false,
      code: 'FRESH_SESSION_REQUIRED',
    })

    const pendingEmail = uniq('gpending')
    const pending = await googleSignIn({ sub: `sub-gpending-${seq}`, email: pendingEmail, name: '待審' })
    expect(await self.setPassword(headersOf(pending.cookie), { newPassword: PASSWORD, passwordConfirm: PASSWORD })).toMatchObject({
      ok: false,
      code: 'ACCOUNT_PENDING',
    })
  })

  it('套件的 /set-password 對外封鎖：帶著有效 session 直接打也是 403', async () => {
    const me = await googleOnlyActive()
    const http = await post('/set-password', { newPassword: PASSWORD }, me.cookie)
    expect(http.status).toBe(403)
    expect(await one(`select count(*)::int as n from accounts where user_id = $1 and provider_id = 'credential'`, [me.userId])).toEqual({ n: 0 })
  })
})

// ── 本人資料 ────────────────────────────────────────────────────────────

describe('帳號頁：本人資料與登入 Email', () => {
  async function withProfile() {
    const me = await passwordAccount('active')
    await db.sql(
      `insert into user_profiles (user_id, display_name, name_normalized, contact_email, phone)
       values ($1, '密碼使用者', '密碼使用者', $2, '0912-345-678')`,
      [me.userId, me.email],
    )
    return me
  }

  it('改手機與聯絡 Email：版本 +1、稽核只記改了哪幾欄；舊版本被擋；格式不對指出欄位', async () => {
    const me = await withProfile()
    const view = await self.viewMine(headersOf(me.cookie))
    expect(view).toMatchObject({ loginEmail: me.email, sessionFresh: true, profile: { revision: 1, phone: '0912-345-678' } })

    const updated = await self.updateContact(headersOf(me.cookie), { phone: '0987 654 321', contactEmail: 'Contact@Example.com', expectedRevision: 1 })
    expect(updated).toEqual({ ok: true, revision: 2 })
    expect(await one(`select phone, contact_email, updated_by_user_id from user_profiles where user_id = $1`, [me.userId])).toEqual({
      phone: '0987 654 321',
      contact_email: 'contact@example.com',
      updated_by_user_id: me.userId,
    })
    const audit = await one<{ payload: unknown }>(`select payload from audit_events where action = 'account.update_contact' and target_id = $1`, [me.userId])
    expect(audit.payload).toEqual({ changed: ['phone', 'contactEmail'], revision: 2 })

    expect(await self.updateContact(headersOf(me.cookie), { phone: '0911-111-111', contactEmail: me.email, expectedRevision: 1 })).toMatchObject({
      ok: false,
      code: 'CONFLICT',
    })
    expect(await self.updateContact(headersOf(me.cookie), { phone: 'abc', contactEmail: me.email, expectedRevision: 2 })).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
      field: 'phone',
    })
    // 登入 Email 沒動。
    expect(await one(`select email from users where id = $1`, [me.userId])).toEqual({ email: me.email })
  })

  it('登入 Email 本人不能換：/change-email 與 /update-user 帶有效 session 直接打都是 403', async () => {
    const me = await withProfile()
    expect((await post('/change-email', { newEmail: uniq('new') }, me.cookie)).status).toBe(403)
    expect((await post('/update-user', { name: '改名' }, me.cookie)).status).toBe(403)
    expect(await one(`select email, name from users where id = $1`, [me.userId])).toEqual({ email: me.email, name: '密碼使用者' })
  })

  it('沒有個人資料列的人（例如還沒補資料的老師）：不能改，給一句話', async () => {
    const me = await passwordAccount('active')
    expect(await self.updateContact(headersOf(me.cookie), { phone: '0912-345-678', contactEmail: me.email, expectedRevision: 1 })).toMatchObject({
      ok: false,
      code: 'FORBIDDEN',
    })
  })

  it('每次登入更新「最近登入方式」顯示欄', async () => {
    const me = await withProfile()
    await post('/sign-in/email', { email: me.email, password: PASSWORD })
    expect(await one(`select login_method_last from user_profiles where user_id = $1`, [me.userId])).toEqual({ login_method_last: 'password' })
  })
})

// ── 票 7 遺留：直接打註冊 API 不透露 Email 已被用過 ────────────────────────

describe('註冊 API：Email 已被用過（票 7 遺留）', () => {
  it('回跟「Email 格式不對」同一個 400＋代碼＋訊息，沒有套件的 USER_ALREADY_EXISTS', async () => {
    const { email } = await passwordAccount('active')
    const dup = await post('/sign-up/email', { email, password: PASSWORD, name: '別人' })
    const bad = await post('/sign-up/email', { email: 'not-an-email', password: PASSWORD, name: '別人' })
    const dupBody = await dup.text()
    expect(dup.status).toBe(400)
    expect(dupBody).not.toMatch(/ALREADY_EXISTS/i)
    expect(JSON.parse(dupBody)).toMatchObject({ code: 'EMAIL_UNAVAILABLE', message: '這個 Email 無法用來註冊。如果你已經有帳號，請直接登入。' })
    expect(bad.status).toBe(400)
    expect(JSON.parse(await bad.text())).toEqual(JSON.parse(dupBody))
  })
})
