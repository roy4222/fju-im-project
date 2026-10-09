import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RegistrationCommand } from '@/application/accounts'
import {
  assertTestDatabaseReachable,
  createIsolatedDatabase,
  poolAsRole,
  TEST_DATABASE_URL,
  type IsolatedDatabase,
} from '../../../test/db'
import { migratedSchema } from '../../../test/migrations'

/**
 * 註冊開關（設計方案 §5；features.json G3、G4）。
 *
 * 證明**伺服器端**真的擋：直接打 `/api/auth/sign-up/email`、走註冊的 Server Action 用例、
 * 用沒見過的 Google 身分回來，三條路在 `REGISTRATION_OPEN=false` 時都不會建出帳號；
 * 系辦預授權的老師第一次用 Google 登入不受影響。開著（`true`、沒設）時行為同今天。
 *
 * Better Auth 實例是延後建立的單例、建立時讀開關，所以每一段先 `vi.resetModules()`、設好變數、
 * 再重新 import 包裝器，拿到一個新實例。假 Google 的作法同 `google-oauth.integration.test.ts`。
 */

const BASE_URL = 'http://127.0.0.1:3000'
const PASSWORD = 'Correct-Horse-Battery-9'
const CLIENT_ID = 'test-client-id.apps.googleusercontent.com'
const CLOSED_MESSAGE = '目前沒有開放註冊。'

let db: IsolatedDatabase
let app: Pool
let databaseUrl: string
let adminId: string

type Identity = { sub: string; email: string; name: string }
let nextIdentity: Identity | null = null
const realFetch = globalThis.fetch

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

let seq = 0
const uniq = (tag: string) => `t5-${tag}-${Date.now()}-${++seq}@example.com`
const freshIp = () => `203.0.113.${(++seq % 250) + 1}`

async function one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
  return (await db.sql(sql, params)).rows[0] as T
}
const userCount = (email: string) => one<{ n: number }>(`select count(*)::int as n from users where lower(email) = lower($1)`, [email])

beforeAll(async () => {
  await assertTestDatabaseReachable()
  db = await createIsolatedDatabase({ label: 't5-registration', setup: migratedSchema })
  app = await poolAsRole(db, 'fju_app')

  const url = new URL(TEST_DATABASE_URL)
  url.username = 'fju_app'
  url.password = process.env.TEST_FJU_APP_PASSWORD ?? 'fju_app_local_test'
  url.searchParams.set('options', `-c search_path=${db.schemaName}`)
  databaseUrl = url.toString()

  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (href.startsWith('https://oauth2.googleapis.com/token')) {
      const who = nextIdentity
      if (!who) return Response.json({ error: 'invalid_grant' }, { status: 400 })
      const now = Math.floor(Date.now() / 1000)
      const idToken = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({
        iss: 'https://accounts.google.com',
        aud: CLIENT_ID,
        sub: who.sub,
        email: who.email,
        email_verified: true,
        name: who.name,
        iat: now,
        exp: now + 3600,
      })}.signature-not-checked`
      return Response.json({ access_token: 'at', token_type: 'Bearer', expires_in: 3600, id_token: idToken })
    }
    if (href.startsWith('https://')) throw new Error(`測試不應該連外：${href}`)
    return realFetch(input, init)
  })

  adminId = String(
    (
      await db.sql(
        `insert into users (id, name, email, email_verified, updated_at, status)
         values (gen_random_uuid(), '系辦 A1', 'a1-t5@example.com', false, now(), 'active') returning id`,
      )
    ).rows[0]!.id,
  )
  // 註冊用例要有一個開放註冊的屆別。
  await db.sql(
    `insert into cohorts (id, code, name, created_by_kind, is_registration_open)
     values (gen_random_uuid(), '115', '115 學年度專題', 'system', true)`,
  )
})

afterAll(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await app?.end()
  await db?.close()
})

beforeEach(() => {
  nextIdentity = null
})

/** 換一個新的 Better Auth 實例：`registrationOpen` 為 undefined 代表環境裡沒有這個鍵。 */
async function freshAuth(registrationOpen: string | undefined) {
  vi.unstubAllEnvs()
  vi.resetModules()
  vi.stubEnv('DATABASE_URL', databaseUrl)
  vi.stubEnv('BETTER_AUTH_SECRET', 'integration-test-secret-integration-test')
  vi.stubEnv('BETTER_AUTH_URL', BASE_URL)
  vi.stubEnv('GOOGLE_CLIENT_ID', CLIENT_ID)
  vi.stubEnv('GOOGLE_CLIENT_SECRET', 'test-client-secret')
  if (registrationOpen === undefined) delete process.env.REGISTRATION_OPEN
  else vi.stubEnv('REGISTRATION_OPEN', registrationOpen)

  const handlers = (await import('@/infrastructure/auth/wrapper')).authRouteHandlers
  ;(await import('@/infrastructure/auth/sign-up-rate-limit')).resetSignUpLimiter()
  ;(await import('@/infrastructure/auth/social-sign-in-rate-limit')).resetSocialSignInLimiter()
  const { PgRegistrationCommand } = await import('@/infrastructure/accounts/registration-command')
  const { PgAuditWriter } = await import('@/infrastructure/ops/audit-writer')
  const { PgOperationLedger } = await import('@/infrastructure/ops/operation-ledger')
  const { PgCohortStatusQuery } = await import('@/infrastructure/cohorts/pg-cohorts')
  const registration: RegistrationCommand = new PgRegistrationCommand({
    audit: new PgAuditWriter(),
    ledger: new PgOperationLedger(() => app),
    db: () => app,
    cohorts: new PgCohortStatusQuery(() => app),
  })
  return { handlers, registration }
}

type Handlers = Awaited<ReturnType<typeof freshAuth>>['handlers']

function cookiesFrom(response: Response): string {
  return response.headers
    .getSetCookie()
    .filter((c) => !/Max-Age=0/i.test(c))
    .map((c) => c.split(';')[0])
    .join('; ')
}

function post(handlers: Handlers, path: string, body: unknown, ip = freshIp()): Promise<Response> {
  return handlers.POST(
    new Request(`${BASE_URL}/api/auth${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE_URL, 'x-real-ip': ip },
      body: JSON.stringify(body),
    }),
  )
}

/** 從登入頁按 Google（errorCallbackURL＝/login），在 Google 同意後被導回 callback。 */
async function googleSignIn(handlers: Handlers, who: Identity): Promise<{ location: string; cookie: string }> {
  const start = await post(handlers, '/sign-in/social', {
    provider: 'google',
    callbackURL: '/login',
    errorCallbackURL: '/login',
    newUserCallbackURL: '/register/pending?via=google',
  })
  expect(start.status, await start.clone().text()).toBe(200)
  const authorize = new URL(((await start.json()) as { url: string }).url)
  nextIdentity = who
  const callback = await handlers.GET(
    new Request(`${BASE_URL}/api/auth/callback/google?code=code-${seq}&state=${authorize.searchParams.get('state')}`, {
      headers: { cookie: cookiesFrom(start) },
    }),
  )
  expect(callback.status).toBe(302)
  return { location: callback.headers.get('location') ?? '', cookie: cookiesFrom(callback) }
}

/** 票 8 預授權建出來的樣子：active、有效 teacher 角色、一種登入方式都沒有。 */
async function preauthorizedTeacher(): Promise<{ email: string; userId: string }> {
  const email = uniq('preauth')
  const userId = String(
    (
      await db.sql(
        `insert into users (id, name, email, email_verified, updated_at, status)
         values (gen_random_uuid(), $1, $1, false, now(), 'active') returning id`,
        [email],
      )
    ).rows[0]!.id,
  )
  await db.sql(
    `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at, reason)
     values (gen_random_uuid(), $1, 'teacher', $2, now(), '系辦預授權老師')`,
    [userId, adminId],
  )
  return { email, userId }
}

function applicationFor(email: string) {
  return {
    appliedName: '王小明',
    studentNo: `4${String(++seq).padStart(8, '0')}`,
    departmentClass: '資管三甲',
    phone: '0912345678',
    loginEmail: email,
    password: PASSWORD,
    passwordConfirm: PASSWORD,
  }
}

async function expectPreauthorizedTeacherSignsIn(handlers: Handlers) {
  const t = await preauthorizedTeacher()
  const who = { sub: `sub-preauth-${++seq}`, email: t.email, name: 'Google 陳老師' }
  const result = await googleSignIn(handlers, who)
  expect(result.location).toBe('/login')
  expect(result.cookie).toContain('session_token')
  expect(await userCount(t.email)).toEqual({ n: 1 })
  expect(await one(`select user_id from accounts where provider_id = 'google' and account_id = $1`, [who.sub])).toEqual({
    user_id: t.userId,
  })
}

describe('REGISTRATION_OPEN=false（正式站第一段）', () => {
  let handlers: Handlers
  let registration: RegistrationCommand
  beforeAll(async () => {
    ;({ handlers, registration } = await freshAuth('false'))
  })

  it('直接打 /api/auth/sign-up/email：403＋「目前沒有開放註冊。」，不建帳號', async () => {
    const email = uniq('api')
    const response = await post(handlers, '/sign-up/email', { email, password: PASSWORD, name: '直接打 API' })
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: 'REGISTRATION_CLOSED', message: CLOSED_MESSAGE })
    expect(response.headers.getSetCookie().join(';')).not.toContain('session_token')
    expect(await userCount(email)).toEqual({ n: 0 })
  })

  it('關閉的拒絕排在限速與密碼長度之前：同一個 IP 打 40 次都是 403（不吃註冊桶），短密碼也是 403', async () => {
    const ip = '198.51.100.55'
    for (let i = 0; i < 40; i += 1) {
      const response = await post(handlers, '/sign-up/email', { email: uniq('burst'), password: PASSWORD, name: 'x' }, ip)
      expect(response.status).toBe(403)
    }
    const short = await post(handlers, '/sign-up/email', { email: uniq('short'), password: 'abc', name: 'x' })
    expect(short.status).toBe(403)
  })

  it('註冊的 Server Action 用例（伺服器端呼叫 auth.api.signUpEmail）也被拒絕，不建帳號、不寫申請單', async () => {
    const email = uniq('action')
    await expect(registration.apply({ kind: 'anonymous' }, applicationFor(email), '198.51.100.66')).rejects.toMatchObject({
      status: 'FORBIDDEN',
      body: { code: 'REGISTRATION_CLOSED', message: CLOSED_MESSAGE },
    })
    expect(await userCount(email)).toEqual({ n: 0 })
    expect(await one(`select count(*)::int as n from registration_applications a join users u on u.id = a.user_id where u.email = $1`, [email])).toEqual({ n: 0 })
  })

  it('沒見過的 Google 身分：導回 /login?error=signup_disabled，沒有 session、不建帳號', async () => {
    const email = uniq('google-new')
    const result = await googleSignIn(handlers, { sub: `sub-new-${++seq}`, email, name: '新同學' })
    expect(result.location).toMatch(/^\/login\?error=signup_disabled/)
    expect(result.cookie).not.toContain('session_token')
    expect(await userCount(email)).toEqual({ n: 0 })
  })

  it('系辦預授權的老師第一次用 Google 登入：仍然成功、綁到原帳號（G4）', async () => {
    await expectPreauthorizedTeacherSignsIn(handlers)
  })

  it('已經有帳號的人照常用密碼登入', async () => {
    // 用開著的實例無法在這一段建帳號，直接寫一個 active 帳號＋密碼雜湊（拿套件的雜湊函式）。
    const { hashPassword } = await import('better-auth/crypto')
    const email = uniq('existing')
    const userId = String(
      (
        await db.sql(
          `insert into users (id, name, email, email_verified, updated_at, status)
           values (gen_random_uuid(), '既有同學', $1, false, now(), 'active') returning id`,
          [email],
        )
      ).rows[0]!.id,
    )
    await db.sql(
      `insert into accounts (id, account_id, provider_id, user_id, password, created_at, updated_at)
       values (gen_random_uuid(), $1::text, 'credential', $1::uuid, $2, now(), now())`,
      [userId, await hashPassword(PASSWORD)],
    )
    const signIn = await post(handlers, '/sign-in/email', { email, password: PASSWORD })
    expect(signIn.status).toBe(200)
    expect(cookiesFrom(signIn)).toContain('session_token')
  })
})

describe.each([
  ['REGISTRATION_OPEN=true（測試站）', 'true'],
  ['沒設 REGISTRATION_OPEN（CI、本機）', undefined],
])('%s：行為同今天', (_label, value) => {
  let handlers: Handlers
  let registration: RegistrationCommand
  beforeAll(async () => {
    ;({ handlers, registration } = await freshAuth(value))
  })

  it('直接打 /api/auth/sign-up/email 可以註冊，新帳號待審核', async () => {
    const email = uniq('open-api')
    const response = await post(handlers, '/sign-up/email', { email, password: PASSWORD, name: '開放註冊' })
    expect(response.status).toBe(200)
    expect(await one(`select status from users where email = $1`, [email])).toEqual({ status: 'pending' })
  })

  it('註冊的 Server Action 用例可以註冊', async () => {
    const email = uniq('open-action')
    const result = await registration.apply({ kind: 'anonymous' }, applicationFor(email), freshIp())
    expect(result.ok, JSON.stringify(result)).toBe(true)
    expect(await userCount(email)).toEqual({ n: 1 })
  })

  it('沒見過的 Google 身分：建成待審帳號、導到補資料頁', async () => {
    const email = uniq('open-google')
    const result = await googleSignIn(handlers, { sub: `sub-open-${++seq}`, email, name: '新同學' })
    expect(result.location).toBe('/register/pending?via=google')
    expect(result.cookie).toContain('session_token')
    expect(await one(`select status from users where email = $1`, [email])).toEqual({ status: 'pending' })
  })

  it('系辦預授權的老師第一次用 Google 登入成功', async () => {
    await expectPreauthorizedTeacherSignsIn(handlers)
  })
})
