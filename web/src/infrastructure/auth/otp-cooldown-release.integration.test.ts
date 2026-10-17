import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import {
  assertTestDatabaseReachable,
  createIsolatedDatabase,
  poolAsRole,
  TEST_DATABASE_URL,
  type IsolatedDatabase,
} from '../../../test/db'
import { migratedSchema } from '../../../test/migrations'

/**
 * VB-14 Review 第 2 輪 P2：寄碼冷卻占位的釋放範圍（VB-2 的 120 秒冷卻；AC-VI-47）。
 *
 * 冷卻是「第一步就占位、沒過關才放掉」。放掉必須**只放自己占的那一格**：占位期間若別人重開了這個 Email 的冷卻
 * （註冊首封從不等冷卻；或自己的視窗已過期、別人占到新的一格），自己失敗時不能把別人的冷卻清掉。
 * 三案在舊版（PR #594 head `464ecfb`，無條件 `reset(email)`）都紅：失敗那筆一放，緊接著的寄碼就進得去、多寄一封。
 *
 * 真的 Better Auth＋真的 PostgreSQL，擷取模式寄信（`mail_outbox`）；Turnstile 開著、siteverify 由屏障擋住，
 * 讓一筆寄碼停在「占了位、還沒過關」那一步。只假 `Date`（冷卻視窗要能過期），`setTimeout` 是真的。
 */

const BASE_URL = 'http://127.0.0.1:3000'
const P1 = 'First-Password-2026'
const P2 = 'Second-Password-2026'
const IP = '203.0.113.93'
const TURNSTILE_ON = { TURNSTILE_SITE_KEY: 'barrier', TURNSTILE_SECRET_KEY: 'barrier' }

type Wrapper = typeof import('@/infrastructure/auth/wrapper')

let db: IsolatedDatabase
let app: Pool
let wrapper: Wrapper
let resetEmailOtpLimiters: () => void

/** 重新載入一份 Better Auth（環境變數在建實例時讀）；限速桶掛在 `globalThis`，重載不會清掉。 */
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
  resetEmailOtpLimiters = (await import('@/infrastructure/auth/auth-instance')).resetEmailOtpLimiters
}

beforeAll(async () => {
  await assertTestDatabaseReachable()
  db = await createIsolatedDatabase({ label: 'vb14-otp-cooldown', setup: migratedSchema })
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
const freshEmail = (label: string) => `vb14-cooldown-${label}-${Date.now()}-${(counter += 1)}@example.com`

/** 直接打 HTTP 時帶的標頭：來源 IP＋一個 Turnstile token（siteverify 由屏障決定過不過）。 */
const httpHeaders = () => ({ 'x-real-ip': IP, 'x-turnstile-token': randomUUID() })
/** Server Action 走 `auth.api.*` 時帶的標頭（同一段 hook 驗同一個標頭）。 */
const actionHeaders = () => wrapper.authCallHeaders({ ip: IP, turnstileToken: randomUUID() })

/** 公開重寄（HTTP）。 */
function publicResend(email: string): Promise<Response> {
  return call('POST', '/email-otp/send-verification-otp', { email, type: 'email-verification' }, httpHeaders())
}

async function errorCode(response: Response): Promise<string | undefined> {
  return ((await response.json()) as { code?: string } | null)?.code
}

/** Turnstile 關著時註冊（擷取模式寄首封）。 */
async function signUp(email: string): Promise<void> {
  const response = await call('POST', '/sign-up/email', { email, password: P1, name: '測試' })
  expect(response.status).toBe(200)
}

/** 過了冷卻再開始續辦（註冊那封剛寄過，120 秒內寄不了第二封）；回傳續辦票。 */
async function startResume(email: string): Promise<string> {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.now() + 121_000)
  try {
    const outcome = await wrapper.signUpOrResume(
      { email, password: P2, name: '測試' },
      wrapper.authCallHeaders({ ip: IP }),
    )
    if (outcome.kind !== 'resume') throw new Error('沒有進續辦')
    return outcome.ticket
  } finally {
    vi.useRealTimers()
  }
}

async function otpMailCount(email: string): Promise<number> {
  const rows = await db.sql(`select count(*)::int as n from mail_outbox where to_email = $1 and template = 'email_otp'`, [
    email,
  ])
  return Number(rows.rows[0]!.n)
}

/** 真實時間等一下：排隊中的那筆若進得了 Turnstile，這段時間就會多一筆 siteverify。 */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 300))

type Barrier = {
  /** 每一筆 siteverify 的回覆把手，依打到的順序。 */
  captcha: Array<(response: Response) => void>
  pass(index: number, action: 'signup' | 'resend'): void
  fail(index: number): void
  drain(): void
}

/** 把 siteverify 擋住：每一筆停在屏障上，由測試決定何時、以什麼結果放行。擷取模式寄信不走 fetch。 */
function installBarrier(): Barrier {
  const captcha: Barrier['captcha'] = []
  vi.stubGlobal('fetch', (url: unknown) => {
    if (String(url).includes('challenges.cloudflare.com')) return new Promise<Response>((resolve) => captcha.push(resolve))
    throw new Error(`測試裡不該打 ${String(url)}`)
  })
  const ok = (action: string) =>
    new Response(JSON.stringify({ success: true, action, hostname: '127.0.0.1' }), { status: 200 })
  const no = () => new Response(JSON.stringify({ success: false }), { status: 200 })
  return {
    captcha,
    pass: (index, action) => captcha[index]!(ok(action)),
    fail: (index) => captcha[index]!(no()),
    // 收尾：還停著的全部放失敗（已 resolve 過的再 resolve 是 no-op），讓懸著的呼叫結束。
    drain: () => {
      for (const resolve of captcha) resolve(no())
    },
  }
}

describe('寄碼冷卻：失敗只釋放自己占的那一格（VB-14 Review 第 2 輪 P2）', () => {
  it('Sol 探針：公開重寄停在 Turnstile → 同 Email 註冊首封寄出 → 前者 Turnstile 失敗 → 立即重寄 429、不打 siteverify、仍只有 1 封；120 秒後才放行（舊版：200、第 2 封）', async () => {
    const email = freshEmail('first-mail-kept')
    const barrier = installBarrier()
    await loadAuth(TURNSTILE_ON)
    const outcomes: Promise<unknown>[] = []
    try {
      // A：公開重寄先占位，停在 siteverify。
      const a = publicResend(email)
      outcomes.push(a)
      await vi.waitFor(() => expect(barrier.captcha).toHaveLength(1), { timeout: 5_000 })

      // B：同一個 Email 這時註冊成功 → 伺服器寄首封（首封從不等冷卻，重開冷卻視窗）。
      const b = call('POST', '/sign-up/email', { email, password: P1, name: '測試' }, httpHeaders())
      outcomes.push(b)
      await vi.waitFor(() => expect(barrier.captcha).toHaveLength(2), { timeout: 5_000 })
      barrier.pass(1, 'signup')
      expect((await b).status).toBe(200)
      await vi.waitFor(async () => expect(await otpMailCount(email)).toBe(1), { timeout: 5_000 })

      // A 的 Turnstile 沒過：只能放掉自己那一格——首封的冷卻仍在。
      barrier.fail(0)
      const aResponse = await a
      expect(aResponse.status).toBe(400)
      expect(await errorCode(aResponse)).toBe('TURNSTILE_REQUIRED')

      // C：立刻再重寄 → 被首封的冷卻擋下（429），不打 siteverify、不寄第二封。
      const c = publicResend(email)
      outcomes.push(c)
      await settle()
      expect(barrier.captcha).toHaveLength(2)
      const cResponse = await c
      expect(cResponse.status).toBe(429)
      expect(await errorCode(cResponse)).toBe('RATE_LIMITED')
      expect(await otpMailCount(email)).toBe(1)

      // 首封起算 120 秒後才放行：這時 siteverify 才被打到，過了就寄第二封。
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(Date.now() + 121_000)
      const d = publicResend(email)
      outcomes.push(d)
      await vi.waitFor(() => expect(barrier.captcha).toHaveLength(3), { timeout: 5_000 })
      barrier.pass(2, 'resend')
      expect((await d).status).toBe(200)
      await vi.waitFor(async () => expect(await otpMailCount(email)).toBe(2), { timeout: 5_000 })
    } finally {
      barrier.drain()
      await Promise.allSettled(outcomes)
      vi.useRealTimers()
      vi.unstubAllGlobals()
      await loadAuth()
    }
  })

  it('兩筆公開重寄並行、一筆 Turnstile 失敗：第二筆當場 429；第一筆的視窗過期後第三筆占到新的一格並寄出，第一筆這時才失敗 → 不動第三筆的冷卻，第四筆 429（舊版：第一筆一放把第三筆的冷卻清掉，第四筆進到 siteverify）', async () => {
    const email = freshEmail('public-pair')
    await signUp(email)
    const barrier = installBarrier()
    await loadAuth(TURNSTILE_ON)
    const outcomes: Promise<unknown>[] = []
    try {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(Date.now() + 121_000)
      // A 占位、停在 siteverify；同時進來的 B 在占位那一步就 429，不打 siteverify。
      const a = publicResend(email)
      const b = publicResend(email)
      outcomes.push(a, b)
      await vi.waitFor(() => expect(barrier.captcha).toHaveLength(1), { timeout: 5_000 })
      const bResponse = await b
      expect(bResponse.status).toBe(429)
      expect(await errorCode(bResponse)).toBe('RATE_LIMITED')
      expect(barrier.captcha).toHaveLength(1)

      // A 占的視窗過期（A 還停在 siteverify）：C 占到新的一格，也停在 siteverify。
      vi.setSystemTime(Date.now() + 121_000)
      const c = publicResend(email)
      outcomes.push(c)
      await vi.waitFor(() => expect(barrier.captcha).toHaveLength(2), { timeout: 5_000 })

      // A 這時才失敗：A 的那一格早已不是它的，不能放掉 C 占的。
      barrier.fail(0)
      expect((await a).status).toBe(400)
      // C 過關、寄出；D 緊接著進來 → 被 C 的冷卻擋下，不打 siteverify。
      barrier.pass(1, 'resend')
      expect((await c).status).toBe(200)
      await vi.waitFor(async () => expect(await otpMailCount(email)).toBe(2), { timeout: 5_000 })
      const d = publicResend(email)
      outcomes.push(d)
      await settle()
      expect(barrier.captcha).toHaveLength(2)
      const dResponse = await d
      expect(dResponse.status).toBe(429)
      expect(await errorCode(dResponse)).toBe('RATE_LIMITED')
      expect(await otpMailCount(email)).toBe(2)
    } finally {
      barrier.drain()
      await Promise.allSettled(outcomes)
      vi.useRealTimers()
      vi.unstubAllGlobals()
      await loadAuth()
    }
  })

  it('續辦重寄與公開重寄交錯：公開重寄占位時續辦重寄 429；公開那筆的視窗過期後續辦重寄占到新的一格並寄出，公開那筆這時才失敗 → 續辦的冷卻仍在，公開重寄 429（舊版：公開那筆一放把續辦的冷卻清掉，公開重寄進到 siteverify）', async () => {
    const email = freshEmail('resume-vs-public')
    await signUp(email)
    const ticket = await startResume(email)
    expect(await otpMailCount(email)).toBe(2)
    const barrier = installBarrier()
    await loadAuth(TURNSTILE_ON)
    const outcomes: Promise<unknown>[] = []
    try {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(Date.now() + 242_000)
      // 公開重寄 A 占位、停在 siteverify；續辦重寄 R 在占位那一步就 429（不打 siteverify、不寄、不改綁）。
      const a = publicResend(email)
      outcomes.push(a)
      await vi.waitFor(() => expect(barrier.captcha).toHaveLength(1), { timeout: 5_000 })
      const r = wrapper.resendSignupResumeOtp({ email, ticket }, actionHeaders())
      outcomes.push(r)
      await expect(r).rejects.toMatchObject({ body: { code: 'RATE_LIMITED' } })
      expect(barrier.captcha).toHaveLength(1)

      // A 的視窗過期（A 還停在 siteverify）：續辦重寄 R2 占到新的一格、停在 siteverify。
      vi.setSystemTime(Date.now() + 121_000)
      const r2 = wrapper.resendSignupResumeOtp({ email, ticket }, actionHeaders())
      outcomes.push(r2)
      await vi.waitFor(() => expect(barrier.captcha).toHaveLength(2), { timeout: 5_000 })

      // A 這時才失敗：不能放掉 R2 占的那一格。
      barrier.fail(0)
      expect((await a).status).toBe(400)
      barrier.pass(1, 'resend')
      expect(await r2).toBe('sent')
      await vi.waitFor(async () => expect(await otpMailCount(email)).toBe(3), { timeout: 5_000 })

      // 公開重寄 C 緊接著進來 → 被續辦那封的冷卻擋下，不打 siteverify。
      const c = publicResend(email)
      outcomes.push(c)
      await settle()
      expect(barrier.captcha).toHaveLength(2)
      const cResponse = await c
      expect(cResponse.status).toBe(429)
      expect(await errorCode(cResponse)).toBe('RATE_LIMITED')
      expect(await otpMailCount(email)).toBe(3)
    } finally {
      barrier.drain()
      await Promise.allSettled(outcomes)
      vi.useRealTimers()
      vi.unstubAllGlobals()
      await loadAuth()
    }
  })
})
