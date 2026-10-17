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

/**
 * 重新載入一份 Better Auth（環境變數在建實例時讀）。`extra` 用來切模式，例如 `DB_POOL_MAX`。
 * `DB_POOL_MAX` 一律明寫（預設空字串＝沒設、上限 10）：`vi.stubEnv` 會跨 describe 留著，不明寫的話
 * 「連線池只有一條」那段之後再載入的實例會沿用 1。
 */
async function loadAuth(extra: Record<string, string> = {}): Promise<void> {
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
  vi.stubEnv('DB_POOL_MAX', '')
  for (const [key, value] of Object.entries(extra)) vi.stubEnv(key, value)
  wrapper = await import('@/infrastructure/auth/wrapper')
  resume = await import('@/infrastructure/auth/signup-resume')
  resetEmailOtpLimiters = (await import('@/infrastructure/auth/auth-instance')).resetEmailOtpLimiters
}

beforeAll(async () => {
  await assertTestDatabaseReachable()
  db = await createIsolatedDatabase({ label: 'vb2-signup-resume', setup: migratedSchema })
  app = await poolAsRole(db, 'fju_app')
  await loadAuth()
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

  it('寄碼之後、綁定之前帳號變得不能續辦（信箱主人剛完成別的續辦）→ 不留暫存，呼叫端照舊 EMAIL_UNAVAILABLE', async () => {
    const email = freshEmail('verified-while-sending')
    const id = await signUp(email)
    const result = await resume.startSignupResume(app, {
      userId: id,
      email,
      // 寄碼那一刻帳號被標成已驗證（真的寄碼走套件；這裡只重現「寄完才變得不能續辦」的時序）。
      send: async () => {
        await db.sql(`update users set email_verified = true where id = $1`, [id])
      },
      passwordHash: async () => 'unused',
    })
    expect(result).toEqual({ ok: false, reason: 'not_resumable' })
    const pending = await db.sql(`select 1 from verifications where identifier = $1`, [`signup-resume:${email}`])
    expect(pending.rowCount).toBe(0)
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

/**
 * Review 第 2 輪反例（PR #577）：`5a736f5` 的續辦開始先占住一條連線拿鎖、再經套件寄碼，套件與寄信轉接器向同一個池再借
 * → `DB_POOL_MAX=1` 時死等到 `connectionTimeoutMillis`（5 秒；套件寄碼會重試，共約 15 秒）。
 *
 * 規則：**同一請求內不得在持有交易連線時再向同池借連線。** 池只有一條時，任何一條路巢狀借連線都會在這裡逾時，
 * 所以把 VB-2 改動或新增的每條 auth 路徑都在池只有一條的實例上走一遍。
 */
describe('Review 第 2 輪：DB_POOL_MAX=1（持有連線時不得再向同池借連線）', () => {
  beforeAll(async () => {
    await loadAuth({ DB_POOL_MAX: '1' })
  })
  afterAll(async () => {
    await loadAuth()
  })

  /** 只假 `Date`，偏移量從真實時間算（連續呼叫不累加）。 */
  function travel(ms: number): void {
    vi.useRealTimers()
    const base = Date.now()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(base + ms)
  }

  /** 公開重寄與重設密碼信不等寄信結果，列會稍晚出現。 */
  async function waitForMails(email: string, template: string, count: number): Promise<string[]> {
    for (let i = 0; i < 60; i += 1) {
      const rows = await db.sql(
        `select body_text from mail_outbox where to_email = $1 and template = $2 order by created_at, id`,
        [email, template],
      )
      if (rows.rowCount >= count) return rows.rows.map((r) => String(r.body_text))
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(`等不到 ${email} 的第 ${count} 封 ${template}`)
  }

  it('Review 反例：池只有一條連線時，續辦開始不死等（寄碼不在持有連線時進行）', async () => {
    const email = freshEmail('pool-one')
    await signUp(email)
    const startedAt = Date.now()
    const ticket = await startResume(email, P2)
    // 池的 connectionTimeoutMillis 是 5 秒：巢狀借連線會在這裡等滿 5 秒才失敗（舊版約 15 秒）。
    expect(Date.now() - startedAt).toBeLessThan(4_000)
    expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(await otpMails(email)).toHaveLength(2)
    const pending = await db.sql(`select 1 from verifications where identifier = $1`, [`signup-resume:${email}`])
    expect(pending.rowCount).toBe(1)
  })

  it('池只有一條連線時 VB-2 每條路都走得完：首封、我的帳號寄碼、重寄、查碼、驗碼、續辦完成、忘記密碼、重設密碼', async () => {
    const ip = '203.0.113.91'
    // 註冊 → 伺服器寄首封（hooks.after 以內部呼叫打寄碼端點）。
    const email = freshEmail('pool-all')
    const id = await signUp(email)
    expect(await otpMails(email)).toHaveLength(1)

    // 「我的帳號」寄碼（內部入口：hook 讀 session、再經套件寄碼）。
    const { cookie } = await signIn(email, P1)
    travel(121_000)
    await wrapper.sendOwnVerificationOtp(new Headers({ cookie, 'x-real-ip': ip }))
    expect(await otpMails(email)).toHaveLength(2)

    // 公開重寄（HTTP；寄信不等結果）。
    travel(242_000)
    const resent = await call('POST', '/email-otp/send-verification-otp', { email, type: 'email-verification' }, { 'x-real-ip': ip })
    expect(resent.status).toBe(200)
    await waitForMails(email, 'email_otp', 3)
    vi.useRealTimers()

    // 查碼（公開 check）→ 驗碼（verify；標已驗證、刪那一列）。
    const otp = (await otpMails(email)).at(-1)!
    const checked = await call('POST', '/email-otp/check-verification-otp', { email, type: 'email-verification', otp }, { 'x-real-ip': ip })
    expect(checked.status).toBe(200)
    const verified = await call('POST', '/email-otp/verify-email', { email, otp }, { 'x-real-ip': ip })
    expect(verified.status).toBe(200)
    expect((await db.sql(`select email_verified from users where id = $1`, [id])).rows[0]!.email_verified).toBe(true)

    // 續辦開始 → 完成（完成的交易持有唯一那條連線，交易裡只用它；之後才發 session）。
    const other = freshEmail('pool-all-resume')
    const otherId = await signUp(other)
    const ticket = await startResume(other, P2)
    const done = await wrapper.completeSignupResume({ email: other, otp: (await otpMails(other)).at(-1)!, ticket }, headers())
    expect(done.userId).toBe(otherId)
    expect((await signIn(other, P2)).status).toBe(200)

    // 忘記密碼（寄重設連結不等結果）→ 重設密碼（撤 session、換密碼）→ 新密碼能登入。
    const asked = await call('POST', '/request-password-reset', { email, redirectTo: '/reset-password' }, { 'x-real-ip': ip })
    expect(asked.status).toBe(200)
    const [resetMail] = await waitForMails(email, 'password_reset', 1)
    const token = decodeURIComponent(resetMail!.match(/token=([^。\s]+)/)![1]!)
    const reset = await call('POST', '/reset-password', { token, newPassword: 'Pool-Of-One-Password-2026' }, { 'x-real-ip': ip })
    expect(reset.status).toBe(200)
    expect((await signIn(email, P1)).status).toBe(401)
    expect((await signIn(email, 'Pool-Of-One-Password-2026')).status).toBe(200)
  })
})
