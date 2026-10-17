import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  assertTestDatabaseReachable,
  createIsolatedDatabase,
  poolAsRole,
  TEST_DATABASE_URL,
  type IsolatedDatabase,
} from '../../../test/db'
import { migratedSchema } from '../../../test/migrations'
import { randomUUID } from 'node:crypto'
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

/**
 * 讓套件做一次「順手清理」：`findVerificationValue`（`better-auth/dist/db/internal-adapter.mjs`）每次都會刪掉**所有**
 * `expires_at < now` 的 verifications 列，不分 identifier；公開的 check 端點對任何 Email 都會呼叫它。
 * 正式環境裡任何人查碼都會觸發，所以暫存列不能靠 `expires_at` 當 10 分鐘視窗（主腦裁定：視窗過了、截止內要能重寄復活）。
 */
async function triggerPluginCleanup(): Promise<void> {
  const response = await call(
    'POST',
    '/email-otp/check-verification-otp',
    { email: freshEmail('cleanup'), type: 'email-verification', otp: '000000' },
    { 'x-real-ip': '203.0.113.99' },
  )
  expect(response.status).toBe(400)
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
    // 10 分鐘視窗存在列的 JSON（`windowEndAt`）；`expires_at` 只是列的壽命（截止＋10 分鐘，給套件的順手清理看）。
    const row = (await db.sql(`select value from verifications where identifier = $1`, [`signup-resume:${email}`])).rows[0]!
    await db.sql(`update verifications set value = $2 where identifier = $1`, [
      `signup-resume:${email}`,
      JSON.stringify({ ...(JSON.parse(String(row.value)) as object), windowEndAt: Date.now() - 60_000 }),
    ])
    const hash = await passwordHash(id)
    const otp = (await otpMails(email)).at(-1)!
    await expect(wrapper.completeSignupResume({ email, otp, ticket }, headers())).rejects.toMatchObject({
      body: { code: 'SIGNUP_RESUME_EXPIRED' },
    })
    expect(await passwordHash(id)).toBe(hash)
    const user = await db.sql(`select email_verified from users where id = $1`, [id])
    expect(user.rows[0]!.email_verified).toBe(false)
    // `expires_at` 已過也擋（fail closed；直接打交易，不經套件——套件的順手清理會先把列刪掉）。
    await db.sql(`update verifications set value = $2, expires_at = now() - interval '1 minute' where identifier = $1`, [
      `signup-resume:${email}`,
      String(row.value),
    ])
    expect(await resume.finishSignupResume(app, { email, otp, ticket })).toEqual({ ok: false, reason: 'expired' })
    expect(await passwordHash(id)).toBe(hash)
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
describe('續辦重寄（VB-3 Review 第 1 輪 P3）', () => {
  /** 在「現在＋offset」的時間點跑（冷卻是用 Date 算的）。 */
  async function at<T>(offsetMs: number, fn: () => Promise<T>): Promise<T> {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + offsetMs)
    try {
      return await fn()
    } finally {
      vi.useRealTimers()
    }
  }

  it('票錯、帳號已不能續辦：不寄信、不改綁，回應跟寄出一樣（不丟錯）', async () => {
    const email = freshEmail('resend-bad')
    const id = await signUp(email)
    const ticket = await startResume(email, P2)
    const mails = (await otpMails(email)).length
    const bound = (await db.sql(`select value from verifications where identifier = $1`, [resume.signupResumeIdentifier(email)])).rows[0]!
      .value

    // 票錯（冷卻已過，排除被冷卻擋下的可能）。
    await at(242_000, () => wrapper.resendSignupResumeOtp({ email, ticket: 'not-the-ticket' }, headers()))
    // 帳號已不能續辦（例如已經驗證過）。（10 分鐘視窗過了、截止內的重寄會照常寄：主腦裁定，見下一個 describe。）
    await db.sql(`update users set email_verified = true where id = $1`, [id])
    await at(242_000, () => wrapper.resendSignupResumeOtp({ email, ticket }, headers()))
    await db.sql(`update users set email_verified = false where id = $1`, [id])

    expect((await otpMails(email)).length).toBe(mails)
    const after = (await db.sql(`select value from verifications where identifier = $1`, [resume.signupResumeIdentifier(email)])).rows[0]!
      .value
    expect(after).toBe(bound)
  })

  it('票對：寄一封新碼、改綁；新碼完成續辦（只能用一次），舊碼不能完成', async () => {
    const email = freshEmail('resend-ok')
    const id = await signUp(email)
    const ticket = await startResume(email, P2)
    const oldOtp = (await otpMails(email)).at(-1)!
    const hashBefore = await passwordHash(id)

    await at(242_000, () => wrapper.resendSignupResumeOtp({ email, ticket }, headers()))
    const mails = await otpMails(email)
    const newOtp = mails.at(-1)!
    expect(mails).toHaveLength(3)
    expect(newOtp).not.toBe(oldOtp)

    // 舊碼：套件那一層已經不是最新那封 → 同一句 INVALID_OTP，密碼不變。
    await expect(wrapper.completeSignupResume({ email, otp: oldOtp, ticket }, headers())).rejects.toMatchObject({
      body: { code: 'INVALID_OTP' },
    })
    expect(await passwordHash(id)).toBe(hashBefore)

    const done = await wrapper.completeSignupResume({ email, otp: newOtp, ticket }, headers())
    expect(done.userId).toBe(id)
    expect(await signIn(email, P2)).toMatchObject({ status: 200 })
    // 新碼只能用一次。
    await expect(wrapper.completeSignupResume({ email, otp: newOtp, ticket }, headers())).rejects.toMatchObject({
      body: { code: 'INVALID_OTP' },
    })
  })

  it('改綁之後才完成：暫存列綁的是新碼的雜湊', async () => {
    const email = freshEmail('resend-bind')
    await signUp(email)
    const ticket = await startResume(email, P2)
    await at(242_000, () => wrapper.resendSignupResumeOtp({ email, ticket }, headers()))
    const newOtp = (await otpMails(email)).at(-1)!
    const row = (await db.sql(`select value from verifications where identifier = $1`, [resume.signupResumeIdentifier(email)])).rows[0]!
    expect(JSON.parse(String(row.value)).otpHash).toBe(resume.hashSecret(newOtp))
  })

  it('冷卻 120 秒內再按：429 RATE_LIMITED、不寄信、不改綁（原本那封仍能完成）', async () => {
    const email = freshEmail('resend-cool')
    const id = await signUp(email)
    const ticket = await startResume(email, P2)
    const mails = (await otpMails(email)).length
    // 續辦那封在「現在＋121 秒」寄出；「現在＋150 秒」還在冷卻內。
    await expect(at(150_000, () => wrapper.resendSignupResumeOtp({ email, ticket }, headers()))).rejects.toMatchObject({
      body: { code: 'RATE_LIMITED' },
    })
    expect((await otpMails(email)).length).toBe(mails)
    const done = await wrapper.completeSignupResume({ email, otp: (await otpMails(email)).at(-1)!, ticket }, headers())
    expect(done.userId).toBe(id)
  })
})

/**
 * VB-3 Review 第 2 輪（PR #590）：續辦重寄的兩條反例。
 * 1. Brevo 未設定（或寄失敗）時函式仍回成功、改綁新碼、延長期限 → 舊碼失效、新碼沒送到。
 * 2. 同一張票每 181 秒重寄一次，暫存期限無上限地延長（固定視窗額度一直重開）。
 * 主腦裁定：續辦絕對上限＝票建立起 30 分鐘（存在暫存列、不由 client 帶）；寄送失敗保留原 OTP 與綁定、不延長。
 */
describe('續辦重寄安全（VB-3 Review 第 2 輪）', () => {
  async function at<T>(offsetMs: number, fn: () => Promise<T>): Promise<T> {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + offsetMs)
    try {
      return await fn()
    } finally {
      vi.useRealTimers()
    }
  }

  async function pendingRow(email: string): Promise<{ value: string; expiresAt: number; createdAt: number }> {
    const row = (
      await db.sql(`select value, expires_at, created_at from verifications where identifier = $1`, [
        resume.signupResumeIdentifier(email),
      ])
    ).rows[0]!
    return {
      value: String(row.value),
      expiresAt: new Date(row.expires_at as string).getTime(),
      createdAt: new Date(row.created_at as string).getTime(),
    }
  }

  async function otpRows(email: string): Promise<string[]> {
    const rows = await db.sql(`select value from verifications where identifier = $1 order by created_at, id`, [
      resume.emailOtpIdentifier(email),
    ])
    return rows.rows.map((r) => String(r.value))
  }

  it('反例 1：Brevo 未設定 → 回 mail_failed、暫存列（綁定與期限）原封不動、沒寄出的新碼撤掉，原本那封的碼仍能完成', async () => {
    const email = freshEmail('resend-mailfail')
    const id = await signUp(email)
    const ticket = await startResume(email, P2)
    const oldOtp = (await otpMails(email)).at(-1)!
    const pendingBefore = await pendingRow(email)
    const otpRowsBefore = await otpRows(email)
    expect(otpRowsBefore).toHaveLength(2)

    // 正式寄信模式但沒有金鑰：Brevo 轉接器記 failed／not_configured，不降級成擷取。
    await loadAuth({ MAIL_CAPTURE: '', BREVO_API_KEY: '', MAIL_FROM: '' })
    try {
      expect(await at(242_000, () => wrapper.resendSignupResumeOtp({ email, ticket }, headers()))).toBe('mail_failed')
    } finally {
      await loadAuth()
    }
    const outbox = (
      await db.sql(`select status, error from mail_outbox where to_email = $1 order by created_at desc, id desc limit 1`, [email])
    ).rows[0]
    expect(outbox).toEqual({ status: 'failed', error: 'not_configured' })

    // 不改綁、不延長。
    expect(await pendingRow(email)).toEqual(pendingBefore)
    // 套件在寄信前已插的那列新碼撤掉，否則 check 端點只認最新那列、舊碼在那一層就失效。
    expect(await otpRows(email)).toEqual(otpRowsBefore)

    // 原本那封的碼仍能完成續辦。
    const done = await wrapper.completeSignupResume({ email, otp: oldOtp, ticket }, headers())
    expect(done.userId).toBe(id)
    expect((await signIn(email, P2)).status).toBe(200)
  })

  it('反例 2：同一張票每 181 秒重寄 → 期限最多到票建立後 30 分鐘；過了截止重寄回 timed_out、不寄信、不改綁，完成回 SIGNUP_RESUME_EXPIRED', async () => {
    const email = freshEmail('resend-deadline')
    await signUp(email)
    // 票在「現在＋121 秒」建立：絕對截止＝那一刻＋30 分鐘。
    const ticket = await startResume(email, P2)
    const first = await pendingRow(email)
    const { deadlineAt, windowEndAt } = JSON.parse(first.value) as { deadlineAt?: unknown; windowEndAt?: unknown }
    expect(deadlineAt).toBe(first.createdAt + resume.SIGNUP_RESUME_MAX_SECONDS * 1000)
    expect(windowEndAt).toBe(first.createdAt + resume.SIGNUP_RESUME_TTL_SECONDS * 1000)
    // 列本身活到截止再多 10 分鐘：續辦票 cookie 最多在最後一次寄出後 10 分鐘內還能帶回來，套件的順手清理不能先把列刪掉，
    // 持票的人才一定看得到「續辦已逾時」而不是靜默的 sent。
    expect(first.expiresAt).toBe((deadlineAt as number) + resume.SIGNUP_RESUME_TTL_SECONDS * 1000)

    // Review 的節奏：每 181 秒一次（每個 Email 10 分鐘 5 封的固定視窗擋不住）。截止前的每一次都放行，但期限封頂。
    let sent = 0
    for (let offset = 302_000; offset < 1_921_000; offset += 181_000) {
      expect(await at(offset, () => wrapper.resendSignupResumeOtp({ email, ticket }, headers())), `offset ${offset}`).toBe('sent')
      sent += 1
      const row = await pendingRow(email)
      const json = JSON.parse(row.value) as { deadlineAt?: unknown; windowEndAt?: unknown }
      expect(json.windowEndAt, `offset ${offset}`).toBeLessThanOrEqual(deadlineAt as number)
      expect(json.deadlineAt, `offset ${offset}`).toBe(deadlineAt)
      expect(row.expiresAt, `offset ${offset}`).toBe(first.expiresAt)
    }
    expect(sent).toBe(9)
    const capped = await pendingRow(email)
    expect((JSON.parse(capped.value) as { windowEndAt?: unknown }).windowEndAt).toBe(deadlineAt)
    expect(await otpMails(email)).toHaveLength(2 + sent)

    // 過了截止：先讓套件做一次順手清理（任何人查碼都會觸發），暫存列要還在，重寄才回得出 timed_out 而不是靜默的 sent。
    await at(1_931_000, () => triggerPluginCleanup())
    expect(await pendingRow(email)).toEqual(capped)
    // 不寄信、不改綁、不延長；回 timed_out（票對的人才會看到這一句）。
    expect(await at(1_931_000, () => wrapper.resendSignupResumeOtp({ email, ticket }, headers()))).toBe('timed_out')
    expect(await otpMails(email)).toHaveLength(2 + sent)
    expect(await pendingRow(email)).toEqual(capped)

    // 完成：截止那一刻起交易就擋（直接打交易、時鐘給截止），經 wrapper 也是 SIGNUP_RESUME_EXPIRED。
    const latest = (await otpMails(email)).at(-1)!
    expect(await resume.finishSignupResume(app, { email, otp: latest, ticket }, new Date(deadlineAt as number))).toEqual({
      ok: false,
      reason: 'expired',
    })
    await expect(at(1_931_000, () => wrapper.completeSignupResume({ email, otp: latest, ticket }, headers()))).rejects.toMatchObject({
      body: { code: 'SIGNUP_RESUME_EXPIRED' },
    })
  })

  it('新用途 signup-resume-resend 沒有旁路：Turnstile 有設定而沒帶 token → TURNSTILE_REQUIRED、不寄信、不改綁', async () => {
    const email = freshEmail('resend-turnstile')
    await signUp(email)
    const ticket = await startResume(email, P2)
    const before = await pendingRow(email)
    const mails = (await otpMails(email)).length
    await loadAuth({ TURNSTILE_SITE_KEY: '1x00000000000000000000AA', TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA' })
    try {
      await expect(at(242_000, () => wrapper.resendSignupResumeOtp({ email, ticket }, headers()))).rejects.toMatchObject({
        body: { code: 'TURNSTILE_REQUIRED' },
      })
    } finally {
      await loadAuth()
    }
    expect((await otpMails(email)).length).toBe(mails)
    expect(await pendingRow(email)).toEqual(before)
  })

  it('截止存在暫存列、不由 client 帶：expires_at 被改到截止之後也沒用，改綁與完成都看 deadlineAt', async () => {
    const email = freshEmail('deadline-row')
    const id = await signUp(email)
    const ticket = await startResume(email, P2)
    const { value } = await pendingRow(email)
    const deadlineAt = (JSON.parse(value) as { deadlineAt: number }).deadlineAt
    await db.sql(`update verifications set expires_at = $2 where identifier = $1`, [
      resume.signupResumeIdentifier(email),
      new Date(deadlineAt + 3_600_000),
    ])
    const hash = await passwordHash(id)
    const otp = (await otpMails(email)).at(-1)!

    // 直接呼叫改綁（沒有真的再寄一封）：快照給「最新那列以外的全部」＝只有最新那列算「這一次插的」（改綁要求恰好一列），只驗截止。
    const before = (
      await db.sql(`select id from verifications where identifier = $1 order by created_at desc, id desc offset 1`, [
        resume.emailOtpIdentifier(email),
      ])
    ).rows.map((r) => String(r.id))
    expect(await resume.rebindSignupResumeOtp(app, { email, ticket, before }, new Date(deadlineAt))).toEqual({
      ok: false,
      reason: 'timed_out',
    })
    expect(await resume.finishSignupResume(app, { email, otp, ticket }, new Date(deadlineAt))).toEqual({ ok: false, reason: 'expired' })
    expect(await passwordHash(id)).toBe(hash)

    // 截止前最後一毫秒：改綁放行，但期限只到截止；完成照常。
    expect(await resume.rebindSignupResumeOtp(app, { email, ticket, before }, new Date(deadlineAt - 1))).toEqual({ ok: true })
    const rebound = await pendingRow(email)
    expect((JSON.parse(rebound.value) as { windowEndAt: number }).windowEndAt).toBe(deadlineAt)
    expect(rebound.expiresAt).toBe(deadlineAt + resume.SIGNUP_RESUME_TTL_SECONDS * 1000)
    expect(await resume.finishSignupResume(app, { email, otp, ticket }, new Date(deadlineAt - 1))).toMatchObject({ ok: true, userId: id })
  })

  /** 在「現在＋offset」跑，並回傳那一刻的時間（算視窗用）。 */
  async function atWithNow<T>(offsetMs: number, fn: (now: number) => Promise<T>): Promise<T> {
    vi.useFakeTimers({ toFake: ['Date'] })
    const now = Date.now() + offsetMs
    vi.setSystemTime(now)
    try {
      return await fn(now)
    } finally {
      vi.useRealTimers()
    }
  }

  it('主腦裁定（第 3 輪）：10 分鐘視窗過了、30 分鐘截止內重寄 → 照常寄新碼、改綁、視窗＝min(現在＋10 分鐘, 截止)；新碼可完成；暫存列不被套件的順手清理刪掉', async () => {
    const email = freshEmail('resend-revive')
    const id = await signUp(email)
    const ticket = await startResume(email, P2)
    const first = await pendingRow(email)
    const { deadlineAt } = JSON.parse(first.value) as { deadlineAt: number }
    const mails = (await otpMails(email)).length

    // 視窗過了（票建立起 10 分鐘）：別人查碼觸發套件清理——過期的驗證碼列會被刪，暫存列要還在。
    await at(121_000 + 601_000, () => triggerPluginCleanup())
    expect(await otpRows(email)).toEqual([])
    expect(await pendingRow(email)).toEqual(first)

    // 截止內重寄：照常寄（冷卻、限速、Turnstile 跟公開重寄同一組 hook）、改綁到新碼、視窗＝現在＋10 分鐘。
    const revivedAt = await atWithNow(121_000 + 609_000, async (now) => {
      expect(await wrapper.resendSignupResumeOtp({ email, ticket }, headers())).toBe('sent')
      return now
    })
    expect(await otpMails(email)).toHaveLength(mails + 1)
    const revived = await pendingRow(email)
    const revivedJson = JSON.parse(revived.value) as { otpHash: string; windowEndAt: number; deadlineAt: number }
    expect(revivedJson.otpHash).toBe(resume.hashSecret((await otpMails(email)).at(-1)!))
    expect(revivedJson.windowEndAt).toBe(revivedAt + resume.SIGNUP_RESUME_TTL_SECONDS * 1000)
    expect(revivedJson.deadlineAt).toBe(deadlineAt)
    expect(revived.expiresAt).toBe(first.expiresAt)

    // 視窗又過了、截止前再寄一次：視窗封頂到截止；用最新的碼完成，P2 是新密碼。
    expect(await at(1_400_000, () => wrapper.resendSignupResumeOtp({ email, ticket }, headers()))).toBe('sent')
    expect(await otpMails(email)).toHaveLength(mails + 2)
    expect((JSON.parse((await pendingRow(email)).value) as { windowEndAt: number }).windowEndAt).toBe(deadlineAt)
    const latest = (await otpMails(email)).at(-1)!
    const done = await at(1_410_000, () => wrapper.completeSignupResume({ email, otp: latest, ticket }, headers()))
    expect(done.userId).toBe(id)
    expect((await signIn(email, P2)).status).toBe(200)
  })
})

/**
 * VB-3 Review 第 3 輪（Sol）P2：兩筆續辦重寄**並行**。
 * 套件的寄碼端點在呼叫寄信回呼之前就插了一列新碼；舊版寄失敗的還原是「刪掉比綁定那列更新的全部驗證碼列」——
 * 一筆寄失敗先還原、另一筆隨後寄成功 → 還原誤刪成功那筆的碼（回 sent、收到的碼卻完成不了）；視窗過了、舊碼已被套件清理
 * 之後再寄失敗 → 子查詢找不到綁的那列、沒寄出的新碼殘留。修法：同一個 Email 的重寄在同一個 process 裡排隊（第二筆等第一筆
 * 做完，再被冷卻擋下）；寄碼前拍驗證碼列 id 的快照，失敗只撤「不在快照裡」且恰好一列的那一列，成功要求本次那列還在才改綁。
 *
 * 屏障：把 Cloudflare siteverify 與 Brevo 兩個對外 `fetch` 換成可控制的 promise，才能把一筆重寄停在「Turnstile 驗證中」或
 * 「Brevo 寄送中」，看另一筆有沒有擠進來。Brevo 模式下 `mail_outbox.body_text` 是 NULL，驗證碼從送給 Brevo 的內容抓。
 */
describe('續辦重寄並行（VB-3 Review 第 3 輪 Sol P2）', () => {
  const IP = '203.0.113.92'
  const BREVO_MODE = {
    MAIL_CAPTURE: '',
    BREVO_API_KEY: 'barrier-only',
    MAIL_FROM: 'barrier@example.com',
    TURNSTILE_SITE_KEY: 'barrier',
    TURNSTILE_SECRET_KEY: 'barrier',
  }

  async function at<T>(offsetMs: number, fn: () => Promise<T>): Promise<T> {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + offsetMs)
    try {
      return await fn()
    } finally {
      vi.useRealTimers()
    }
  }

  async function otpRowIds(email: string): Promise<string[]> {
    const rows = await db.sql(`select id from verifications where identifier = $1 order by created_at, id`, [
      resume.emailOtpIdentifier(email),
    ])
    return rows.rows.map((r) => String(r.id))
  }

  async function pendingValue(email: string): Promise<string> {
    const rows = await db.sql(`select value from verifications where identifier = $1`, [resume.signupResumeIdentifier(email)])
    return String(rows.rows[0]!.value)
  }

  /** 最新一封**有內文**的驗證碼信（寄失敗的那封 `body_text` 是 NULL，`otpMails` 會炸）。 */
  async function latestDeliveredOtp(email: string): Promise<string> {
    const rows = await db.sql(
      `select body_text from mail_outbox where to_email = $1 and template = 'email_otp' and body_text is not null
        order by created_at desc, id desc limit 1`,
      [email],
    )
    return String(rows.rows[0]!.body_text).match(/驗證碼是 (\d{6})/)![1]!
  }

  /** 真實時間等一下（只假 `Date`，`setTimeout` 是真的）：排隊中的那筆若會擠進來，這段時間就會打到 Turnstile／Brevo。 */
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 300))

  type Barrier = {
    captcha: Array<(response: Response) => void>
    sends: Array<{ otp: string; resolve: (response: Response) => void }>
    passCaptcha(index: number): void
    failCaptcha(index: number): void
    deliver(index: number): void
    bounce(index: number): void
    drain(): void
  }

  function installBarrier(): Barrier {
    const captcha: Barrier['captcha'] = []
    const sends: Barrier['sends'] = []
    vi.stubGlobal('fetch', (url: unknown, init?: RequestInit) => {
      if (String(url).includes('challenges.cloudflare.com')) return new Promise<Response>((resolve) => captcha.push(resolve))
      if (String(url).includes('api.brevo.com')) {
        const payload = JSON.parse(String(init?.body)) as { textContent: string }
        const otp = payload.textContent.match(/驗證碼是 (\d{6})/)![1]!
        return new Promise<Response>((resolve) => sends.push({ otp, resolve }))
      }
      throw new Error(`測試裡不該打 ${String(url)}`)
    })
    const siteverifyOk = () =>
      new Response(JSON.stringify({ success: true, action: 'resend', hostname: '127.0.0.1' }), { status: 200 })
    const siteverifyNo = () => new Response(JSON.stringify({ success: false }), { status: 200 })
    const brevoOk = (index: number) => new Response(JSON.stringify({ messageId: `barrier-${index}` }), { status: 201 })
    const brevoNo = () => new Response(JSON.stringify({ code: 'invalid_parameter' }), { status: 400 })
    return {
      captcha,
      sends,
      passCaptcha: (index) => captcha[index]!(siteverifyOk()),
      failCaptcha: (index) => captcha[index]!(siteverifyNo()),
      deliver: (index) => sends[index]!.resolve(brevoOk(index)),
      bounce: (index) => sends[index]!.resolve(brevoNo()),
      // 收尾：還停著的全部放失敗（已 resolve 過的再 resolve 是 no-op），讓懸著的呼叫結束。
      drain: () => {
        for (const resolve of captcha) resolve(siteverifyNo())
        for (const send of sends) send.resolve(brevoNo())
      },
    }
  }

  /** 擷取模式先把續辦開好，再換成 Brevo＋Turnstile 模式裝屏障。 */
  async function prepare(label: string): Promise<{ email: string; id: string; ticket: string; oldOtp: string; ids: string[]; pending: string }> {
    const email = freshEmail(label)
    const id = await signUp(email)
    const ticket = await startResume(email, P2)
    const oldOtp = (await otpMails(email)).at(-1)!
    const ids = await otpRowIds(email)
    expect(ids).toHaveLength(2)
    return { email, id, ticket, oldOtp, ids, pending: await pendingValue(email) }
  }

  const hdr = () => wrapper.authCallHeaders({ ip: IP, turnstileToken: randomUUID() })

  /**
   * 同一張票兩筆同時進來：第一筆停在 Turnstile 驗證中時，第二筆**不能**擠進來（舊版：兩筆都過了冷卻檢查，siteverify 被打兩次）；
   * 第一筆寄送期間也一樣。第一筆做完後第二筆才輪到，被冷卻擋下（RATE_LIMITED）、沒打 Turnstile、沒插新碼列。
   */
  async function runPair(barrier: Barrier, email: string, ticket: string, idsBefore: string[]) {
    const a = wrapper.resendSignupResumeOtp({ email, ticket }, hdr())
    const b = wrapper.resendSignupResumeOtp({ email, ticket }, hdr())
    await vi.waitFor(() => expect(barrier.captcha).toHaveLength(1), { timeout: 5_000 })
    await settle()
    expect(barrier.captcha).toHaveLength(1)
    expect(barrier.sends).toHaveLength(0)
    barrier.passCaptcha(0)
    await vi.waitFor(() => expect(barrier.sends).toHaveLength(1), { timeout: 5_000 })
    await settle()
    expect(barrier.captcha).toHaveLength(1)
    // 套件在寄信回呼之前就插了這一筆的新碼列。
    expect(await otpRowIds(email)).toHaveLength(idsBefore.length + 1)
    return { a, b }
  }

  it('一成一敗（Sol 反例）：第一筆寄失敗、第二筆排隊後被冷卻擋下；只撤回寄失敗那一列，原碼可用；冷卻過後寄成功 → 綁的就是寄出的那封、能完成', async () => {
    const { email, id, ticket, oldOtp, ids, pending } = await prepare('pair-fail-then-ok')
    const barrier = installBarrier()
    await loadAuth(BREVO_MODE)
    let delivered = ''
    const outcomes: Promise<unknown>[] = []
    try {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(Date.now() + 242_000)
      const { a, b } = await runPair(barrier, email, ticket, ids)
      outcomes.push(a, b)
      barrier.bounce(0)
      expect(await a).toBe('mail_failed')
      await expect(b).rejects.toMatchObject({ body: { code: 'RATE_LIMITED' } })
      expect(barrier.captcha).toHaveLength(1)
      expect(barrier.sends).toHaveLength(1)
      // 只撤回寄失敗那一列：列集合跟寄之前一模一樣，暫存列原封不動。
      expect(await otpRowIds(email)).toEqual(ids)
      expect(await pendingValue(email)).toBe(pending)

      // 冷卻過了再寄一次，這次 Brevo 收了：多一列、綁的是這封的碼。
      vi.setSystemTime(Date.now() + 121_000)
      const c = wrapper.resendSignupResumeOtp({ email, ticket }, hdr())
      outcomes.push(c)
      await vi.waitFor(() => expect(barrier.captcha).toHaveLength(2), { timeout: 5_000 })
      barrier.passCaptcha(1)
      await vi.waitFor(() => expect(barrier.sends).toHaveLength(2), { timeout: 5_000 })
      barrier.deliver(1)
      expect(await c).toBe('sent')
      delivered = barrier.sends[1]!.otp
      expect(delivered).not.toBe(oldOtp)
      expect(await otpRowIds(email)).toHaveLength(ids.length + 1)
      expect((JSON.parse(await pendingValue(email)) as { otpHash: string }).otpHash).toBe(resume.hashSecret(delivered))
    } finally {
      barrier.drain()
      await Promise.allSettled(outcomes)
      vi.useRealTimers()
      vi.unstubAllGlobals()
      await loadAuth()
    }
    const done = await wrapper.completeSignupResume({ email, otp: delivered, ticket }, headers())
    expect(done.userId).toBe(id)
    expect((await signIn(email, P2)).status).toBe(200)
  })

  it('兩成：第一筆寄成功、第二筆排隊後被冷卻擋下（不打 Turnstile、不寄、不插列）；只多一列、綁的是寄出的那封、能完成', async () => {
    const { email, id, ticket, ids } = await prepare('pair-ok-ok')
    const barrier = installBarrier()
    await loadAuth(BREVO_MODE)
    let delivered = ''
    const outcomes: Promise<unknown>[] = []
    try {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(Date.now() + 242_000)
      const { a, b } = await runPair(barrier, email, ticket, ids)
      outcomes.push(a, b)
      barrier.deliver(0)
      expect(await a).toBe('sent')
      await expect(b).rejects.toMatchObject({ body: { code: 'RATE_LIMITED' } })
      expect(barrier.captcha).toHaveLength(1)
      expect(barrier.sends).toHaveLength(1)
      delivered = barrier.sends[0]!.otp
      expect(await otpRowIds(email)).toHaveLength(ids.length + 1)
      expect((JSON.parse(await pendingValue(email)) as { otpHash: string }).otpHash).toBe(resume.hashSecret(delivered))
    } finally {
      barrier.drain()
      await Promise.allSettled(outcomes)
      vi.useRealTimers()
      vi.unstubAllGlobals()
      await loadAuth()
    }
    const done = await wrapper.completeSignupResume({ email, otp: delivered, ticket }, headers())
    expect(done.userId).toBe(id)
    expect((await signIn(email, P2)).status).toBe(200)
  })

  it('兩敗：第一筆寄失敗、第二筆排隊後被冷卻擋下；冷卻過後再寄又失敗 → 列集合與暫存列都跟寄之前一樣（不累積），原碼仍能完成', async () => {
    const { email, id, ticket, oldOtp, ids, pending } = await prepare('pair-fail-fail')
    const barrier = installBarrier()
    await loadAuth(BREVO_MODE)
    const outcomes: Promise<unknown>[] = []
    try {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(Date.now() + 242_000)
      const { a, b } = await runPair(barrier, email, ticket, ids)
      outcomes.push(a, b)
      barrier.bounce(0)
      expect(await a).toBe('mail_failed')
      await expect(b).rejects.toMatchObject({ body: { code: 'RATE_LIMITED' } })
      expect(await otpRowIds(email)).toEqual(ids)
      expect(await pendingValue(email)).toBe(pending)

      vi.setSystemTime(Date.now() + 121_000)
      const c = wrapper.resendSignupResumeOtp({ email, ticket }, hdr())
      outcomes.push(c)
      await vi.waitFor(() => expect(barrier.captcha).toHaveLength(2), { timeout: 5_000 })
      barrier.passCaptcha(1)
      await vi.waitFor(() => expect(barrier.sends).toHaveLength(2), { timeout: 5_000 })
      expect(await otpRowIds(email)).toHaveLength(ids.length + 1)
      barrier.bounce(1)
      expect(await c).toBe('mail_failed')
      expect(await otpRowIds(email)).toEqual(ids)
      expect(await pendingValue(email)).toBe(pending)
    } finally {
      barrier.drain()
      await Promise.allSettled(outcomes)
      vi.useRealTimers()
      vi.unstubAllGlobals()
      await loadAuth()
    }
    const done = await wrapper.completeSignupResume({ email, otp: oldOtp, ticket }, headers())
    expect(done.userId).toBe(id)
    expect((await signIn(email, P2)).status).toBe(200)
  })

  it('復活前舊碼已被套件清理＋寄失敗 → 沒寄出的新碼撤掉、0 殘留列、暫存列不動；之後寄成功才綁新碼、能完成', async () => {
    const email = freshEmail('revive-mailfail')
    const id = await signUp(email)
    const ticket = await startResume(email, P2)
    const pending = await pendingValue(email)

    // 視窗過了（票建立起 10 分鐘）：別人查碼觸發套件清理，舊碼列沒了、暫存列還在。
    await at(121_000 + 601_000, () => triggerPluginCleanup())
    expect(await otpRowIds(email)).toEqual([])
    expect(await pendingValue(email)).toBe(pending)

    // 截止內重寄但 Brevo 未設定 → mail_failed；套件寄信前插的那列要撤掉（舊版：綁的那列已不在、子查詢是 NULL、一列都不刪 → 殘留 1 列）。
    await loadAuth({ MAIL_CAPTURE: '', BREVO_API_KEY: '', MAIL_FROM: '' })
    try {
      expect(await at(121_000 + 609_000, () => wrapper.resendSignupResumeOtp({ email, ticket }, headers()))).toBe('mail_failed')
    } finally {
      await loadAuth()
    }
    expect(await otpRowIds(email)).toEqual([])
    expect(await pendingValue(email)).toBe(pending)

    // 冷卻過了、截止內再寄，這次寄出：只有這一列、綁的是它、視窗復活、能完成。
    expect(await at(121_000 + 730_000, () => wrapper.resendSignupResumeOtp({ email, ticket }, headers()))).toBe('sent')
    expect(await otpRowIds(email)).toHaveLength(1)
    const latest = await latestDeliveredOtp(email)
    expect((JSON.parse(await pendingValue(email)) as { otpHash: string }).otpHash).toBe(resume.hashSecret(latest))
    const done = await at(121_000 + 740_000, () => wrapper.completeSignupResume({ email, otp: latest, ticket }, headers()))
    expect(done.userId).toBe(id)
    expect((await signIn(email, P2)).status).toBe(200)
  })

  it('VB-14 主腦補充 1（VB-2 冷卻競態）：公開重寄兩筆同時進來只放行一筆——siteverify 只打一次、第二筆當場 429；放行那筆 Turnstile 沒過就放掉冷卻，下一筆才進得來；寄成功後冷卻才真的開始', async () => {
    const email = freshEmail('cooldown-pair')
    await signUp(email)
    const barrier = installBarrier()
    await loadAuth(BREVO_MODE)
    const outcomes: Promise<unknown>[] = []
    try {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(Date.now() + 121_000)
      const a = wrapper.resendVerificationOtp({ email }, hdr())
      const b = wrapper.resendVerificationOtp({ email }, hdr())
      outcomes.push(a, b)
      // 第二筆在 hook 第一步（占冷卻）就被擋下，不等第一筆、不打 Turnstile（舊版：兩筆都過了「先看再記」的冷卻檢查、siteverify 打兩次）。
      await expect(b).rejects.toMatchObject({ body: { code: 'RATE_LIMITED' } })
      await vi.waitFor(() => expect(barrier.captcha).toHaveLength(1), { timeout: 5_000 })
      await settle()
      expect(barrier.captcha).toHaveLength(1)
      expect(barrier.sends).toHaveLength(0)

      // 第一筆 Turnstile 沒過：占的冷卻放掉（不算寄過），第三筆馬上進得來、打到 Turnstile。
      barrier.failCaptcha(0)
      await expect(a).rejects.toMatchObject({ body: { code: 'TURNSTILE_REQUIRED' } })
      const c = wrapper.resendVerificationOtp({ email }, hdr())
      outcomes.push(c)
      await vi.waitFor(() => expect(barrier.captcha).toHaveLength(2), { timeout: 5_000 })
      barrier.passCaptcha(1)
      await vi.waitFor(() => expect(barrier.sends).toHaveLength(1), { timeout: 5_000 })
      // 第三筆寄送中、第四筆進來：冷卻已被第三筆占著 → 429，不打 Turnstile。
      const d = wrapper.resendVerificationOtp({ email }, hdr())
      outcomes.push(d)
      await expect(d).rejects.toMatchObject({ body: { code: 'RATE_LIMITED' } })
      barrier.deliver(0)
      await c
      expect(barrier.captcha).toHaveLength(2)
      expect(barrier.sends).toHaveLength(1)
      // 寄成功之後 120 秒內仍在冷卻；過了才放行。
      await expect(wrapper.resendVerificationOtp({ email }, hdr())).rejects.toMatchObject({ body: { code: 'RATE_LIMITED' } })
      expect(barrier.captcha).toHaveLength(2)
      vi.setSystemTime(Date.now() + 121_000)
      const e = wrapper.resendVerificationOtp({ email }, hdr())
      outcomes.push(e)
      await vi.waitFor(() => expect(barrier.captcha).toHaveLength(3), { timeout: 5_000 })
    } finally {
      barrier.drain()
      await Promise.allSettled(outcomes)
      vi.useRealTimers()
      vi.unstubAllGlobals()
      await loadAuth()
    }
  })

  it('VB-14 主腦補充 3（VB-3 Review 第 4 輪）：續辦重寄寄送期間別條路插了一列更新的碼 → 不綁「全域最新」那封沒寄出的碼：暫存列不改、對外仍 sent；那封外來碼完成不了；下一次重寄只插一列才綁得上、能完成', async () => {
    const { email, id, ticket, ids, pending } = await prepare('rebind-own-row')
    const barrier = installBarrier()
    await loadAuth(BREVO_MODE)
    const outcomes: Promise<unknown>[] = []
    const FOREIGN = '135791'
    let delivered = ''
    try {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(Date.now() + 242_000)
      const a = wrapper.resendSignupResumeOtp({ email, ticket }, hdr())
      outcomes.push(a)
      await vi.waitFor(() => expect(barrier.captcha).toHaveLength(1), { timeout: 5_000 })
      barrier.passCaptcha(0)
      await vi.waitFor(() => expect(barrier.sends).toHaveLength(1), { timeout: 5_000 })
      expect(await otpRowIds(email)).toHaveLength(ids.length + 1)
      // Brevo 還沒回：別條路（例如另一個 process 的公開重寄）替同一個 Email 又插了一列更新的碼，而且沒寄出。
      // 時間用假的 `Date`（套件插列也是用它），這列才會是套件眼中「最新」的那列。
      await db.sql(
        `insert into verifications (id, identifier, value, expires_at, created_at, updated_at)
         values (gen_random_uuid(), $1, $2, $4, $3, $3)`,
        [resume.emailOtpIdentifier(email), `${resume.hashSecret(FOREIGN)}:0`, new Date(Date.now() + 5_000), new Date(Date.now() + 605_000)],
      )
      barrier.deliver(0)
      expect(await a).toBe('sent')
      delivered = barrier.sends[0]!.otp
      expect(delivered).not.toBe(FOREIGN)
      // 快照之後兩列、分不出哪列是自己寄出的 → 不改綁（舊版綁「全域最新」＝外來那封沒寄出的碼）。
      expect(await otpRowIds(email)).toHaveLength(ids.length + 2)
      expect(await pendingValue(email)).toBe(pending)
    } finally {
      barrier.drain()
      await Promise.allSettled(outcomes)
      vi.useRealTimers()
      vi.unstubAllGlobals()
      await loadAuth()
    }
    // 外來那封（套件眼中的最新碼）通得過查碼，但暫存列沒綁它 → SIGNUP_RESUME_EXPIRED、什麼都不改。
    await expect(at(250_000, () => wrapper.completeSignupResume({ email, otp: FOREIGN, ticket }, headers()))).rejects.toMatchObject({
      body: { code: 'SIGNUP_RESUME_EXPIRED' },
    })
    expect(await passwordHash(id)).not.toBe('')
    expect(await pendingValue(email)).toBe(pending)
    // 冷卻過後再寄：這次只插一列 → 綁它、能完成。
    const idsBefore = await otpRowIds(email)
    expect(await at(372_000, () => wrapper.resendSignupResumeOtp({ email, ticket }, headers()))).toBe('sent')
    expect(await otpRowIds(email)).toHaveLength(idsBefore.length + 1)
    const latest = await latestDeliveredOtp(email)
    expect((JSON.parse(await pendingValue(email)) as { otpHash: string }).otpHash).toBe(resume.hashSecret(latest))
    const done = await at(380_000, () => wrapper.completeSignupResume({ email, otp: latest, ticket }, headers()))
    expect(done.userId).toBe(id)
    expect((await signIn(email, P2)).status).toBe(200)
  })
})

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

  it('池只有一條連線時 VB-2 每條路都走得完：首封、我的帳號寄碼、重寄、查碼、驗碼、續辦重寄、續辦完成、忘記密碼、重設密碼', async () => {
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
    // 續辦重寄：寄碼前的快照、寄碼、鎖裡的改綁各自借連線，沒有巢狀借連線（第 3 輪加的快照也一樣）。
    travel(242_000)
    expect(await wrapper.resendSignupResumeOtp({ email: other, ticket }, headers())).toBe('sent')
    vi.useRealTimers()
    expect(await otpMails(other)).toHaveLength(3)
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
