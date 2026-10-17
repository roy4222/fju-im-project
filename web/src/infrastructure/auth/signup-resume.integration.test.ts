import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  assertTestDatabaseReachable,
  createIsolatedDatabase,
  poolAsRole,
  TEST_DATABASE_URL,
  type IsolatedDatabase,
} from '../../../test/db'
import { migratedSchema } from '../../../test/migrations'
import type { Pool } from 'pg'

/**
 * B 階段 VB-2：續辦未完成的註冊（visitor-r3 設計方案 §3.2；AC-VI-49 的伺服器段）。
 *
 * 真的 Better Auth（`fju_app`）＋真的 PostgreSQL。`signUpOrResume`／`completeSignupResume` 是 VB-3 第 1、2 步
 * Server Action 會呼叫的 wrapper 函式；舊 session 用 HTTP 登入拿 cookie，看它在續辦完成後還有沒有效。
 * 全程 `users`、`accounts` 列數不減少（不刪任何列）。
 */

const BASE_URL = 'http://127.0.0.1:3000'
const P1 = 'First-Password-2026'
const P2 = 'Second-Password-2026'

type Wrapper = typeof import('@/infrastructure/auth/wrapper')

let db: IsolatedDatabase
let app: Pool
let wrapper: Wrapper
let resume: typeof import('@/infrastructure/auth/signup-resume')
let resetEmailOtpLimiters: () => void

beforeAll(async () => {
  await assertTestDatabaseReachable()
  db = await createIsolatedDatabase({ label: 'vb2-signup-resume', setup: migratedSchema })
  app = await poolAsRole(db, 'fju_app')

  const url = new URL(TEST_DATABASE_URL)
  url.username = 'fju_app'
  url.password = process.env.TEST_FJU_APP_PASSWORD ?? 'fju_app_local_test'
  url.searchParams.set('options', `-c search_path=${db.schemaName}`)
  vi.resetModules()
  vi.stubEnv('DATABASE_URL', url.toString())
  vi.stubEnv('BETTER_AUTH_SECRET', 'integration-test-secret-integration-test')
  vi.stubEnv('BETTER_AUTH_URL', BASE_URL)
  vi.stubEnv('GOOGLE_CLIENT_ID', 'test-client-id')
  vi.stubEnv('GOOGLE_CLIENT_SECRET', 'test-client-secret')
  vi.stubEnv('TURNSTILE_SITE_KEY', '')
  vi.stubEnv('TURNSTILE_SECRET_KEY', '')
  vi.stubEnv('MAIL_CAPTURE', '1')
  wrapper = await import('@/infrastructure/auth/wrapper')
  resume = await import('@/infrastructure/auth/signup-resume')
  resetEmailOtpLimiters = (await import('@/infrastructure/auth/auth-instance')).resetEmailOtpLimiters
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await app?.end()
  await db?.close()
})

beforeEach(async () => {
  resetEmailOtpLimiters()
  ;(await import('@/infrastructure/auth/sign-up-rate-limit')).resetSignUpLimiter()
  ;(await import('@/infrastructure/auth/sign-in-rate-limit')).resetSignInLimiter()
})

afterEach(() => {
  vi.useRealTimers()
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
const freshEmail = (label: string) => `vb2-resume-${label}-${Date.now()}-${(counter += 1)}@example.com`
const headers = () => wrapper.authCallHeaders({ ip: '203.0.113.90' })

async function signUp(email: string, password = P1): Promise<string> {
  const response = await call('POST', '/sign-up/email', { email, password, name: '測試' })
  expect(response.status).toBe(200)
  return String((await db.sql(`select id from users where email = $1`, [email])).rows[0]!.id)
}

/** 過了冷卻再開始續辦（註冊那封剛寄過，120 秒內寄不了第二封）；回傳續辦票。 */
async function startResume(email: string, password: string): Promise<string> {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.now() + 121_000)
  try {
    const outcome = await wrapper.signUpOrResume({ email, password, name: '測試' }, headers())
    if (outcome.kind !== 'resume') throw new Error('沒有進續辦')
    return outcome.ticket
  } finally {
    vi.useRealTimers()
  }
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

async function otpMails(email: string): Promise<string[]> {
  const rows = await db.sql(
    `select body_text from mail_outbox where to_email = $1 and template = 'email_otp' order by created_at, id`,
    [email],
  )
  return rows.rows.map((r) => String(r.body_text).match(/驗證碼是 (\d{6})/)![1]!)
}

async function counts(): Promise<{ users: number; accounts: number }> {
  const row = (
    await db.sql(`select (select count(*)::int from users) as users, (select count(*)::int from accounts) as accounts`)
  ).rows[0]!
  return { users: Number(row.users), accounts: Number(row.accounts) }
}

async function passwordHash(userId: string): Promise<string> {
  return String(
    (await db.sql(`select password from accounts where user_id = $1 and provider_id = 'credential'`, [userId])).rows[0]!.password,
  )
}

describe('isResumableSignup：可續辦的謂詞（VB-14 重用同一個）', () => {
  it('剛註冊、沒驗證、沒申請、沒角色 → 可以', async () => {
    const id = await signUp(freshEmail('fresh'))
    expect(await resume.isResumableSignup(app, id)).toBe(true)
  })

  it('已驗證、有申請、有角色（預授權老師）、有 Google、停用 → 都不行', async () => {
    const verified = await signUp(freshEmail('verified'))
    await db.sql(`update users set email_verified = true where id = $1`, [verified])

    const applied = await signUp(freshEmail('applied'))
    await db.sql(
      `insert into registration_applications
         (id, user_id, revision, applied_name, student_no, phone, contact_email, login_email, roster_match, state,
          created_at, created_by_kind, created_by_user_id, updated_at, updated_by_user_id)
       values (gen_random_uuid(), $1, 1, '王小明', '411401001', '0912-345-678', 'a@example.com', 'a@example.com',
               '{}'::jsonb, 'pending', now(), 'user', $1, now(), $1)`,
      [applied],
    )

    const teacher = await signUp(freshEmail('teacher'))
    await db.sql(
      `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at)
       values (gen_random_uuid(), $1, 'teacher', $1, now())`,
      [teacher],
    )

    const google = await signUp(freshEmail('google'))
    await db.sql(
      `insert into accounts (id, account_id, provider_id, user_id, created_at, updated_at)
       values (gen_random_uuid(), 'g-1', 'google', $1, now(), now())`,
      [google],
    )

    const disabled = await signUp(freshEmail('disabled'))
    await db.sql(`update users set status = 'disabled' where id = $1`, [disabled])

    for (const [label, id] of Object.entries({ verified, applied, teacher, google, disabled })) {
      expect(await resume.isResumableSignup(app, id), label).toBe(false)
    }
  })
})

describe('續辦流程（AC-VI-49）', () => {
  it('同 Email 再註冊 → 寄碼、暫存新密碼、什麼都不換；填對碼 → 同一個 id、已驗證、P2 能登入、P1 不行、舊 session 全失效', async () => {
    const email = freshEmail('flow')
    const id = await signUp(email)
    const old = await signIn(email, P1)
    expect(old.status).toBe(200)
    expect(await sessionUser(old.cookie)).toBe(email)
    const before = await counts()
    const hashBefore = await passwordHash(id)

    const ticket = await startResume(email, P2)
    expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(await otpMails(email)).toHaveLength(2)

    // 寄碼這一步什麼都不換：密碼、session、驗證狀態照舊，新密碼只在暫存列（雜湊，不是明文）。
    expect(await passwordHash(id)).toBe(hashBefore)
    expect(await sessionUser(old.cookie)).toBe(email)
    const pending = await db.sql(`select value from verifications where identifier = $1`, [`signup-resume:${email}`])
    expect(pending.rowCount).toBe(1)
    expect(String(pending.rows[0]!.value)).not.toContain(P2)

    const otp = (await otpMails(email)).at(-1)!
    await expect(
      wrapper.completeSignupResume({ email, otp: otp === '000000' ? '111111' : '000000', ticket }, headers()),
    ).rejects.toMatchObject({ body: { code: 'INVALID_OTP' } })
    expect(await passwordHash(id)).toBe(hashBefore)

    const done = await wrapper.completeSignupResume({ email, otp, ticket }, headers())
    expect(done.userId).toBe(id)
    const user = await db.sql(`select id, email_verified from users where email = $1`, [email])
    expect(user.rows).toEqual([{ id, email_verified: true }])
    expect(await counts()).toEqual(before)

    // 舊 session 全部失效；新 session 由回應的 Set-Cookie 帶回來、可以用。
    expect(await sessionUser(old.cookie)).toBeNull()
    const newCookie = done.headers.get('set-cookie') ?? ''
    expect(newCookie).toContain('session_token')
    expect(await sessionUser(newCookie)).toBe(email)
    const sessions = await db.sql(`select login_method from sessions where user_id = $1`, [id])
    expect(sessions.rows).toEqual([{ login_method: 'password' }])

    expect((await signIn(email, P1)).status).toBe(401)
    expect((await signIn(email, P2)).status).toBe(200)

    // 暫存列與驗證碼都用掉了；同一個碼不能再完成第二次。
    const left = await db.sql(`select identifier from verifications where identifier in ($1, $2)`, [
      `signup-resume:${email}`,
      `email-verification-otp-${email}`,
    ])
    expect(left.rowCount).toBe(0)
    await expect(wrapper.completeSignupResume({ email, otp, ticket }, headers())).rejects.toMatchObject({
      body: { code: 'INVALID_OTP' },
    })
  })

  it('不可續辦的 Email（已驗證、預授權老師、停用）：照舊 EMAIL_UNAVAILABLE、不寄信、密碼與 session 不變', async () => {
    const verified = freshEmail('no-verified')
    const verifiedId = await signUp(verified)
    await db.sql(`update users set email_verified = true where id = $1`, [verifiedId])
    const verifiedSession = await signIn(verified, P1)

    const teacher = freshEmail('no-teacher')
    const teacherId = await signUp(teacher)
    await db.sql(
      `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at)
       values (gen_random_uuid(), $1, 'teacher', $1, now())`,
      [teacherId],
    )
    const disabled = freshEmail('no-disabled')
    const disabledId = await signUp(disabled)
    await db.sql(`update users set status = 'disabled' where id = $1`, [disabledId])

    const before = await counts()
    for (const [email, id] of [
      [verified, verifiedId],
      [teacher, teacherId],
      [disabled, disabledId],
    ] as const) {
      const hash = await passwordHash(id)
      const mails = (await otpMails(email)).length
      await expect(wrapper.signUpOrResume({ email, password: P2, name: '測試' }, headers())).rejects.toMatchObject({
        body: { code: 'EMAIL_UNAVAILABLE', message: '這個 Email 無法用來註冊。如果你已經有帳號，請直接登入。' },
      })
      expect(await otpMails(email), email).toHaveLength(mails)
      expect(await passwordHash(id), email).toBe(hash)
      const pending = await db.sql(`select 1 from verifications where identifier = $1`, [`signup-resume:${email}`])
      expect(pending.rowCount, email).toBe(0)
    }
    expect(await sessionUser(verifiedSession.cookie)).toBe(verified)
    expect(await counts()).toEqual(before)
  })

  it('新 Email 走一般註冊（kind: created），第一封驗證碼照常寄', async () => {
    const email = freshEmail('created')
    const outcome = await wrapper.signUpOrResume({ email, password: P1, name: '測試' }, headers())
    expect(outcome.kind).toBe('created')
    expect(await otpMails(email)).toHaveLength(1)
  })

  it('暫存的新密碼過期（10 分鐘）→ SIGNUP_RESUME_EXPIRED，什麼都不改', async () => {
    const email = freshEmail('expired')
    const id = await signUp(email)
    const ticket = await startResume(email, P2)
    await db.sql(`update verifications set expires_at = now() - interval '1 minute' where identifier = $1`, [
      `signup-resume:${email}`,
    ])
    const hash = await passwordHash(id)
    const otp = (await otpMails(email)).at(-1)!
    await expect(wrapper.completeSignupResume({ email, otp, ticket }, headers())).rejects.toMatchObject({
      body: { code: 'SIGNUP_RESUME_EXPIRED' },
    })
    expect(await passwordHash(id)).toBe(hash)
    const user = await db.sql(`select email_verified from users where id = $1`, [id])
    expect(user.rows[0]!.email_verified).toBe(false)
  })

  it('寄碼期間帳號變得不能續辦（例如系辦處理了）→ 完成時整筆 rollback', async () => {
    const email = freshEmail('changed')
    const id = await signUp(email)
    const ticket = await startResume(email, P2)
    await db.sql(`update users set status = 'disabled' where id = $1`, [id])
    const hash = await passwordHash(id)
    const otp = (await otpMails(email)).at(-1)!
    await expect(wrapper.completeSignupResume({ email, otp, ticket }, headers())).rejects.toMatchObject({
      body: { code: 'EMAIL_UNAVAILABLE' },
    })
    expect(await passwordHash(id)).toBe(hash)
  })

  it('同一個碼兩個分頁同時送：只有一個成功', async () => {
    const email = freshEmail('race')
    await signUp(email)
    const ticket = await startResume(email, P2)
    const otp = (await otpMails(email)).at(-1)!
    const results = await Promise.allSettled([
      wrapper.completeSignupResume({ email, otp, ticket }, headers()),
      wrapper.completeSignupResume({ email, otp, ticket }, headers()),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  })

  it('Review 第 1 輪：別人對同一個 Email 再開始續辦（換了碼與密碼）→ 原本的人用最新的碼也套用不到別人的密碼', async () => {
    const email = freshEmail('overwrite')
    const id = await signUp(email)
    const hash = await passwordHash(id)
    const victimTicket = await startResume(email, P2)
    // 別人過了冷卻後用同一個 Email 再開始續辦，填自己的密碼。
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 242_000)
    const attacker = await wrapper.signUpOrResume({ email, password: 'Attacker-Password-2026', name: '測試' }, headers())
    vi.useRealTimers()
    expect(attacker.kind).toBe('resume')
    // 信箱主人拿到的是最新那封的碼；他手上的票是自己那一次的。
    const latest = (await otpMails(email)).at(-1)!
    await expect(wrapper.completeSignupResume({ email, otp: latest, ticket: victimTicket }, headers())).rejects.toMatchObject({
      body: { code: 'SIGNUP_RESUME_EXPIRED' },
    })
    expect(await passwordHash(id)).toBe(hash)
    expect((await signIn(email, 'Attacker-Password-2026')).status).toBe(401)
    expect((await signIn(email, P1)).status).toBe(200)
  })

  it('Review 第 1 輪：驗證碼在 check 之後被新的一封換掉 → 完成交易用提交的碼重驗，拒絕', async () => {
    const email = freshEmail('swap-after-check')
    const id = await signUp(email)
    const ticket = await startResume(email, P2)
    const first = (await otpMails(email)).at(-1)!
    // 模擬「check 已通過、交易還沒跑」時別人換了一封新碼：直接打交易那一步。
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 242_000)
    await wrapper.resendVerificationOtp({ email }, headers())
    vi.useRealTimers()
    await new Promise((resolve) => setTimeout(resolve, 200))
    const hash = await passwordHash(id)
    const result = await resume.finishSignupResume(app, { email, otp: first, ticket })
    expect(result).toEqual({ ok: false, reason: 'expired' })
    expect(await passwordHash(id)).toBe(hash)
  })

  it('Review 第 1 輪：同一個 Email 每隔 121 秒續辦三次都進續辦（每次只扣一次寄碼額度）', async () => {
    const email = freshEmail('resume-thrice')
    await signUp(email)
    const outcomes: string[] = []
    for (let i = 1; i <= 3; i += 1) {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(Date.now() + i * 121_000)
      try {
        outcomes.push((await wrapper.signUpOrResume({ email, password: P2, name: '測試' }, headers())).kind)
      } catch (error) {
        outcomes.push(String((error as { body?: { code?: string } }).body?.code))
      } finally {
        vi.useRealTimers()
      }
    }
    expect(outcomes).toEqual(['resume', 'resume', 'resume'])
  })

  it('公開的 check 端點拿到對的碼也不會觸發續辦（只有內部入口＋續辦用途才會）', async () => {
    const email = freshEmail('public-check')
    const id = await signUp(email)
    await startResume(email, P2)
    const hash = await passwordHash(id)
    const otp = (await otpMails(email)).at(-1)!
    const response = await call('POST', '/email-otp/check-verification-otp', { email, type: 'email-verification', otp })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: true })
    expect(await passwordHash(id)).toBe(hash)
  })
})
