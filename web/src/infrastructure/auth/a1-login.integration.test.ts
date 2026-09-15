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
  resetChangePasswordLimiter = (await import('@/infrastructure/auth/self-account'))
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
