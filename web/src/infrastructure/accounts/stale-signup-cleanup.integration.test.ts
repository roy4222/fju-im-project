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

/**
 * 另開一條連線先鎖住 users 列，讓兩邊依序排在後面；`release` 放掉。
 * 用 `for no key update`：跟各條路的 `for update` 衝突（都得排隊），但**不擋** sessions 插入時對 users 列取的外鍵
 * `for key share`——不然登入會先卡在插 session 那句，根本排不到鎖內重驗那句。
 */
async function holdUserRow(id: string) {
  const client = await app.connect()
  await client.query('begin')
  await client.query('select 1 from users where id = $1 for no key update', [id])
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

/** 各條路鎖 users 列的那句 SQL（`waitForLockWaiters` 用來認誰在排隊）。 */
const SCRUB_LOCK = 'select created_at from users where id = $1 for update'
const FINISH_LOCK = 'select id from users where email = $1 for update'
const VERIFY_HOOK_LOCK = 'for update of u'
const SIGNIN_HOOK_LOCK = 'select id from users where id = $1 for update'

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
        JSON.stringify({
          userId: id,
          passwordHash: NEW_HASH,
          otpHash,
          ticketHash: resume.hashSecret(TICKET),
          deadlineAt: Date.now() + 30 * 60_000,
          windowEndAt: Date.now() + 10 * 60_000,
        }),
      ],
    )
    return { id, email }
  }

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

describe('清理與 Better Auth 入口的交錯（Review 第 1 輪 P1 兩條）', () => {
  /**
   * 兩條 P1：套件的 `verify-email`／`sign-in/email` 端點「判斷」與「寫入」之間沒有鎖，清理可以在中間 commit。
   * 修法是把會違反不變條件的那一筆寫入收進**跟清理同一把 users 列鎖**的交易裡重驗（`confirmEmailVerifiedUnderLock`、
   * `revokeSessionUnlessPasswordCurrent`）。這裡用 spy 把端點停在危險點、讓清理插隊，兩個方向都跑，
   * 事後檢查不變條件：沒有「已驗證 ∧ 無密碼 ∧ 無 Google」、沒有「無密碼 ∧ 無 Google ∧ 有 session」。
   */
  type AnyAsync = (...args: unknown[]) => Promise<unknown>

  /**
   * 把 `target[method]` 停在第一次符合 `when` 的呼叫：`after: false` 停在原方法**之前**（判斷已做、寫入未做），
   * `after: true` 停在原方法回來**之後**（寫入已做、後續 hook 未做）。`reached` 解析＝停住了；`release()` 放行。
   */
  function pauseAt(target: object, method: string, options: { when?: (args: unknown[]) => boolean; after?: boolean } = {}) {
    const obj = target as Record<string, AnyAsync>
    const original = obj[method]!
    let fired = false
    let onReached!: () => void
    let onRelease!: () => void
    const reached = new Promise<void>((resolve) => (onReached = resolve))
    const released = new Promise<void>((resolve) => (onRelease = resolve))
    const spy = vi.spyOn(obj, method).mockImplementation(async (...args: unknown[]) => {
      const hit = !fired && (options.when?.(args) ?? true)
      if (hit) fired = true
      if (hit && !options.after) {
        onReached()
        await released
      }
      const result = await original.apply(target, args)
      if (hit && options.after) {
        onReached()
        await released
      }
      return result
    })
    return {
      reached,
      release: () => onRelease(),
      restore: () => spy.mockRestore(),
    }
  }

  async function authContext() {
    return (await import('@/infrastructure/auth/auth-instance')).getAuth().$context
  }

  /** 最新一封寄到這個信箱、有內文的驗證碼（擷取模式寫在 `mail_outbox`）。 */
  async function latestOtp(email: string): Promise<string> {
    const row = await one(
      `select body_text from mail_outbox where to_email = $1 and template = 'email_otp' and body_text is not null
        order by created_at desc, id desc limit 1`,
      [email],
    )
    return String(row.body_text).match(/驗證碼是 (\d{6})/)![1]!
  }

  const verifyEmail = (email: string, otp: string) => call('POST', '/email-otp/verify-email', { email, otp })
  const code = async (response: Response) => ((await response.json()) as { code?: string }).code
  const verified = async (id: string) =>
    (await one(`select email_verified from users where id = $1`, [id])).email_verified as boolean
  const hasGoogle = async (id: string) =>
    Number((await one(`select count(*)::int as n from accounts where user_id = $1 and provider_id <> 'credential'`, [id])).n) > 0

  /** 不變條件（任一時刻、事後都要成立）。 */
  async function assertInvariant(id: string) {
    const noLogin = (await password(id)) === null && !(await hasGoogle(id))
    if (noLogin) {
      expect(await verified(id), '無登入方式卻已驗證').toBe(false)
      expect(await sessionCount(id), '無登入方式卻有 session').toBe(0)
    }
  }

  async function resumeWorks(email: string, id: string) {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 121_000)
    try {
      const outcome = await wrapper.signUpOrResume({ email, password: P2, name: '測試' }, wrapper.authCallHeaders({ ip: '203.0.113.93' }))
      expect(outcome).toMatchObject({ kind: 'resume', email })
    } finally {
      vi.useRealTimers()
    }
    expect(await resume.isResumableSignup(app, id)).toBe(true)
  }

  describe('P1-1 清理 vs 公開驗碼', () => {
    it('清理先 commit，再拿仍有效的碼驗：400 SIGNUP_RESUME_EXPIRED，帳號仍未驗證、沒密碼、可續辦（舊版：200、已驗證卻沒密碼的死帳號）', async () => {
      const email = freshEmail('verify-after-scrub')
      const id = await signUp(email, 8)
      const otp = await latestOtp(email)
      expect(await cleanup.scrubStaleSignups(app, new Date())).toBe(1)

      const response = await verifyEmail(email, otp)
      expect(response.status).toBe(400)
      expect(await code(response)).toBe('SIGNUP_RESUME_EXPIRED')
      expect(await verified(id)).toBe(false)
      expect(await password(id)).toBeNull()
      await assertInvariant(id)
      await resumeWorks(email, id)
    })

    it('驗碼已消耗驗證碼、停在找帳號那一步，清理插隊 commit：驗碼 400、帳號一致（Sol 探針的交錯點）', async () => {
      const email = freshEmail('verify-paused-then-scrub')
      const id = await signUp(email, 8)
      const otp = await latestOtp(email)
      const gate = pauseAt((await authContext()).internalAdapter, 'findUserByEmail', { when: (args) => args[0] === email })
      try {
        const verifying = verifyEmail(email, otp)
        await gate.reached
        // 碼已被套件消耗、帳號還沒標已驗證：清理此刻看到的是半成品，照清。
        expect(await cleanup.scrubStaleSignups(app, new Date())).toBe(1)
        gate.release()
        const response = await verifying
        expect(response.status).toBe(400)
        expect(await code(response)).toBe('SIGNUP_RESUME_EXPIRED')
      } finally {
        gate.restore()
      }
      expect(await verified(id)).toBe(false)
      expect(await password(id)).toBeNull()
      expect(await sessionCount(id)).toBe(0)
      await assertInvariant(id)
      await resumeWorks(email, id)
    })

    it('驗碼的鎖內確認已 commit、停在套件寫 users 之前，清理插隊：清理重驗看到已驗證 → 0；驗碼 200、密碼還在、能登入（舊版：清理清掉密碼 → 死帳號）', async () => {
      const email = freshEmail('verify-locked-then-scrub')
      const id = await signUp(email, 8)
      const otp = await latestOtp(email)
      const gate = pauseAt((await authContext()).adapter, 'update', {
        when: (args) => (args[0] as { model?: string }).model === 'user',
      })
      try {
        const verifying = verifyEmail(email, otp)
        await gate.reached
        expect(await verified(id)).toBe(true)
        expect(await cleanup.scrubStaleSignups(app, new Date())).toBe(0)
        gate.release()
        expect((await verifying).status).toBe(200)
      } finally {
        gate.restore()
      }
      expect(await verified(id)).toBe(true)
      expect(await password(id)).not.toBeNull()
      expect(await scrubAudits(id)).toEqual([])
      expect((await signIn(email, P1)).status).toBe(200)
      await assertInvariant(id)
    })

    it('兩邊同時搶同一把 users 列鎖：先到先贏——驗碼先 → 驗完、清理跳過；清理先 → 清掉、驗碼 400', async () => {
      // 驗碼先排隊
      {
        const email = freshEmail('lock-verify-first')
        const id = await signUp(email, 8)
        const otp = await latestOtp(email)
        const release = await holdUserRow(id)
        let verifying!: Promise<Response>
        let scrub!: Promise<number>
        try {
          verifying = verifyEmail(email, otp)
          await waitForLockWaiters(VERIFY_HOOK_LOCK, 1)
          scrub = cleanup.scrubStaleSignups(app, new Date())
          await waitForLockWaiters(SCRUB_LOCK, 1)
        } finally {
          await release()
        }
        expect((await verifying).status).toBe(200)
        expect(await scrub).toBe(0)
        expect(await verified(id)).toBe(true)
        expect(await password(id)).not.toBeNull()
        await assertInvariant(id)
      }
      // 清理先排隊（舊版的鎖內確認把「鎖」與「讀登入方式」寫在同一句：等到鎖時快照已舊、看不到清理剛清掉的密碼 → 200）
      {
        const email = freshEmail('lock-scrub-first')
        const id = await signUp(email, 8)
        const otp = await latestOtp(email)
        const release = await holdUserRow(id)
        let verifying!: Promise<Response>
        let scrub!: Promise<number>
        try {
          scrub = cleanup.scrubStaleSignups(app, new Date())
          await waitForLockWaiters(SCRUB_LOCK, 1)
          verifying = verifyEmail(email, otp)
          await waitForLockWaiters(VERIFY_HOOK_LOCK, 1)
        } finally {
          await release()
        }
        expect(await scrub).toBe(1)
        const response = await verifying
        expect(response.status).toBe(400)
        expect(await code(response)).toBe('SIGNUP_RESUME_EXPIRED')
        expect(await verified(id)).toBe(false)
        expect(await password(id)).toBeNull()
        await assertInvariant(id)
        await resumeWorks(email, id)
      }
    })

    it('有 Google 的帳號不受影響：清理不碰它（不是候選），驗碼照常 200', async () => {
      const email = freshEmail('verify-google')
      const id = await signUp(email, 8)
      await db.sql(
        `insert into accounts (id, account_id, provider_id, user_id, created_at, updated_at)
         values (gen_random_uuid(), 'g-vb14-verify', 'google', $1, now(), now())`,
        [id],
      )
      const otp = await latestOtp(email)
      expect(await cleanup.scrubStaleSignups(app, new Date())).toBe(0)
      expect((await verifyEmail(email, otp)).status).toBe(200)
      expect(await verified(id)).toBe(true)
    })
  })

  describe('P1-2 清理 vs 密碼登入', () => {
    const noSessionCookie = (cookie: string) => expect(cookie).not.toMatch(/session_token=[^;]+/)

    it('登入驗完舊雜湊、停在建 session 之前（Sol 探針），清理插隊 commit：401、沒發 cookie、0 個 session；下一輪清理 0、稽核 1 筆（舊版：200、拿到有效 session）', async () => {
      const email = freshEmail('login-paused-then-scrub')
      const id = await signUp(email, 8)
      const gate = pauseAt((await authContext()).password, 'verify')
      try {
        const loggingIn = signIn(email, P1)
        await gate.reached
        expect(await cleanup.scrubStaleSignups(app, new Date())).toBe(1)
        gate.release()
        const result = await loggingIn
        expect(result.status).toBe(401)
        noSessionCookie(result.cookie)
      } finally {
        gate.restore()
      }
      expect(await sessionCount(id)).toBe(0)
      expect(await password(id)).toBeNull()
      expect(await cleanup.scrubStaleSignups(app, new Date())).toBe(0)
      expect(await scrubAudits(id)).toHaveLength(1)
      await assertInvariant(id)
      await resumeWorks(email, id)
    })

    it('登入的 session 列已插、停在鎖內重驗之前，清理插隊 commit（清掉密碼、刪掉那列）：401、0 個 session', async () => {
      const email = freshEmail('login-inserted-then-scrub')
      const id = await signUp(email, 8)
      const before = await sessionCount(id) // 註冊會順手登入一次
      const gate = pauseAt((await authContext()).adapter, 'create', {
        when: (args) => (args[0] as { model?: string }).model === 'session',
        after: true,
      })
      try {
        const loggingIn = signIn(email, P1)
        await gate.reached
        expect(await sessionCount(id)).toBe(before + 1)
        expect(await cleanup.scrubStaleSignups(app, new Date())).toBe(1)
        expect(await sessionCount(id)).toBe(0)
        gate.release()
        const result = await loggingIn
        expect(result.status).toBe(401)
        noSessionCookie(result.cookie)
      } finally {
        gate.restore()
      }
      expect(await sessionCount(id)).toBe(0)
      await assertInvariant(id)
    })

    it('兩邊同時搶同一把 users 列鎖：登入先 → 登入 200 但清理緊接著刪掉那個 session（cookie 查不到人）；清理先 → 401', async () => {
      // 登入先排隊：鎖內重驗時密碼還在 → 保留；清理接著拿鎖 → 清密碼、刪 session。沒有任何時刻「無密碼卻有 session」。
      {
        const email = freshEmail('lock-login-first')
        const id = await signUp(email, 8)
        const release = await holdUserRow(id)
        let loggingIn!: Promise<{ status: number; cookie: string }>
        let scrub!: Promise<number>
        try {
          loggingIn = signIn(email, P1)
          await waitForLockWaiters(SIGNIN_HOOK_LOCK, 1)
          scrub = cleanup.scrubStaleSignups(app, new Date())
          await waitForLockWaiters(SCRUB_LOCK, 1)
        } finally {
          await release()
        }
        const result = await loggingIn
        expect(result.status).toBe(200)
        expect(await scrub).toBe(1)
        expect(await sessionCount(id)).toBe(0)
        expect(await sessionUser(result.cookie)).toBeNull()
        await assertInvariant(id)
      }
      // 清理先排隊
      {
        const email = freshEmail('lock-scrub-first-login')
        const id = await signUp(email, 8)
        const release = await holdUserRow(id)
        let loggingIn!: Promise<{ status: number; cookie: string }>
        let scrub!: Promise<number>
        try {
          scrub = cleanup.scrubStaleSignups(app, new Date())
          await waitForLockWaiters(SCRUB_LOCK, 1)
          loggingIn = signIn(email, P1)
          await waitForLockWaiters(SIGNIN_HOOK_LOCK, 1)
        } finally {
          await release()
        }
        expect(await scrub).toBe(1)
        const result = await loggingIn
        expect(result.status).toBe(401)
        noSessionCookie(result.cookie)
        expect(await sessionCount(id)).toBe(0)
        await assertInvariant(id)
      }
    })

    it('登入停在建 session 之前，信箱主人這時用續辦換成新密碼 P2：舊密碼那次登入 401、0 個 session；P2 登入 200', async () => {
      const email = freshEmail('login-vs-resume-finish')
      const id = await signUp(email, 8)
      const OTP = '975310'
      const TICKET = 'vb14-ticket-login'
      const context = await authContext()
      const newHash = await context.password.hash(P2)
      await db.sql(
        `insert into verifications (id, identifier, value, expires_at, created_at, updated_at)
         values (gen_random_uuid(), $1, $2, now() + interval '10 minutes', now() + interval '1 second', now())`,
        [resume.emailOtpIdentifier(email), `${resume.hashSecret(OTP)}:0`],
      )
      await db.sql(
        `insert into verifications (id, identifier, value, expires_at, created_at, updated_at)
         values (gen_random_uuid(), $1, $2, now() + interval '10 minutes', now(), now())`,
        [
          resume.signupResumeIdentifier(email),
          JSON.stringify({
            userId: id,
            passwordHash: newHash,
            otpHash: resume.hashSecret(OTP),
            ticketHash: resume.hashSecret(TICKET),
            deadlineAt: Date.now() + 30 * 60_000,
            windowEndAt: Date.now() + 10 * 60_000,
          }),
        ],
      )
      const gate = pauseAt(context.password, 'verify')
      try {
        const loggingIn = signIn(email, P1)
        await gate.reached
        expect(await resume.finishSignupResume(app, { email, otp: OTP, ticket: TICKET })).toMatchObject({ ok: true, userId: id })
        gate.release()
        const result = await loggingIn
        expect(result.status).toBe(401)
        noSessionCookie(result.cookie)
      } finally {
        gate.restore()
      }
      expect(await sessionCount(id)).toBe(0)
      expect(await verified(id)).toBe(true)
      expect((await signIn(email, P2)).status).toBe(200)
    })

    it('沒被清理的正常登入不受影響：200、session 保留、最後登入方式照記', async () => {
      const email = freshEmail('login-normal')
      const id = await signUp(email, 6)
      const before = await sessionCount(id)
      const result = await signIn(email, P1)
      expect(result.status).toBe(200)
      expect(await sessionUser(result.cookie)).toBe(email)
      expect(await sessionCount(id)).toBe(before + 1)
    })
  })
})

describe('候選分批（Review 第 1 輪 P2）', () => {
  it('前 200 筆（一整批）都不可續辦、第 201 筆合格 → 一次執行就清到第 201 筆', async () => {
    // 200 個滿 8 天、有密碼但有角色的帳號；id 全部排在真的帳號前面（uuidv7 一定比 0000… 大）。
    await db.sql(
      `with fake as (
         select ('00000000-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid as id, n
           from generate_series(1, $1::int) as n
       ), u as (
         insert into users (id, name, email, created_at)
         select id, '不合格', 'vb14-batch-' || n || '@example.com', now() - interval '8 days' from fake
         returning id
       ), a as (
         insert into accounts (id, account_id, provider_id, user_id, password, updated_at)
         select gen_random_uuid(), id::text, 'credential', id, 'hash', now() from u
       )
       insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at)
       select gen_random_uuid(), id, 'teacher', id, now() from u`,
      [cleanup.STALE_SIGNUP_BATCH],
    )
    const target = await signUp(freshEmail('batch-201'), 8)

    expect(await cleanup.scrubStaleSignups(app, new Date())).toBe(1)
    expect(await password(target)).toBeNull()
    expect(await scrubAudits(target)).toHaveLength(1)
    const untouched = await one(
      `select count(*)::int as n from accounts where account_id like '00000000-0000-7000-8000-%' and password = 'hash'`,
    )
    expect(Number(untouched.n)).toBe(cleanup.STALE_SIGNUP_BATCH)
  })
})
