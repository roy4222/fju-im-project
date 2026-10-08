import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  assertTestDatabaseReachable,
  createIsolatedDatabase,
  TEST_DATABASE_URL,
  type IsolatedDatabase,
} from '../../../test/db'
import { migratedSchema } from '../../../test/migrations'
import { RATE_LIMITS } from '@/shared/rate-limit'

/**
 * 票 T3（features.json R1）：同一個網路換帳號亂試密碼，一樣會被擋。
 *
 * 真的 Better Auth 實例打真的 PostgreSQL（隔離 schema），請求走真的 route handler。
 * 門檻：同一個 IP 不分帳號，10 分鐘內失敗 30 次就擋（Roy 2026-10-08 定案）。
 */

const BASE_URL = 'http://127.0.0.1:3000'
const PASSWORD = 'Correct-Horse-Battery-9'
const MAX = RATE_LIMITS.signInFailuresPerIp.max

let db: IsolatedDatabase
let handlers: typeof import('@/infrastructure/auth/wrapper').authRouteHandlers
let resetSignInLimiter: () => void
let email: string

beforeAll(async () => {
  await assertTestDatabaseReachable()
  db = await createIsolatedDatabase({ label: 'ip-sign-in-rate', setup: migratedSchema })

  const url = new URL(TEST_DATABASE_URL)
  url.searchParams.set('options', `-c search_path=${db.schemaName}`)

  vi.resetModules()
  vi.stubEnv('DATABASE_URL', url.toString())
  vi.stubEnv('BETTER_AUTH_SECRET', 'integration-test-secret-integration-test')
  vi.stubEnv('BETTER_AUTH_URL', BASE_URL)

  handlers = (await import('@/infrastructure/auth/wrapper')).authRouteHandlers
  resetSignInLimiter = (await import('@/infrastructure/auth/sign-in-rate-limit')).resetSignInLimiter

  // 一個真的帳號（註冊完是待審，待審可以登入），用來證明「被擋時連正確密碼也進不去」。
  email = `t3-${Date.now()}@example.com`
  const signUp = await post('/sign-up/email', { email, password: PASSWORD, name: '測試使用者' }, '198.51.100.200')
  expect(signUp.status).toBe(200)
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await db?.close()
})

beforeEach(() => {
  resetSignInLimiter()
})

function post(path: string, body: unknown, ip: string): Promise<Response> {
  return handlers.POST(
    new Request(`${BASE_URL}/api/auth${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE_URL, 'x-real-ip': ip },
      body: JSON.stringify(body),
    }),
  )
}

const signIn = (address: string, password: string, ip: string) => post('/sign-in/email', { email: address, password }, ip)

async function sessionCount(): Promise<number> {
  const rows = await db.sql(
    `select count(*)::int as n from sessions s join users u on u.id = s.user_id where u.email = $1`,
    [email],
  )
  return Number(rows.rows[0]!.n)
}

/** 同一個 IP 用 n 個不同（不存在）的帳號各錯一次，每一次都要是 401（帳密錯），不是被限速。 */
async function sprayFailures(ip: string, n: number): Promise<void> {
  for (let i = 1; i <= n; i += 1) {
    const res = await signIn(`nobody${i}@example.com`, 'x-wrong-password', ip)
    expect(res.status, `第 ${i} 次應該是帳密錯而不是被限速`).toBe(401)
  }
}

describe('每 IP 跨帳號登入失敗限速（R1）', () => {
  it('同一個 IP 換 30 個帳號錯 30 次之後，第 31 個帳號回 429 與中文訊息', async () => {
    const ip = '203.0.113.31'
    await sprayFailures(ip, MAX)

    const blocked = await signIn(`nobody${MAX + 1}@example.com`, 'x-wrong-password', ip)
    expect(blocked.status).toBe(429)
    const body = (await blocked.json()) as { code?: string; message?: string }
    expect(body.code).toBe('RATE_LIMITED')
    expect(body.message).toBe('這個網路的登入失敗次數過多，請稍後再試。')
  })

  it('被擋之後同一個 IP 用正確的帳密也進不去；換一個 IP 可以', async () => {
    const ip = '203.0.113.32'
    await sprayFailures(ip, MAX)

    const sameIp = await signIn(email, PASSWORD, ip)
    expect(sameIp.status, '連正確的密碼也要擋').toBe(429)

    const otherIp = await signIn(email, PASSWORD, '198.51.100.32')
    expect(otherIp.status, '換一個網路不受影響').toBe(200)
  })

  /**
   * 這裡只證明「被擋的請求不建 session」。429 不累計失敗的依據不在這裡：before hook 丟錯時
   * 套件整條就中斷、after hook 不會跑（見 auth-instance.ts `hooks.after` 的註解、套件 `api/dispatch.mjs`）。
   */
  it('被擋的請求不建 session', async () => {
    const ip = '203.0.113.33'
    await sprayFailures(ip, MAX)
    const before = await sessionCount()
    for (let i = 0; i < 5; i += 1) expect((await signIn(email, PASSWORD, ip)).status).toBe(429)
    expect(await sessionCount(), '被擋的五次都沒有建 session').toBe(before)
  })

  it('成功登入不計數，也不清掉這個 IP 已經記下的失敗', async () => {
    const ip = '203.0.113.34'
    await sprayFailures(ip, MAX - 1)

    // 成功不算失敗：還沒滿，正確密碼可以進。
    expect((await signIn(email, PASSWORD, ip)).status).toBe(200)
    expect((await signIn(email, PASSWORD, ip)).status).toBe(200)

    // 成功也沒清掉之前的 29 次：再錯一次就滿了。
    expect((await signIn('one-more@example.com', 'x-wrong-password', ip)).status).toBe(401)
    expect((await signIn(email, PASSWORD, ip)).status).toBe(429)
  })

  it('格式錯（400）不算失敗', async () => {
    const ip = '203.0.113.35'
    // 每次換一個字串，免得撞到 IP＋帳號那個 10 次的桶。
    for (let i = 0; i < MAX + 5; i += 1) {
      const res = await signIn(`not-an-email-${i}`, 'x', ip)
      expect(res.status).toBe(400)
    }
    expect((await signIn(email, PASSWORD, ip)).status).toBe(200)
  })

  it('resetSignInLimiter 會連每 IP 桶一起清', async () => {
    const ip = '203.0.113.36'
    await sprayFailures(ip, MAX)
    expect((await signIn(email, PASSWORD, ip)).status).toBe(429)

    resetSignInLimiter()
    expect((await signIn(email, PASSWORD, ip)).status).toBe(200)
  })
})
