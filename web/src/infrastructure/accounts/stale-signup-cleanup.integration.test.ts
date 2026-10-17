import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  assertTestDatabaseReachable,
  createIsolatedDatabase,
  poolAsRole,
  TEST_DATABASE_URL,
  type IsolatedDatabase,
} from '../../../test/db'
import { migratedSchema } from '../../../test/migrations'

/**
 * B 階段 VB-14：半成品帳號 7 天軟性處理（AC-VI-81；設計方案 §7.5）。
 *
 * 真的 Better Auth（`fju_app`）建帳號、登入拿 cookie；清理全程以 `fju_app` 連線（worker 與 app 共用這個角色），
 * 權限少給一格就紅。不經身分快取，直接查 DB 與 `get-session`。
 */

const BASE_URL = 'http://127.0.0.1:3000'
const P1 = 'First-Password-2026'
const P2 = 'Second-Password-2026'

let db: IsolatedDatabase
let app: Pool
let wrapper: typeof import('@/infrastructure/auth/wrapper')
let resume: typeof import('@/infrastructure/auth/signup-resume')
let cleanup: typeof import('@/infrastructure/accounts/stale-signup-cleanup')

beforeAll(async () => {
  await assertTestDatabaseReachable()
  db = await createIsolatedDatabase({ label: 'vb14-stale-signup', setup: migratedSchema })
  app = await poolAsRole(db, 'fju_app')
  const url = new URL(TEST_DATABASE_URL)
  url.username = 'fju_app'
  url.password = process.env.TEST_FJU_APP_PASSWORD ?? 'fju_app_local_test'
  url.searchParams.set('options', `-c search_path=${db.schemaName}`)
  vi.stubEnv('DATABASE_URL', url.toString())
  vi.stubEnv('BETTER_AUTH_SECRET', 'integration-test-secret-integration-test')
  vi.stubEnv('BETTER_AUTH_URL', BASE_URL)
  vi.stubEnv('GOOGLE_CLIENT_ID', 'test-client-id')
  vi.stubEnv('GOOGLE_CLIENT_SECRET', 'test-client-secret')
  vi.stubEnv('TURNSTILE_SITE_KEY', '')
  vi.stubEnv('TURNSTILE_SECRET_KEY', '')
  vi.stubEnv('MAIL_CAPTURE', '1')
  vi.stubEnv('DB_POOL_MAX', '')
  wrapper = await import('@/infrastructure/auth/wrapper')
  resume = await import('@/infrastructure/auth/signup-resume')
  cleanup = await import('@/infrastructure/accounts/stale-signup-cleanup')
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await app?.end()
  await db?.close()
})

beforeEach(async () => {
  ;(await import('@/infrastructure/auth/auth-instance')).resetEmailOtpLimiters()
  ;(await import('@/infrastructure/auth/sign-up-rate-limit')).resetSignUpLimiter()
  ;(await import('@/infrastructure/auth/sign-in-rate-limit')).resetSignInLimiter()
})

function call(method: 'GET' | 'POST', path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return wrapper.authRouteHandlers[method](
    new Request(`${BASE_URL}/api/auth${path}`, {
      method,
      headers: { 'content-type': 'application/json', origin: BASE_URL, ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
}

let counter = 0
const freshEmail = (label: string) => `vb14-${label}-${Date.now()}-${(counter += 1)}@example.com`

async function signUp(email: string, daysAgo: number): Promise<string> {
  const response = await call('POST', '/sign-up/email', { email, password: P1, name: '測試' })
  expect(response.status).toBe(200)
  const id = String((await db.sql(`select id from users where email = $1`, [email])).rows[0]!.id)
  await db.sql(`update users set created_at = now() - make_interval(days => $2) where id = $1`, [id, daysAgo])
  return id
}

async function signIn(email: string, password: string): Promise<{ status: number; cookie: string }> {
  const response = await call('POST', '/sign-in/email', { email, password })
  return { status: response.status, cookie: response.headers.get('set-cookie') ?? '' }
}

async function sessionUser(cookie: string): Promise<string | null> {
  const response = await call('GET', '/get-session', undefined, { cookie })
  const body = (await response.json()) as { user?: { email?: string } } | null
  return body?.user?.email ?? null
}

const one = async (sql: string, params: unknown[] = []) => (await db.sql(sql, params)).rows[0]!
const password = async (id: string) =>
  (await one(`select password from accounts where user_id = $1 and provider_id = 'credential'`, [id])).password as
    | string
    | null
const sessionCount = async (id: string) =>
  Number((await one(`select count(*)::int as n from sessions where user_id = $1`, [id])).n)
const scrubAudits = async (id: string) =>
  (
    await db.sql(
      `select actor_kind, action, target_type, target_id, scope, payload from audit_events
        where action = 'account.stale_signup_scrubbed' and target_id = $1`,
      [id],
    )
  ).rows
const totals = async () =>
  one(`select (select count(*)::int from users) as users, (select count(*)::int from accounts) as accounts,
              (select count(*)::int from session_revocations) as revocations,
              (select count(*)::int from user_status_events) as status_events`)

describe('scrubStaleSignups（AC-VI-81）', () => {
  it('甲（8 天）清密碼、刪 session、記一筆稽核，第二輪回 0；乙（6 天）、丙（有申請）、有角色、有 Google 的不動', async () => {
    const emailA = freshEmail('a')
    const a = await signUp(emailA, 8)
    const b = await signUp(freshEmail('b'), 6)
    const c = await signUp(freshEmail('c'), 8)
    await db.sql(
      `insert into registration_applications
         (id, user_id, revision, applied_name, student_no, phone, contact_email, login_email, roster_match, state,
          created_at, created_by_kind, created_by_user_id, updated_at, updated_by_user_id)
       values (gen_random_uuid(), $1, 1, '王小明', '411401001', '0912-345-678', 'c@example.com', 'c@example.com',
               '{}'::jsonb, 'pending', now(), 'user', $1, now(), $1)`,
      [c],
    )
    const teacher = await signUp(freshEmail('teacher'), 8)
    await db.sql(
      `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at)
       values (gen_random_uuid(), $1, 'teacher', $1, now())`,
      [teacher],
    )
    const google = await signUp(freshEmail('google'), 8)
    await db.sql(
      `insert into accounts (id, account_id, provider_id, user_id, created_at, updated_at)
       values (gen_random_uuid(), 'g-vb14', 'google', $1, now(), now())`,
      [google],
    )

    const oldA = await signIn(emailA, P1)
    expect(oldA.status).toBe(200)
    expect(await sessionUser(oldA.cookie)).toBe(emailA)
    const untouched = { b, c, teacher, google }
    const hashes = Object.fromEntries(await Promise.all(Object.entries(untouched).map(async ([k, id]) => [k, await password(id)])))
    const before = await totals()
    const sessionsBefore = await sessionCount(a)
    expect(sessionsBefore).toBeGreaterThanOrEqual(1)

    expect(await cleanup.scrubStaleSignups(app, new Date())).toBe(1)

    expect(await password(a)).toBeNull()
    const sessionsOfA = await sessionCount(a)
    expect(sessionsOfA).toBe(0)
    expect(await sessionUser(oldA.cookie)).toBeNull()
    const audits = await scrubAudits(a)
    expect(audits).toEqual([
      {
        actor_kind: 'system',
        action: 'account.stale_signup_scrubbed',
        target_type: 'user',
        target_id: a,
        scope: 'global',
        payload: { daysSinceCreated: 8, sessionsDeleted: sessionsBefore },
      },
    ])
    console.log('[AC-VI-81 證據] 稽核那列', JSON.stringify(audits[0]))
    console.log(`[AC-VI-81 證據] select count(*) from sessions where user_id = <甲> → ${sessionsOfA}`)
    for (const [k, id] of Object.entries(untouched)) {
      expect(await password(id), k).toBe(hashes[k])
      expect(await scrubAudits(id), k).toEqual([])
    }

    // 第二輪：甲的密碼已是 null，不會再被選到，也不再寫稽核。
    expect(await cleanup.scrubStaleSignups(app, new Date())).toBe(0)
    expect(await scrubAudits(a)).toHaveLength(1)
    // 不刪任何列、不走撤 session 執行器（session_revocations／user_status_events 不多列）。
    expect(await totals()).toEqual(before)

    // 舊密碼登不進去；同一個 Email 再註冊 → 進 VB-2 續辦（過了第一封的寄碼冷卻），不是「Email 無法用來註冊」。
    expect((await signIn(emailA, P1)).status).not.toBe(200)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 121_000)
    try {
      const outcome = await wrapper.signUpOrResume(
        { email: emailA, password: P2, name: '測試' },
        wrapper.authCallHeaders({ ip: '203.0.113.91' }),
      )
      expect(outcome.kind).toBe('resume')
    } finally {
      vi.useRealTimers()
    }
    expect(await totals()).toEqual(before)
  })
})

describe('清理與續辦完成同時發生（R2-3 鎖序）', () => {
  const OTP = '246810'
  const TICKET = 'vb14-ticket'
  const NEW_HASH = 'new-password-hash-from-resume'

  /** 建一個滿 8 天的半成品，並把「已開始續辦」的兩列（最新驗證碼、暫存新密碼）直接寫好。 */
  async function pendingResume(label: string): Promise<{ id: string; email: string }> {
    const email = freshEmail(label)
    const id = await signUp(email, 8)
    const otpHash = resume.hashSecret(OTP)
    await db.sql(
      `insert into verifications (id, identifier, value, expires_at, created_at, updated_at)
       values (gen_random_uuid(), $1, $2, now() + interval '10 minutes', now() + interval '1 second', now())`,
      [resume.emailOtpIdentifier(email), `${otpHash}:0`],
    )
    await db.sql(
      `insert into verifications (id, identifier, value, expires_at, created_at, updated_at)
       values (gen_random_uuid(), $1, $2, now() + interval '10 minutes', now(), now())`,
      [
        resume.signupResumeIdentifier(email),
        JSON.stringify({ userId: id, passwordHash: NEW_HASH, otpHash, ticketHash: resume.hashSecret(TICKET) }),
      ],
    )
    return { id, email }
  }

  /** 另開一條連線先鎖住 users 列，讓兩邊依序排在後面；`release` 放掉。 */
  async function holdUserRow(id: string) {
    const client = await app.connect()
    await client.query('begin')
    await client.query('select 1 from users where id = $1 for update', [id])
    return async () => {
      await client.query('rollback')
      client.release()
    }
  }

  /** 等到有 `n` 個連線卡在這句 SQL 的鎖上。 */
  async function waitForLockWaiters(pattern: string, n: number) {
    for (let i = 0; i < 200; i += 1) {
      const row = await one(
        `select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and query like $1`,
        [`%${pattern}%`],
      )
      if (Number(row.n) >= n) return
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error(`等不到鎖：${pattern}`)
  }

  const SCRUB_LOCK = 'select created_at from users where id = $1 for update'
  const FINISH_LOCK = 'select id from users where email = $1 for update'

  it('續辦先拿到鎖：續辦完成，清理鎖到後重驗不是半成品 → 跳過、不寫稽核，密碼是新的', async () => {
    const { id, email } = await pendingResume('race-finish-first')
    const release = await holdUserRow(id)
    const finish = resume.finishSignupResume(app, { email, otp: OTP, ticket: TICKET })
    await waitForLockWaiters(FINISH_LOCK, 1)
    const scrub = cleanup.scrubStaleSignups(app, new Date())
    await waitForLockWaiters(SCRUB_LOCK, 1)
    await release()

    expect(await finish).toMatchObject({ ok: true, userId: id })
    expect(await scrub).toBe(0)
    expect(await password(id)).toBe(NEW_HASH)
    expect((await one(`select email_verified from users where id = $1`, [id])).email_verified).toBe(true)
    expect(await scrubAudits(id)).toEqual([])
  })

  it('清理先拿到鎖：先清密碼，續辦接著把密碼換成新的、標已驗證；不會留下「已驗證卻沒密碼」', async () => {
    const { id, email } = await pendingResume('race-scrub-first')
    const release = await holdUserRow(id)
    const scrub = cleanup.scrubStaleSignups(app, new Date())
    await waitForLockWaiters(SCRUB_LOCK, 1)
    const finish = resume.finishSignupResume(app, { email, otp: OTP, ticket: TICKET })
    await waitForLockWaiters(FINISH_LOCK, 1)
    await release()

    expect(await scrub).toBe(1)
    expect(await finish).toMatchObject({ ok: true, userId: id })
    expect(await password(id)).toBe(NEW_HASH)
    expect((await one(`select email_verified from users where id = $1`, [id])).email_verified).toBe(true)
    expect(await scrubAudits(id)).toHaveLength(1)
    expect(await sessionCount(id)).toBe(0)
    // 已驗證的帳號不再是半成品：之後再跑也不會被清。
    expect(await cleanup.scrubStaleSignups(app, new Date())).toBe(0)
    expect(await password(id)).toBe(NEW_HASH)
  })
})
