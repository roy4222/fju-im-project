import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  assertTestDatabaseReachable,
  createIsolatedDatabase,
  TEST_DATABASE_URL,
  type IsolatedDatabase,
} from '../../../test/db'
import { migratedSchema } from '../../../test/migrations'

/**
 * S01-03 的**三向測試**（契約 03 §2、母 spec §4.12）。
 *
 * 管理員能力只能經內部包裝器呼叫。三個方向都要驗，少一個就有洞：
 * 1. 外部 HTTP 打 `admin/*` → 被擋（就算帶管理員 session）。
 * 2. 內部包裝呼叫 → 成功。
 * 3. **缺 marker 的伺服器端呼叫 → 也被擋**（這一向就是 S01-02 留下的缺口）。
 */

const BASE_URL = 'http://127.0.0.1:3000'

let db: IsolatedDatabase
let handlers: typeof import('@/infrastructure/auth/wrapper').authRouteHandlers
let internalAuth: typeof import('@/infrastructure/auth/wrapper').internalAuth
let authInstance: ReturnType<typeof import('@/infrastructure/auth/auth-instance').getAuth>

beforeAll(async () => {
  await assertTestDatabaseReachable()
  db = await createIsolatedDatabase({ label: 'internal-call', setup: migratedSchema })

  const url = new URL(TEST_DATABASE_URL)
  url.searchParams.set('options', `-c search_path=${db.schemaName}`)

  vi.resetModules()
  vi.stubEnv('DATABASE_URL', url.toString())
  vi.stubEnv('BETTER_AUTH_SECRET', 'integration-test-secret-integration-test')
  vi.stubEnv('BETTER_AUTH_URL', BASE_URL)

  const wrapper = await import('@/infrastructure/auth/wrapper')
  handlers = wrapper.authRouteHandlers
  internalAuth = wrapper.internalAuth
  authInstance = (await import('@/infrastructure/auth/auth-instance')).getAuth()
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await db?.close()
})

let counter = 0
async function createAccount(): Promise<{ userId: string; email: string; password: string; cookie: string }> {
  counter += 1
  const email = `s01-03-${Date.now()}-${counter}@example.com`
  const password = 'Correct-Horse-Battery-9'
  const signUp = await handlers.POST(
    new Request(`${BASE_URL}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE_URL },
      body: JSON.stringify({ email, password, name: '三向測試' }),
    }),
  )
  expect(signUp.status).toBe(200)
  const cookie = signUp.headers.get('set-cookie') ?? ''
  const row = await db.sql('select id from users where email = $1', [email])
  return { userId: String(row.rows[0]!.id), email, password, cookie }
}

/**
 * 建一個管理員並回他的 headers。
 *
 * admin plugin 自己的 middleware 要求呼叫端帶著 role='admin' 的 session，
 * 所以內部呼叫也要把「發動這個動作的管理員」的 headers 傳進去（見 wrapper 的說明）。
 */
async function adminHeaders(): Promise<Headers> {
  const { userId, cookie } = await createAccount()
  await db.sql(`update users set role = 'admin', status = 'active' where id = $1`, [userId])
  return new Headers({ cookie })
}

async function bannedFlag(userId: string): Promise<boolean | null> {
  const row = await db.sql('select banned from users where id = $1', [userId])
  return row.rows[0]!.banned as boolean | null
}

describe('第一向：外部 HTTP 打 admin/* 被擋', () => {
  it('帶管理員 session 也一樣 403', async () => {
    const { userId, cookie } = await createAccount()
    await db.sql(`update users set role = 'admin', status = 'active' where id = $1`, [userId])

    const response = await handlers.POST(
      new Request(`${BASE_URL}/api/auth/admin/ban-user`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: BASE_URL, cookie },
        body: JSON.stringify({ userId }),
      }),
    )
    expect(response.status).toBe(403)
    expect(await bannedFlag(userId), '被擋下來就不該真的停用').not.toBe(true)
  })
})

describe('第二向：內部包裝呼叫成功', () => {
  it('banUser 經包裝器可以執行，users.banned 變 true', async () => {
    const { userId } = await createAccount()
    expect(await bannedFlag(userId)).not.toBe(true)

    await internalAuth.banUser(await adminHeaders(), { userId, banReason: '測試停用' })

    expect(await bannedFlag(userId)).toBe(true)
  })

  it('unbanUser 經包裝器可以執行，banned 變回 false', async () => {
    const { userId } = await createAccount()
    const admin = await adminHeaders()
    await internalAuth.banUser(admin, { userId })
    expect(await bannedFlag(userId)).toBe(true)

    await internalAuth.unbanUser(admin, { userId })
    expect(await bannedFlag(userId)).toBe(false)
  })

  it('revokeUserSessions 經包裝器可以執行，session 列被清掉', async () => {
    const { userId } = await createAccount()
    const before = await db.sql('select count(*)::int as n from sessions where user_id = $1', [userId])
    expect(before.rows[0]!.n).toBeGreaterThan(0)

    await internalAuth.revokeUserSessions(await adminHeaders(), { userId })

    const after = await db.sql('select count(*)::int as n from sessions where user_id = $1', [userId])
    expect(after.rows[0]!.n).toBe(0)
  })

  it('setUserPassword 經包裝器可以執行（新密碼登得進去、舊的不行）', async () => {
    const { userId, email } = await createAccount()
    await internalAuth.setUserPassword(await adminHeaders(), { userId, newPassword: 'Temp-Password-For-Test-1' })

    const signInOld = await handlers.POST(
      new Request(`${BASE_URL}/api/auth/sign-in/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: BASE_URL },
        body: JSON.stringify({ email, password: 'Correct-Horse-Battery-9' }),
      }),
    )
    expect(signInOld.status, '舊密碼應該失效').toBeGreaterThanOrEqual(400)

    const signInNew = await handlers.POST(
      new Request(`${BASE_URL}/api/auth/sign-in/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: BASE_URL },
        body: JSON.stringify({ email, password: 'Temp-Password-For-Test-1' }),
      }),
    )
    expect(signInNew.status).toBe(200)
  })

  it('createUser 經包裝器可以執行，而且新帳號一樣是 pending', async () => {
    counter += 1
    const email = `s01-03-teacher-${Date.now()}-${counter}@example.com`
    await internalAuth.createUser(await adminHeaders(), { email, password: 'Teacher-Password-9', name: '老師' })

    const row = await db.sql('select status from users where email = $1', [email])
    expect(row.rowCount).toBe(1)
    expect(row.rows[0]!.status, 'user.create.before 對內部建立也生效').toBe('pending')
  })
})

describe('marker 不取代權限檢查', () => {
  it('經包裝器但帶的是一般使用者的 session，套件自己的 middleware 仍然擋下', async () => {
    const victim = await createAccount()
    const plain = await createAccount() // 沒有改成 admin
    await expect(
      internalAuth.banUser(new Headers({ cookie: plain.cookie }), { userId: victim.userId }),
    ).rejects.toThrow()
    expect(await bannedFlag(victim.userId)).not.toBe(true)
  })
})

describe('第三向：缺 marker 的伺服器端呼叫被擋', () => {
  it('直接 auth.api.banUser（沒經包裝器）被擋，而且帳號沒有被停用', async () => {
    const { userId } = await createAccount()

    let thrown: unknown
    try {
      await authInstance.api.banUser({ body: { userId } })
    } catch (error) {
      thrown = error
    }

    expect(thrown, '沒有 marker 就不該放行').toBeDefined()
    expect(String((thrown as Error)?.message ?? thrown)).toContain('這個入口不對外開放')
    expect(await bannedFlag(userId), '被擋下來就不該有副作用').not.toBe(true)
  })

  it('直接 auth.api.createUser（沒經包裝器）被擋，帳號沒建出來', async () => {
    counter += 1
    const email = `s01-03-nomarker-${Date.now()}-${counter}@example.com`
    await expect(
      authInstance.api.createUser({ body: { email, password: 'No-Marker-9', name: '不該建出來' } }),
    ).rejects.toThrow(/這個入口不對外開放/)

    const row = await db.sql('select count(*)::int as n from users where email = $1', [email])
    expect(row.rows[0]!.n).toBe(0)
  })

  it('白名單上的端點在伺服器端仍然可用（marker 不是萬用鎖）', async () => {
    // `/get-session` 本來就對外開放，伺服器端呼叫不需要 marker，
    // 否則 ActorResolver 就動不了了。
    await expect(authInstance.api.getSession({ headers: new Headers() })).resolves.toBeNull()
  })
})

describe('marker 不會外洩到請求處理', () => {
  it('包裝器呼叫結束後，marker 就不在了', async () => {
    const { userId } = await createAccount()
    await internalAuth.banUser(await adminHeaders(), { userId })

    // 同一個 tick 內緊接著做沒有 marker 的呼叫：不應該沾到前一次的 context。
    await expect(authInstance.api.banUser({ body: { userId } })).rejects.toThrow(/這個入口不對外開放/)
  })

  it('包裝器裡丟例外時 marker 也會跟著結束', async () => {
    await expect(
      internalAuth.banUser(await adminHeaders(), { userId: '00000000-0000-7000-8000-000000000000' }),
    ).rejects.toThrow()

    const { userId } = await createAccount()
    await expect(authInstance.api.banUser({ body: { userId } })).rejects.toThrow(/這個入口不對外開放/)
  })
})
