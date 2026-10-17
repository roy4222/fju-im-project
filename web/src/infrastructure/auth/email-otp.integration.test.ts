import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  assertTestDatabaseReachable,
  createIsolatedDatabase,
  TEST_DATABASE_URL,
  type IsolatedDatabase,
} from '../../../test/db'
import { migratedSchema } from '../../../test/migrations'

/**
 * B 階段 VB-2：Email 驗證碼、重設密碼、限速、Turnstile 掛進 `hooks.before`（visitor-r3 設計方案 §3.2、§3.4、§3.8）。
 *
 * 真的 Better Auth 實例以 `fju_app` 打真的 PostgreSQL（隔離 schema）；HTTP 那條走真的 route handler，
 * Server Action 那條直接呼叫 wrapper 的函式（跟頁面的 Server Action 一樣經 `auth.api.*`、沒有 request）。
 * 寄信是擷取模式（`test/mail-capture-setup.ts`），驗證碼從 `mail_outbox.body_text` 讀。
 * Turnstile 不打 Cloudflare：把全域 `fetch` 換成 siteverify 替身。
 *
 * 對應 AC-VI-47（限速與冷卻）、48（DB 段）、59（寄信段）、60（token 與 session 段）、66（伺服器段）、67、72、76（OTP 寄失敗）。
 */

const BASE_URL = 'http://127.0.0.1:3000'
const PASSWORD = 'Correct-Horse-Battery-9'
const TURNSTILE_PASS_SITE = '1x00000000000000000000AA'
const TURNSTILE_PASS_SECRET = '1x0000000000000000000000000000000AA'

type Wrapper = typeof import('@/infrastructure/auth/wrapper')
type Instance = typeof import('@/infrastructure/auth/auth-instance')

let db: IsolatedDatabase
let wrapper: Wrapper
let instance: Instance

/** 重新載入一份 Better Auth（環境變數在建實例時讀，所以每一種模式各載一次）。 */
async function loadAuth(env: Record<string, string>): Promise<void> {
  vi.resetModules()
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
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
  wrapper = await import('@/infrastructure/auth/wrapper')
  instance = await import('@/infrastructure/auth/auth-instance')
  instance.getAuth()
}

async function resetLimiters(): Promise<void> {
  instance.resetEmailOtpLimiters()
  ;(await import('@/infrastructure/auth/sign-up-rate-limit')).resetSignUpLimiter()
  ;(await import('@/infrastructure/auth/sign-in-rate-limit')).resetSignInLimiter()
}

beforeAll(async () => {
  await assertTestDatabaseReachable()
  db = await createIsolatedDatabase({ label: 'vb2-email-otp', setup: migratedSchema })
})

afterAll(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  await db?.close()
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

async function json(response: Response): Promise<{ code?: string; message?: string }> {
  return (await response.json()) as { code?: string; message?: string }
}

let counter = 0
function freshEmail(label: string): string {
  counter += 1
  return `vb2-${label}-${Date.now()}-${counter}@example.com`
}

async function outbox(email: string) {
  return (
    await db.sql(
      `select template, subject, body_text, status, error from mail_outbox where to_email = $1 order by created_at, id`,
      [email],
    )
  ).rows as { template: string; subject: string; body_text: string | null; status: string; error: string | null }[]
}

/** 最新一封驗證碼（擷取模式存全文）。 */
async function latestOtp(email: string): Promise<string> {
  const rows = (await outbox(email)).filter((r) => r.template === 'email_otp')
  const match = rows.at(-1)?.body_text?.match(/驗證碼是 (\d{6})/)
  if (!match) throw new Error(`沒有 ${email} 的驗證碼`)
  return match[1]!
}

/** 重設密碼信不等寄信結果（對外回應時間一致），所以列會稍晚出現。 */
async function waitForOutbox(email: string, template: string, count = 1) {
  for (let i = 0; i < 50; i += 1) {
    const rows = (await outbox(email)).filter((r) => r.template === template)
    if (rows.length >= count) return rows
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`等不到 ${email} 的 ${template}`)
}

async function signUp(email: string, headers: Record<string, string> = {}): Promise<Response> {
  return call('POST', '/sign-up/email', { email, password: PASSWORD, name: '測試' }, headers)
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

/** 只假 `Date`（限速桶看 `Date.now()`）；計時器照真的跑，pg 與 fetch 不受影響。 */
function travel(ms: number): void {
  const now = Date.now()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(now + ms)
}

// ── 金鑰都沒設（本機、CI）＋擷取模式 ─────────────────────────────────────────

describe('驗證碼：首寄、hashed、驗證（Turnstile 關閉）', () => {
  beforeAll(async () => {
    await loadAuth({})
  })
  beforeEach(resetLimiters)

  it('註冊成功由伺服器寄出第一封驗證碼；主旨不含碼、verifications 只存雜湊（AC-VI-46、67）', async () => {
    const email = freshEmail('first')
    const response = await signUp(email)
    expect(response.status).toBe(200)

    const mails = await outbox(email)
    expect(mails).toHaveLength(1)
    expect(mails[0]).toMatchObject({ template: 'email_otp', subject: '【專題管理平台】Email 驗證碼', status: 'captured' })
    expect(mails[0]!.subject).not.toMatch(/\d{6}/)
    const otp = await latestOtp(email)

    const stored = await db.sql(`select value from verifications where identifier = $1`, [`email-verification-otp-${email}`])
    expect(stored.rows).toHaveLength(1)
    const value = String(stored.rows[0]!.value)
    expect(value).not.toContain(otp)
    expect(value).toMatch(/^[A-Za-z0-9_-]{43}:0$/)
  })

  it('填對碼 → email_verified = true，那筆驗證碼被刪（AC-VI-48 的 DB 段）', async () => {
    const email = freshEmail('verify')
    await signUp(email)
    const response = await call('POST', '/email-otp/verify-email', { email, otp: await latestOtp(email) })
    expect(response.status).toBe(200)
    const user = await db.sql(`select email_verified from users where email = $1`, [email])
    expect(user.rows[0]!.email_verified).toBe(true)
    const left = await db.sql(`select 1 from verifications where identifier = $1`, [`email-verification-otp-${email}`])
    expect(left.rowCount).toBe(0)
  })

  it('(a) 錯 5 次之後正確碼也失效（allowedAttempts 5）', async () => {
    const email = freshEmail('attempts')
    await signUp(email)
    const otp = await latestOtp(email)
    const wrong = otp === '000000' ? '111111' : '000000'
    for (let i = 1; i <= 5; i += 1) {
      const response = await call('POST', '/email-otp/verify-email', { email, otp: wrong })
      expect(response.status, `第 ${i} 次`).toBe(400)
      expect((await json(response)).code).toBe('INVALID_OTP')
    }
    const late = await call('POST', '/email-otp/verify-email', { email, otp })
    expect(late.status).toBe(403)
    expect((await json(late)).code).toBe('TOO_MANY_ATTEMPTS')
    const user = await db.sql(`select email_verified from users where email = $1`, [email])
    expect(user.rows[0]!.email_verified).toBe(false)
  })

  it('只收 email-verification 型別（OTP 登入、OTP 重設不開）', async () => {
    const email = freshEmail('type')
    await signUp(email)
    for (const type of ['sign-in', 'forget-password']) {
      const response = await call('POST', '/email-otp/send-verification-otp', { email, type })
      expect(response.status, type).toBe(400)
    }
    expect(await outbox(email)).toHaveLength(1)
  })
})

describe('驗證碼限速與冷卻（AC-VI-47、72）', () => {
  beforeAll(async () => {
    await loadAuth({})
  })
  beforeEach(resetLimiters)

  it('(b) 註冊後未滿 120 秒直接打寄碼端點 → 429；(c) 滿 120 秒重寄 → 多一封新碼', async () => {
    const email = freshEmail('cooldown')
    await signUp(email)
    const first = await latestOtp(email)

    const tooSoon = await call('POST', '/email-otp/send-verification-otp', { email, type: 'email-verification' })
    expect(tooSoon.status).toBe(429)
    expect((await json(tooSoon)).code).toBe('RATE_LIMITED')
    expect(await outbox(email)).toHaveLength(1)

    travel(120_000)
    const later = await call('POST', '/email-otp/send-verification-otp', { email, type: 'email-verification' })
    expect(later.status).toBe(200)
    expect(await outbox(email)).toHaveLength(2)
    // 新的一封是新碼，舊碼不再能用（套件換掉了那一列）。
    const second = await latestOtp(email)
    if (second !== first) {
      const old = await call('POST', '/email-otp/check-verification-otp', { email, type: 'email-verification', otp: first })
      expect(old.status).toBe(400)
    }
  })

  it('(d) 同一個 Email 10 分鐘 5 封：註冊那封與重送註冊都算，第 6 次 → 429「寄太多次了，請 10 分鐘後再試。」', async () => {
    // 冷卻 120 秒，光靠重寄在 10 分鐘內最多 5 封；重送同一個 Email 的註冊每次也扣這個額度（不能繞過）。
    const email = freshEmail('five')
    await signUp(email)
    for (let i = 2; i <= 5; i += 1) {
      const again = await signUp(email)
      expect(again.status, `第 ${i} 次註冊`).toBe(400)
    }
    travel(121_000)
    const sixth = await call('POST', '/email-otp/send-verification-otp', { email, type: 'email-verification' })
    expect(sixth.status).toBe(429)
    expect((await json(sixth)).message).toBe('寄太多次了，請 10 分鐘後再試。')
    expect((await outbox(email)).filter((m) => m.template === 'email_otp')).toHaveLength(1)

    vi.useRealTimers()
    travel(601_000)
    const later = await call('POST', '/email-otp/send-verification-otp', { email, type: 'email-verification' })
    expect(later.status).toBe(200)
  })

  it('重寄 4 次（每次等冷卻）都放行：註冊 1 封＋重寄 4 封＝5 封', async () => {
    const email = freshEmail('resend-four')
    await signUp(email)
    for (let i = 1; i <= 4; i += 1) {
      travel(i * 121_000)
      const response = await call('POST', '/email-otp/send-verification-otp', { email, type: 'email-verification' })
      expect(response.status, `第 ${i} 次重寄`).toBe(200)
      vi.useRealTimers()
    }
    expect((await outbox(email)).filter((m) => m.template === 'email_otp')).toHaveLength(5)
  })

  it('(e) verify 與 check 交替送錯碼：沒有套件的 3 次／60 秒，共用 otpVerify 桶，第 11 次 429', async () => {
    const email = freshEmail('verify-bucket')
    await signUp(email)
    for (let i = 1; i <= 10; i += 1) {
      const path = i % 2 === 1 ? '/email-otp/verify-email' : '/email-otp/check-verification-otp'
      const response = await call('POST', path, { email, type: 'email-verification', otp: '999999' })
      expect(response.status, `第 ${i} 次 ${path}`).not.toBe(429)
    }
    const eleventh = await call('POST', '/email-otp/check-verification-otp', { email, type: 'email-verification', otp: '999999' })
    expect(eleventh.status).toBe(429)
    expect((await json(eleventh)).code).toBe('RATE_LIMITED')
  })

  it('(f) Server Action 與 HTTP 共用同一組桶：冷卻與 5 封額度兩條路一起算', async () => {
    const headers = wrapper.authCallHeaders({ ip: '203.0.113.50' })
    // 冷卻：Server Action 重寄之後，馬上打 HTTP → 429。
    const a = freshEmail('shared-cooldown')
    await signUp(a)
    travel(121_000)
    await wrapper.resendVerificationOtp({ email: a }, headers)
    const tooSoon = await call('POST', '/email-otp/send-verification-otp', { email: a, type: 'email-verification' })
    expect(tooSoon.status).toBe(429)
    vi.useRealTimers()

    // 額度：註冊 1＋重送註冊 3＝4，Server Action 第 5 封放行，HTTP 第 6 封 429。
    const b = freshEmail('shared-quota')
    await signUp(b)
    for (let i = 0; i < 3; i += 1) await signUp(b)
    travel(121_000)
    await wrapper.resendVerificationOtp({ email: b }, headers)
    vi.useRealTimers()
    travel(242_000)
    const sixth = await call('POST', '/email-otp/send-verification-otp', { email: b, type: 'email-verification' })
    expect(sixth.status).toBe(429)
    expect((await json(sixth)).message).toBe('寄太多次了，請 10 分鐘後再試。')
    vi.useRealTimers()

    // 反過來：HTTP 第 5 封放行，Server Action 第 6 封 429。
    const c = freshEmail('shared-quota-2')
    await signUp(c)
    for (let i = 0; i < 3; i += 1) await signUp(c)
    travel(121_000)
    expect((await call('POST', '/email-otp/send-verification-otp', { email: c, type: 'email-verification' })).status).toBe(200)
    vi.useRealTimers()
    travel(242_000)
    await expect(wrapper.resendVerificationOtp({ email: c }, headers)).rejects.toMatchObject({ status: 'TOO_MANY_REQUESTS' })
  })

  it('同一個 IP 每小時 20 封（換 Email 也一樣），第 21 封 429', async () => {
    const emails: string[] = []
    for (let i = 0; i < 21; i += 1) {
      const email = freshEmail(`ip-${i}`)
      expect((await signUp(email)).status).toBe(200)
      emails.push(email)
    }
    travel(121_000)
    const headers = { 'x-real-ip': '198.51.100.77' }
    for (const email of emails.slice(0, 20)) {
      const response = await call('POST', '/email-otp/send-verification-otp', { email, type: 'email-verification' }, headers)
      expect(response.status, email).toBe(200)
    }
    const blocked = await call('POST', '/email-otp/send-verification-otp', { email: emails[20], type: 'email-verification' }, headers)
    expect(blocked.status).toBe(429)
    expect((await json(blocked)).message).toBe('這個網路寄驗證碼的次數已達上限，最晚 1 小時後可以再試。')
  })
})

// ── 忘記密碼、重設密碼 ───────────────────────────────────────────────────────

describe('忘記密碼與重設（AC-VI-59 寄信段、60 token 與 session 段）', () => {
  let email: string

  beforeAll(async () => {
    await loadAuth({})
    await resetLimiters()
    email = freshEmail('reset')
    await signUp(email)
  })
  beforeEach(resetLimiters)

  it('存在與不存在的 Email 回同一個結果；只有存在的那個有信，主旨不含 token、內文是站內重設網址', async () => {
    const existing = await call('POST', '/request-password-reset', { email, redirectTo: '/reset-password' })
    const nobodyEmail = freshEmail('nobody')
    const nobody = await call('POST', '/request-password-reset', { email: nobodyEmail, redirectTo: '/reset-password' })
    expect(existing.status).toBe(200)
    expect(nobody.status).toBe(200)
    expect(await existing.json()).toEqual(await nobody.json())

    const [mail] = await waitForOutbox(email, 'password_reset')
    expect(mail!.subject).toBe('【專題管理平台】重設密碼')
    expect(mail!.subject).not.toMatch(/token/i)
    expect(mail!.body_text).toContain(`${BASE_URL}/reset-password?token=`)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(await outbox(nobodyEmail)).toEqual([])
  })

  it('同一個 Email 一小時內第 6 次 → 429「寄太多次了，請一小時後再試。」', async () => {
    const target = freshEmail('reset-limit')
    for (let i = 1; i <= 5; i += 1) {
      const response = await call('POST', '/request-password-reset', { email: target, redirectTo: '/reset-password' })
      expect(response.status, `第 ${i} 次`).toBe(200)
    }
    const sixth = await call('POST', '/request-password-reset', { email: target, redirectTo: '/reset-password' })
    expect(sixth.status).toBe(429)
    expect((await json(sixth)).message).toBe('寄太多次了，請一小時後再試。')
  })

  it('11 字被擋；12 字成功 → 撤掉全部舊 session、新密碼能登入、舊密碼不行；同一 token 再用無效', async () => {
    const other = await signIn(email, PASSWORD)
    expect(other.status).toBe(200)
    expect(await sessionUser(other.cookie)).toBe(email)

    await call('POST', '/request-password-reset', { email, redirectTo: '/reset-password' })
    const rows = await waitForOutbox(email, 'password_reset', 2)
    const token = decodeURIComponent(rows.at(-1)!.body_text!.match(/token=([^。\s]+)/)![1]!)

    const short = await call('POST', '/reset-password', { token, newPassword: 'Short-pw-11' })
    expect(short.status).toBe(400)
    expect((await json(short)).message).toBe('密碼至少 12 字。')

    const newPassword = 'Brand-New-Password-2026'
    const ok = await call('POST', '/reset-password', { token, newPassword })
    expect(ok.status).toBe(200)

    const sessions = await db.sql(`select count(*)::int as n from sessions s join users u on u.id = s.user_id where u.email = $1`, [email])
    expect(sessions.rows[0]!.n).toBe(0)
    expect(await sessionUser(other.cookie)).toBeNull()
    expect((await signIn(email, PASSWORD)).status).toBe(401)
    expect((await signIn(email, newPassword)).status).toBe(200)

    const again = await call('POST', '/reset-password', { token, newPassword: 'Another-Password-2026' })
    expect(again.status).toBe(400)
    expect((await json(again)).code).toBe('INVALID_TOKEN')
  })

  it('過期的 token（30 分鐘）無效；連結有效期設定是 30 分鐘', async () => {
    const target = freshEmail('reset-expired')
    await signUp(target)
    await call('POST', '/request-password-reset', { email: target, redirectTo: '/reset-password' })
    const [mail] = await waitForOutbox(target, 'password_reset')
    const token = decodeURIComponent(mail!.body_text!.match(/token=([^。\s]+)/)![1]!)
    const row = await db.sql(
      `select extract(epoch from (expires_at - created_at))::int as seconds from verifications where identifier = $1`,
      [`reset-password:${token}`],
    )
    expect(row.rows[0]!.seconds).toBe(1800)
    await db.sql(`update verifications set expires_at = now() - interval '1 minute' where identifier = $1`, [`reset-password:${token}`])
    const response = await call('POST', '/reset-password', { token, newPassword: 'Brand-New-Password-2026' })
    expect(response.status).toBe(400)
  })

  it('Server Action 那條（wrapper）一樣寄得出去', async () => {
    const target = freshEmail('reset-action')
    await signUp(target)
    await wrapper.requestPasswordReset({ email: target }, wrapper.authCallHeaders({ ip: '203.0.113.60' }))
    const [mail] = await waitForOutbox(target, 'password_reset')
    expect(mail!.body_text).toContain(`${BASE_URL}/reset-password?token=`)
  })
})

// ── 寄信失敗（AC-VI-76 的 OTP 段、AC-VI-59 的失敗替身段） ─────────────────────

describe('寄信失敗：Brevo 沒設金鑰', () => {
  beforeAll(async () => {
    // 不開擷取：Brevo 轉接器缺金鑰 → MAIL_NOT_CONFIGURED（不降級成擷取）。
    await loadAuth({ MAIL_CAPTURE: '', BREVO_API_KEY: '', MAIL_FROM: '' })
  })
  beforeEach(resetLimiters)

  it('註冊的第一封寄不出去 → 回 MAIL_FAILED「驗證信寄不出去，請稍後再試。」；outbox 一列 failed、不存內文', async () => {
    const email = freshEmail('mail-fail')
    const response = await signUp(email)
    expect(response.status).toBe(500)
    expect(await json(response)).toMatchObject({ code: 'MAIL_FAILED', message: '驗證信寄不出去，請稍後再試。' })
    expect(await outbox(email)).toEqual([
      { template: 'email_otp', subject: '【專題管理平台】Email 驗證碼', body_text: null, status: 'failed', error: 'not_configured' },
    ])
  })

  it('註冊頁的帳號建立那一步把 MAIL_FAILED 翻成同一句（畫面顯示這一句）', async () => {
    const { betterAuthAccountCreator } = await import('@/infrastructure/accounts/registration-command')
    const created = await betterAuthAccountCreator({ email: freshEmail('mail-fail-form'), password: PASSWORD, name: '測試' }, '203.0.113.70')
    expect(created).toEqual({ ok: false, reason: 'mail_failed', message: '驗證信寄不出去，請稍後再試。' })
  })

  it('忘記密碼：對外照樣回成功；outbox 記 failed，error 不含 token', async () => {
    const email = freshEmail('reset-fail')
    await signUp(email)
    const response = await call('POST', '/request-password-reset', { email, redirectTo: '/reset-password' })
    expect(response.status).toBe(200)
    const [mail] = await waitForOutbox(email, 'password_reset')
    expect(mail).toMatchObject({ status: 'failed', error: 'not_configured', body_text: null })
    expect(mail!.subject).not.toMatch(/token/i)
  })
})

// ── Turnstile 掛進 hooks.before（AC-VI-66 伺服器段） ────────────────────────────

describe('Turnstile：HTTP 與 Server Action 兩條路都擋', () => {
  let mode: 'pass' | 'fail' | 'down' = 'pass'
  const seen = new Set<string>()
  let siteverifyCalls = 0

  beforeAll(async () => {
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (!url.startsWith('https://challenges.cloudflare.com/turnstile/v0/siteverify')) return realFetch(input, init)
      siteverifyCalls += 1
      if (mode === 'down') throw new TypeError('fetch failed')
      const token = new URLSearchParams(String(init?.body ?? '')).get('response') ?? ''
      if (mode === 'fail') return Response.json({ success: false, 'error-codes': ['invalid-input-response'] })
      if (seen.has(token)) return Response.json({ success: false, 'error-codes': ['timeout-or-duplicate'] })
      seen.add(token)
      return Response.json({ success: true, hostname: 'example.com', action: 'x' })
    })
    await loadAuth({ TURNSTILE_SITE_KEY: TURNSTILE_PASS_SITE, TURNSTILE_SECRET_KEY: TURNSTILE_PASS_SECRET })
  })
  beforeEach(async () => {
    mode = 'pass'
    await resetLimiters()
  })

  let tokenCounter = 0
  const token = () => `turnstile-token-${Date.now()}-${(tokenCounter += 1)}`

  it('(a) HTTP 不帶 x-turnstile-token：註冊、忘記密碼、重寄驗證碼都 400 TURNSTILE_REQUIRED', async () => {
    const email = freshEmail('ts-http')
    const cases: [string, unknown][] = [
      ['/sign-up/email', { email, password: PASSWORD, name: '測試' }],
      ['/request-password-reset', { email, redirectTo: '/reset-password' }],
      ['/email-otp/send-verification-otp', { email, type: 'email-verification' }],
    ]
    for (const [path, body] of cases) {
      const response = await call('POST', path, body)
      expect(response.status, path).toBe(400)
      expect(await json(response), path).toMatchObject({ code: 'TURNSTILE_REQUIRED', message: '請完成人機驗證。' })
    }
    expect(await db.sql(`select 1 from users where email = $1`, [email])).toMatchObject({ rowCount: 0 })
  })

  it('(b) Server Action 那條（wrapper 呼叫 auth.api，沒有 token）一樣 TURNSTILE_REQUIRED', async () => {
    const email = freshEmail('ts-action')
    const headers = wrapper.authCallHeaders({ ip: '203.0.113.80' })
    const expected = { body: { code: 'TURNSTILE_REQUIRED' } }
    await expect(wrapper.signUpWithPassword({ email, password: PASSWORD, name: '測試' }, headers)).rejects.toMatchObject(expected)
    await expect(wrapper.requestPasswordReset({ email }, headers)).rejects.toMatchObject(expected)
    await expect(wrapper.resendVerificationOtp({ email }, headers)).rejects.toMatchObject(expected)
  })

  it('帶有效 token：註冊成功，第一封驗證碼不需要第二個 token（只驗一次 siteverify）', async () => {
    const email = freshEmail('ts-ok')
    const before = siteverifyCalls
    const response = await signUp(email, { 'x-turnstile-token': token() })
    expect(response.status).toBe(200)
    expect(siteverifyCalls - before).toBe(1)
    expect((await outbox(email)).map((m) => m.template)).toEqual(['email_otp'])
  })

  it('(c) 同一個 token 送兩次：第二次 400', async () => {
    const reused = token()
    const first = await call('POST', '/request-password-reset', { email: freshEmail('ts-dup'), redirectTo: '/reset-password' }, { 'x-turnstile-token': reused })
    expect(first.status).toBe(200)
    const second = await call('POST', '/request-password-reset', { email: freshEmail('ts-dup'), redirectTo: '/reset-password' }, { 'x-turnstile-token': reused })
    expect(second.status).toBe(400)
    expect((await json(second)).code).toBe('TURNSTILE_REQUIRED')
  })

  it('(d) 失敗的 secret：三個入口都被擋；siteverify 連不上 → 503 TURNSTILE_UNAVAILABLE（fail closed）', async () => {
    mode = 'fail'
    const email = freshEmail('ts-fail')
    for (const [path, body] of [
      ['/sign-up/email', { email, password: PASSWORD, name: '測試' }],
      ['/request-password-reset', { email, redirectTo: '/reset-password' }],
      ['/email-otp/send-verification-otp', { email, type: 'email-verification' }],
    ] as const) {
      const response = await call('POST', path, body, { 'x-turnstile-token': token() })
      expect(response.status, path).toBe(400)
    }
    mode = 'down'
    const down = await call('POST', '/request-password-reset', { email, redirectTo: '/reset-password' }, { 'x-turnstile-token': token() })
    expect(down.status).toBe(503)
    expect(await json(down)).toMatchObject({ code: 'TURNSTILE_UNAVAILABLE', message: '人機驗證暫時無法使用，請稍後再試。' })
  })

  it('(e) 密碼登入不要 token：照常 200／401', async () => {
    const email = freshEmail('ts-signin')
    await signUp(email, { 'x-turnstile-token': token() })
    expect((await signIn(email, PASSWORD)).status).toBe(200)
    expect((await signIn(email, 'Wrong-Password-123')).status).toBe(401)
  })

  it('被限速的請求不消耗 siteverify（順序：限速 → Turnstile）', async () => {
    const email = freshEmail('ts-order')
    for (let i = 0; i < 5; i += 1) {
      await call('POST', '/request-password-reset', { email, redirectTo: '/reset-password' }, { 'x-turnstile-token': token() })
    }
    const before = siteverifyCalls
    const blocked = await call('POST', '/request-password-reset', { email, redirectTo: '/reset-password' }, { 'x-turnstile-token': token() })
    expect(blocked.status).toBe(429)
    expect(siteverifyCalls).toBe(before)
  })

  it('同 Email 續辦但 token 無效 → 400 TURNSTILE_REQUIRED、不寄信、不進續辦', async () => {
    const email = freshEmail('ts-resume')
    await signUp(email, { 'x-turnstile-token': token() })
    expect(await outbox(email)).toHaveLength(1)
    mode = 'fail'
    await expect(
      wrapper.signUpOrResume(
        { email, password: 'Another-Password-2026', name: '測試' },
        wrapper.authCallHeaders({ ip: '203.0.113.81', turnstileToken: token() }),
      ),
    ).rejects.toMatchObject({ body: { code: 'TURNSTILE_REQUIRED' } })
    expect(await outbox(email)).toHaveLength(1)
    const pending = await db.sql(`select 1 from verifications where identifier = $1`, [`signup-resume:${email}`])
    expect(pending.rowCount).toBe(0)
  })

  it('續辦用註冊那一次的 token，寄碼不要第二個（只驗一次 siteverify）', async () => {
    const email = freshEmail('ts-resume-ok')
    await signUp(email, { 'x-turnstile-token': token() })
    travel(121_000)
    const before = siteverifyCalls
    const outcome = await wrapper.signUpOrResume(
      { email, password: 'Another-Password-2026', name: '測試' },
      wrapper.authCallHeaders({ ip: '203.0.113.82', turnstileToken: token() }),
    )
    expect(outcome).toEqual({ kind: 'resume', email })
    expect(siteverifyCalls - before).toBe(1)
    expect(await outbox(email)).toHaveLength(2)
  })

  it('「我的帳號」驗證 Email（內部入口）：本人 fresh session 不要 token；過了 10 分鐘要重新登入', async () => {
    const email = freshEmail('ts-account')
    await signUp(email, { 'x-turnstile-token': token() })
    const { cookie } = await signIn(email, PASSWORD)
    travel(121_000)
    await wrapper.sendOwnVerificationOtp(new Headers({ cookie, 'x-real-ip': '203.0.113.83' }))
    expect(await outbox(email)).toHaveLength(2)
    vi.useRealTimers()

    await db.sql(
      `update sessions set created_at = now() - interval '11 minutes' where user_id = (select id from users where email = $1)`,
      [email],
    )
    instance.resetEmailOtpLimiters()
    await expect(wrapper.sendOwnVerificationOtp(new Headers({ cookie, 'x-real-ip': '203.0.113.83' }))).rejects.toMatchObject({
      body: { code: 'FRESH_SESSION_REQUIRED' },
    })
    expect(await outbox(email)).toHaveLength(2)
  })

  it('其他內部呼叫不豁免：只有 marker、沒有用途 → 一樣要 token', async () => {
    const email = freshEmail('ts-internal')
    await signUp(email, { 'x-turnstile-token': token() })
    travel(121_000)
    const { runAsInternalCall } = await import('@/infrastructure/auth/internal-call')
    await expect(
      runAsInternalCall(() => instance.getAuth().api.sendVerificationOTP({ body: { email, type: 'email-verification' } })),
    ).rejects.toMatchObject({ body: { code: 'TURNSTILE_REQUIRED' } })
  })
})

// ── 只設一個鍵（AC-VI-67 啟動報錯） ───────────────────────────────────────────

describe('Turnstile 只設一個鍵：建實例就報錯', () => {
  it('只有 site key → getAuth() 丟錯，不會半套上線', async () => {
    await expect(loadAuth({ TURNSTILE_SITE_KEY: TURNSTILE_PASS_SITE, TURNSTILE_SECRET_KEY: '' })).rejects.toThrow(
      /Turnstile 金鑰只設了一個（缺 TURNSTILE_SECRET_KEY）/,
    )
  })
})

// ── 寄信轉接器的選擇與 composition 一致 ───────────────────────────────────────

describe('auth 實例的寄信轉接器跟 composition/mail.ts 同一套規則', () => {
  it('三種組合結果相同', async () => {
    await loadAuth({})
    const { chooseMailer } = await import('@/composition/mail')
    for (const env of [
      { MAIL_CAPTURE: undefined, BETTER_AUTH_URL: 'http://127.0.0.1:3000' },
      { MAIL_CAPTURE: '1', BETTER_AUTH_URL: 'http://127.0.0.1:3000' },
      { MAIL_CAPTURE: '1', BETTER_AUTH_URL: 'http://localhost:3000' },
      { MAIL_CAPTURE: '1', BETTER_AUTH_URL: 'https://stg.roy422.dev' },
      { MAIL_CAPTURE: '0', BETTER_AUTH_URL: 'http://127.0.0.1:3000' },
    ]) {
      expect(instance.authMailerKind(env), JSON.stringify(env)).toBe(chooseMailer(env).kind)
    }
  })
})
