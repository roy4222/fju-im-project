import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import {
  assertTestDatabaseReachable,
  createIsolatedDatabase,
  TEST_DATABASE_URL,
  type IsolatedDatabase,
} from '../../../test/db'
import { migratedSchema } from '../../../test/migrations'
import { statusGate } from '@/application/accounts'

/**
 * S01-05：A1 用一次性密碼首次登入 → 強制改密 → 登出 → 用新密碼重登。
 *
 * 這支測的是**整條路**，而且每一步都回資料庫核對（票 #48 的「操作證據：SQL」）。
 * 真的跑 `pnpm seed:a1`（子程序、帶自己的環境變數），不是在測試裡模擬它做的事。
 */

const BASE_URL = 'http://127.0.0.1:3000'
const A1_EMAIL = 'a1@example.com'
const ONE_TIME_PASSWORD = 'One-Time-Password-9'
const NEW_PASSWORD = 'Roy-New-Password-2026'

let db: IsolatedDatabase
let schemaUrl: string
let handlers: typeof import('@/infrastructure/auth/wrapper').authRouteHandlers
let composition: typeof import('@/composition/accounts')
let resetChangePasswordLimiter: () => void

beforeAll(async () => {
  await assertTestDatabaseReachable()
  db = await createIsolatedDatabase({ label: 'a1-login', setup: migratedSchema })

  const url = new URL(TEST_DATABASE_URL)
  url.searchParams.set('options', `-c search_path=${db.schemaName}`)
  schemaUrl = url.toString()

  vi.resetModules()
  vi.stubEnv('DATABASE_URL', schemaUrl)
  vi.stubEnv('BETTER_AUTH_SECRET', 'integration-test-secret-integration-test')
  vi.stubEnv('BETTER_AUTH_URL', BASE_URL)

  handlers = (await import('@/infrastructure/auth/wrapper')).authRouteHandlers
  composition = await import('@/composition/accounts')
  resetChangePasswordLimiter = (await import('@/infrastructure/auth/change-password-rules'))
    .resetChangePasswordLimiter
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await db?.close()
})

beforeEach(() => {
  composition.resetSignInLimiter()
  resetChangePasswordLimiter()
})

/** 跑真的 seed 腳本；值只從環境變數進去。 */
function runSeed(env: Record<string, string> = {}): string {
  const webRoot = path.join(import.meta.dirname, '..', '..', '..')
  return execFileSync('node', ['scripts/seed-a1.mjs'], {
    cwd: webRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      DATABASE_URL_OWNER: schemaUrl,
      A1_EMAIL,
      A1_INITIAL_PASSWORD: ONE_TIME_PASSWORD,
      ...env,
    },
  })
}

async function a1Row() {
  const row = await db.sql(
    'select id, status, must_change_password, role from users where email = $1',
    [A1_EMAIL],
  )
  return row.rows[0]
}

async function sessionCount(userId: string): Promise<number> {
  const row = await db.sql('select count(*)::int as n from sessions where user_id = $1', [userId])
  return Number(row.rows[0]!.n)
}

/** 用 HTTP 登入並回 cookie（模擬「另一個瀏覽器」）。 */
async function signInViaHttp(password: string): Promise<{ status: number; cookie: string }> {
  const response = await handlers.POST(
    new Request(`${BASE_URL}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE_URL },
      body: JSON.stringify({ email: A1_EMAIL, password }),
    }),
  )
  return { status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '' }
}

describe('seed:a1', () => {
  it('建出一個 active、必須改密、有 admin 角色的帳號', async () => {
    const output = runSeed()
    expect(output).toContain('A1 已建立')
    // 輸出裡**不能**出現密碼。
    expect(output).not.toContain(ONE_TIME_PASSWORD)

    const row = await a1Row()
    expect(row).toMatchObject({ status: 'active', must_change_password: true, role: 'admin' })

    const roles = await db.sql(
      `select role from role_assignments where user_id = $1 and revoked_real_at is null`,
      [row!.id],
    )
    expect(roles.rows.map((r) => r.role)).toEqual(['admin'])

    const profile = await db.sql('select display_name from user_profiles where user_id = $1', [row!.id])
    expect(profile.rowCount).toBe(1)

    const audit = await db.sql(
      `select actor_kind, action from audit_events where action = 'account.seed_first_admin'`,
    )
    expect(audit.rows[0]).toMatchObject({ actor_kind: 'system', action: 'account.seed_first_admin' })
  })

  it('重跑是安全的：已存在就什麼都不做', async () => {
    const output = runSeed({ A1_INITIAL_PASSWORD: 'A-Completely-Different-1' })
    expect(output).toContain('已存在')

    // 密碼沒有被偷偷換掉——原本的一次性密碼還是有效的。
    const signIn = await signInViaHttp(ONE_TIME_PASSWORD)
    expect(signIn.status).toBe(200)
  })

  it('缺少必要環境變數時直接失敗，不會建一個沒有密碼的管理員', () => {
    expect(() => runSeed({ A1_INITIAL_PASSWORD: '' })).toThrow()
    expect(() => runSeed({ A1_INITIAL_PASSWORD: 'short' })).toThrow()
  })
})

describe('A1 首次登入 → 強制改密 → 登出 → 新密碼重登', () => {
  it('1. 一次性密碼登得進去，但帳號處於「必須改密」', async () => {
    const signIn = await composition.signIn({
      email: A1_EMAIL,
      password: ONE_TIME_PASSWORD,
      ip: '10.0.0.1',
    })
    expect(signIn.ok).toBe(true)

    const row = await a1Row()
    expect(row!.must_change_password).toBe(true)
  })

  it('2. 「必須改密」的狀態擋掉所有業務動作，只放行改密與登出', async () => {
    const { cookie } = await signInViaHttp(ONE_TIME_PASSWORD)
    const { DbActorResolver } = await import('@/infrastructure/auth/actor-resolver')
    const actor = await new DbActorResolver().resolve(new Headers({ cookie }))

    expect(statusGate(actor, 'business'), '打任何業務動作都是 PASSWORD_CHANGE_REQUIRED').toBe(
      'PASSWORD_CHANGE_REQUIRED',
    )
    expect(statusGate(actor, 'self.changePassword')).toBeNull()
    expect(statusGate(actor, 'self.session')).toBeNull()
  })

  it('3. 改密成功：旗標清掉、其他裝置的登入被撤、目前這一台留著', async () => {
    const row = await a1Row()
    const userId = String(row!.id)

    // 兩個「裝置」各自登入。
    const deviceA = await signInViaHttp(ONE_TIME_PASSWORD)
    const deviceB = await signInViaHttp(ONE_TIME_PASSWORD)
    expect(deviceA.status).toBe(200)
    expect(deviceB.status).toBe(200)
    const before = await sessionCount(userId)
    expect(before).toBeGreaterThanOrEqual(2)

    const result = await composition.getSelfAccountCommand().changePassword(
      new Headers({ cookie: deviceA.cookie }),
      { currentPassword: ONE_TIME_PASSWORD, newPassword: NEW_PASSWORD },
    )
    expect(result.ok, JSON.stringify(result)).toBe(true)

    const after = await a1Row()
    expect(after!.must_change_password, '旗標要被清掉').toBe(false)
    expect(await sessionCount(userId), '其他裝置的 session 被撤，只剩改密的這一台').toBe(1)

    const audit = await db.sql(
      `select actor_kind, actor_user_id, action, payload from audit_events where action = 'account.change_password'`,
    )
    expect(audit.rowCount).toBe(1)
    expect(audit.rows[0]).toMatchObject({ actor_kind: 'user', actor_user_id: userId })
    // 稽核不含密碼。
    expect(JSON.stringify(audit.rows[0]!.payload)).not.toContain(NEW_PASSWORD)
  })

  it('4. 舊的一次性密碼失效', async () => {
    const signIn = await signInViaHttp(ONE_TIME_PASSWORD)
    expect(signIn.status).toBeGreaterThanOrEqual(400)
  })

  it('5. 新密碼登得進去，而且不再被要求改密', async () => {
    const signIn = await signInViaHttp(NEW_PASSWORD)
    expect(signIn.status).toBe(200)

    const { DbActorResolver } = await import('@/infrastructure/auth/actor-resolver')
    const actor = await new DbActorResolver().resolve(new Headers({ cookie: signIn.cookie }))
    expect(statusGate(actor, 'business'), '改完密碼就能做業務動作了').toBeNull()
  })

  it('6. 登出之後那一台的 session 不見了，新密碼還是登得回來', async () => {
    const row = await a1Row()
    const userId = String(row!.id)
    await db.sql('delete from sessions where user_id = $1', [userId])

    const signIn = await signInViaHttp(NEW_PASSWORD)
    expect(signIn.status).toBe(200)
    expect(await sessionCount(userId)).toBe(1)

    await composition.signOut(new Headers({ cookie: signIn.cookie }))
    expect(await sessionCount(userId), '登出把這一台的 session 刪掉').toBe(0)

    const again = await signInViaHttp(NEW_PASSWORD)
    expect(again.status).toBe(200)
  })
})

describe('改密的規則', () => {
  it('新密碼太短、或跟目前的一樣，都被擋下（而且密碼沒被改掉）', async () => {
    const signIn = await signInViaHttp(NEW_PASSWORD)
    const headers = new Headers({ cookie: signIn.cookie })
    const command = composition.getSelfAccountCommand()

    const tooShort = await command.changePassword(headers, {
      currentPassword: NEW_PASSWORD,
      newPassword: 'short',
    })
    expect(tooShort.ok).toBe(false)

    const same = await command.changePassword(headers, {
      currentPassword: NEW_PASSWORD,
      newPassword: NEW_PASSWORD,
    })
    expect(same.ok).toBe(false)

    // 密碼還是原來那一個。
    expect((await signInViaHttp(NEW_PASSWORD)).status).toBe(200)
  })

  it('目前的密碼填錯就改不動，而且訊息不透露「帳號存不存在」以外的事', async () => {
    const signIn = await signInViaHttp(NEW_PASSWORD)
    const result = await composition.getSelfAccountCommand().changePassword(
      new Headers({ cookie: signIn.cookie }),
      { currentPassword: 'definitely-not-the-password', newPassword: 'Another-New-Password-1' },
    )
    expect(result.ok).toBe(false)
    expect((await signInViaHttp(NEW_PASSWORD)).status).toBe(200)
  })

  it('沒有 session 不能改密', async () => {
    const result = await composition.getSelfAccountCommand().changePassword(new Headers(), {
      currentPassword: NEW_PASSWORD,
      newPassword: 'Yet-Another-Password-1',
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('UNAUTHENTICATED')
  })
})

describe('登入限速（契約 03 §6：同一 IP 對同一帳號 10 分鐘 10 次）', () => {
  it('錯 10 次之後，第 11 次連正確的密碼也先被拒', async () => {
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const wrong = await composition.signIn({
        email: A1_EMAIL,
        password: `wrong-${attempt}`,
        ip: '203.0.113.7',
      })
      expect(wrong.ok, `第 ${attempt} 次應該是密碼錯而不是被限速`).toBe(false)
      if (!wrong.ok) expect(wrong.code).toBe('INVALID_CREDENTIALS')
    }

    const correct = await composition.signIn({
      email: A1_EMAIL,
      password: NEW_PASSWORD,
      ip: '203.0.113.7',
    })
    expect(correct.ok).toBe(false)
    if (correct.ok) throw new Error('unreachable')
    expect(correct.code, '達到上限之後連正確的密碼也要先擋').toBe('RATE_LIMITED')
  })

  it('換一個 IP 不受影響（限速鍵是 IP＋帳號）', async () => {
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      await composition.signIn({ email: A1_EMAIL, password: 'wrong', ip: '203.0.113.8' })
    }
    expect((await composition.signIn({ email: A1_EMAIL, password: 'wrong', ip: '203.0.113.8' })).ok).toBe(
      false,
    )

    const fromElsewhere = await composition.signIn({
      email: A1_EMAIL,
      password: NEW_PASSWORD,
      ip: '198.51.100.3',
    })
    expect(fromElsewhere.ok).toBe(true)
  })

  it('登入成功會把計數清掉（不會因為之前打錯幾次就慢慢累積到被鎖）', async () => {
    const ip = '198.51.100.9'
    for (let attempt = 1; attempt <= 9; attempt += 1) {
      await composition.signIn({ email: A1_EMAIL, password: 'wrong', ip })
    }
    expect((await composition.signIn({ email: A1_EMAIL, password: NEW_PASSWORD, ip })).ok).toBe(true)

    // 清掉之後又有完整的 10 次額度。
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const wrong = await composition.signIn({ email: A1_EMAIL, password: 'wrong', ip })
      expect(wrong.ok).toBe(false)
      if (!wrong.ok) expect(wrong.code).toBe('INVALID_CREDENTIALS')
    }
  })
})

// ── 2026-09-16 review 的回歸測試：直接打 HTTP 也要受同一套規則管 ──────────────

describe('直接打 /api/auth/change-password（review Spec 3 的回歸測試）', () => {
  /**
   * review 用隔離 PostgreSQL 重現過：持有效 session 直接 POST 這條路由，
   * 8 個字元的新密碼被接受、另一台裝置的登入還在、稽核一筆都沒有。
   * 規則搬進 hook 之後，這條路跟 Server Action 走同一段程式。
   */

  async function twoDevices() {
    const a = await signInViaHttp(NEW_PASSWORD)
    const b = await signInViaHttp(NEW_PASSWORD)
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    return { a, b }
  }

  async function changeViaHttp(cookie: string, body: Record<string, unknown>) {
    return handlers.POST(
      new Request(`${BASE_URL}/api/auth/change-password`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: BASE_URL, cookie },
        body: JSON.stringify(body),
      }),
    )
  }

  it('8 個字元的新密碼被擋下，密碼沒有被改掉', async () => {
    const { a } = await twoDevices()
    const response = await changeViaHttp(a.cookie, {
      currentPassword: NEW_PASSWORD,
      newPassword: 'Eight888',
    })
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(await response.text()).toContain('至少')

    expect((await signInViaHttp(NEW_PASSWORD)).status, '密碼不該被改掉').toBe(200)
  })

  it('不傳 revokeOtherSessions 也一樣撤掉其他裝置，而且留下稽核', async () => {
    const row = await a1Row()
    const userId = String(row!.id)
    await db.sql('delete from sessions where user_id = $1', [userId])
    // audit_events 是不可變表（連 owner 都刪不掉），所以量的是「增加了幾筆」而不是總數。
    const auditBefore = await db.sql(
      `select count(*)::int as n from audit_events
       where action = 'account.change_password' and actor_user_id = $1`,
      [userId],
    )

    const { a, b } = await twoDevices()
    expect(await sessionCount(userId)).toBe(2)

    // 刻意**不傳** revokeOtherSessions——hook 會直接覆寫請求內容。
    const response = await changeViaHttp(a.cookie, {
      currentPassword: NEW_PASSWORD,
      newPassword: 'Http-Path-New-Password-1',
    })
    expect(response.status).toBe(200)

    expect(await sessionCount(userId), '另一台的 session 要被撤掉').toBe(1)

    const stillValid = await handlers.GET(
      new Request(`${BASE_URL}/api/auth/get-session`, { headers: { cookie: b.cookie } }),
    )
    const body = (await stillValid.json()) as { user?: unknown } | null
    expect(body?.user, '另一台的 cookie 不該還能讀到 session').toBeFalsy()

    const auditAfter = await db.sql(
      `select count(*)::int as n from audit_events
       where action = 'account.change_password' and actor_user_id = $1`,
      [userId],
    )
    expect(
      Number(auditAfter.rows[0]!.n) - Number(auditBefore.rows[0]!.n),
      '要多出一筆稽核',
    ).toBe(1)

    // 改回去，後面的測試繼續用 NEW_PASSWORD。
    const back = await signInViaHttp('Http-Path-New-Password-1')
    await changeViaHttp(back.cookie, {
      currentPassword: 'Http-Path-New-Password-1',
      newPassword: NEW_PASSWORD,
    })
  })

  it('must-change 的人走 HTTP 改密，旗標一樣被清掉', async () => {
    const row = await a1Row()
    const userId = String(row!.id)
    await db.sql('update users set must_change_password = true where id = $1', [userId])

    const signIn = await signInViaHttp(NEW_PASSWORD)
    const response = await changeViaHttp(signIn.cookie, {
      currentPassword: NEW_PASSWORD,
      newPassword: 'Forced-Http-Password-1',
    })
    expect(response.status).toBe(200)
    expect((await a1Row())!.must_change_password).toBe(false)

    const back = await signInViaHttp('Forced-Http-Password-1')
    await changeViaHttp(back.cookie, {
      currentPassword: 'Forced-Http-Password-1',
      newPassword: NEW_PASSWORD,
    })
  })
})

describe('直接打 /api/auth/sign-in/email 的限速（review Spec 4 的回歸測試）', () => {
  /**
   * review 重現過：限速只掛在 Server Action 上，直接打 HTTP 就只剩套件的預設視窗，
   * 錯 11 次之後正確的密碼照樣放行。現在限速在 hook 裡，兩條路共用同一個桶。
   */
  it('同一 IP 同一帳號錯 10 次之後，第 11 次連正確的密碼也被擋', async () => {
    const ip = '203.0.113.77'
    const attempt = (password: string) =>
      handlers.POST(
        new Request(`${BASE_URL}/api/auth/sign-in/email`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: BASE_URL, 'x-real-ip': ip },
          body: JSON.stringify({ email: A1_EMAIL, password }),
        }),
      )

    for (let i = 1; i <= 10; i += 1) {
      const wrong = await attempt(`wrong-${i}`)
      expect(wrong.status, `第 ${i} 次應該是密碼錯而不是被限速`).toBe(401)
    }

    const correct = await attempt(NEW_PASSWORD)
    expect(correct.status, '達到上限之後連正確的密碼也要先擋').toBe(429)
  })

  it('HTTP 與 Server Action 共用同一個桶（不是各算各的）', async () => {
    const ip = '203.0.113.78'
    const attempt = (password: string) =>
      handlers.POST(
        new Request(`${BASE_URL}/api/auth/sign-in/email`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: BASE_URL, 'x-real-ip': ip },
          body: JSON.stringify({ email: A1_EMAIL, password }),
        }),
      )

    // 五次走 HTTP、五次走 Server Action 門面，加起來就滿了。
    for (let i = 1; i <= 5; i += 1) expect((await attempt(`wrong-${i}`)).status).toBe(401)
    for (let i = 1; i <= 5; i += 1) {
      const viaAction = await composition.signIn({ email: A1_EMAIL, password: 'wrong', ip })
      expect(viaAction.ok).toBe(false)
    }

    const viaAction = await composition.signIn({ email: A1_EMAIL, password: NEW_PASSWORD, ip })
    expect(viaAction.ok).toBe(false)
    if (viaAction.ok) throw new Error('unreachable')
    expect(viaAction.code).toBe('RATE_LIMITED')
  })

  /**
   * 2026-09-16 複核 Spec 3 的回歸測試。
   *
   * 上一輪除了 hook 的 IP＋帳號桶，還留著套件的 `/sign-in/email: {window:600,max:60}`。
   * 套件的鍵（`createRateLimitKey(ip, path)`）**不含帳號**，所以那是一個跨帳號共用的桶：
   * 同一個對外 IP 後面 60 個不同帳號各錯一次就把它用完，第 61 個人拿正確密碼也被擋。
   * 全系共用一個校園出口，這條等於隨時可以被任何人（或任何人的手滑）癱瘓掉登入。
   *
   * 現在套件那條關掉了，只剩 hook 的 IP＋帳號桶。別人的失敗不會算到你頭上。
   */
  it('同一個 IP 上別的帳號失敗很多次，不會擋到這個帳號的第一次登入', async () => {
    const ip = '203.0.113.79'
    const signIn = (email: string, password: string) =>
      handlers.POST(
        new Request(`${BASE_URL}/api/auth/sign-in/email`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: BASE_URL, 'x-real-ip': ip },
          body: JSON.stringify({ email, password }),
        }),
      )

    // 同一個 IP，60 個**不同**帳號各失敗一次——正好是上一輪那個桶的容量。
    for (let i = 0; i < 60; i += 1) {
      const other = await signIn(`neighbour-${i}@example.com`, 'whatever-wrong')
      expect(other.status, `第 ${i} 個鄰居應該是登入失敗，不是被限速`).not.toBe(429)
    }

    // A1 自己在這個 IP 上一次都沒錯過，所以他的桶是空的。
    const mine = await signIn(A1_EMAIL, NEW_PASSWORD)
    expect(mine.status, '別人的失敗不該擋到我的第一次登入').toBe(200)
  })
})
