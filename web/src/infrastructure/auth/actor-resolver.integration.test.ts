import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  assertTestDatabaseReachable,
  createIsolatedDatabase,
  TEST_DATABASE_URL,
  type IsolatedDatabase,
} from '../../../test/db'
import { migratedSchema } from '../../../test/migrations'
import { statusGate, type AccountStatus } from '@/application/accounts'

/**
 * S01-03：ActorResolver 的帳號狀態矩陣（模組 01 §5、§10）。
 *
 * 狀態用**直接寫 `users.status`** 的測試資料造出來（票 #46 明寫可以這樣做，
 * 不需要跑完整的註冊流程），這樣矩陣才蓋得滿。
 *
 * 重點在於：狀態是**當下從資料庫讀**的，不是登入當時 cookie 裡的快照——
 * 系辦停用之後，同一個 cookie 下一個請求就該失效。
 */

const BASE_URL = 'http://127.0.0.1:3000'

let db: IsolatedDatabase
let handlers: typeof import('@/infrastructure/auth/wrapper').authRouteHandlers
let resolver: import('@/application/accounts').ActorResolver

beforeAll(async () => {
  await assertTestDatabaseReachable()
  db = await createIsolatedDatabase({ label: 'actor', setup: migratedSchema })

  const url = new URL(TEST_DATABASE_URL)
  url.searchParams.set('options', `-c search_path=${db.schemaName}`)

  vi.resetModules()
  vi.stubEnv('DATABASE_URL', url.toString())
  vi.stubEnv('BETTER_AUTH_SECRET', 'integration-test-secret-integration-test')
  vi.stubEnv('BETTER_AUTH_URL', BASE_URL)

  handlers = (await import('@/infrastructure/auth/wrapper')).authRouteHandlers
  const { DbActorResolver } = await import('@/infrastructure/auth/actor-resolver')
  resolver = new DbActorResolver()
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await db?.close()
})

let counter = 0
async function signedInUser(): Promise<{ userId: string; headers: Headers }> {
  counter += 1
  const email = `actor-${Date.now()}-${counter}@example.com`
  const response = await handlers.POST(
    new Request(`${BASE_URL}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE_URL },
      body: JSON.stringify({ email, password: 'Correct-Horse-Battery-9', name: '身分測試' }),
    }),
  )
  expect(response.status).toBe(200)
  const cookie = response.headers.get('set-cookie') ?? ''
  const row = await db.sql('select id from users where email = $1', [email])
  return { userId: String(row.rows[0]!.id), headers: new Headers({ cookie }) }
}

describe('沒有 session', () => {
  it('完全沒有 cookie → anonymous', async () => {
    const actor = await resolver.resolve(new Headers())
    expect(actor.kind).toBe('anonymous')
  })

  it('cookie 是亂編的 → anonymous', async () => {
    const actor = await resolver.resolve(new Headers({ cookie: 'better-auth.session_token=not-a-real-token' }))
    expect(actor.kind).toBe('anonymous')
  })

  it('session 被刪掉之後（登出、被撤）→ anonymous', async () => {
    const { userId, headers } = await signedInUser()
    expect((await resolver.resolve(headers)).kind).toBe('authenticated')

    await db.sql('delete from sessions where user_id = $1', [userId])
    expect((await resolver.resolve(headers)).kind).toBe('anonymous')
  })
})

describe('狀態是當下讀的，不是登入當時的快照', () => {
  /** 還算「有效登入」的兩個狀態；停用與去識別化在下面另外驗。 */
  const USABLE: AccountStatus[] = ['pending', 'active']

  it.each(USABLE)('把 users.status 改成 %s，同一個 cookie 立刻反映', async (status) => {
    const { userId, headers } = await signedInUser()
    await db.sql('update users set status = $2 where id = $1', [userId, status])

    const actor = await resolver.resolve(headers)
    expect(actor.kind).toBe('authenticated')
    if (actor.kind !== 'authenticated') throw new Error('unreachable')
    expect(actor.status).toBe(status)
  })

  it('改成 disabled：同一個 cookie 立刻變成「未登入」（契約 03 §2）', async () => {
    const { userId, headers } = await signedInUser()
    expect((await resolver.resolve(headers)).kind).toBe('authenticated')

    await db.sql(`update users set status = 'disabled', banned = false where id = $1`, [userId])

    // 停用的人不是「身分是 disabled 的登入者」，而是**當作沒有登入**——
    // `/get-session` 在 hook 就被擋掉了（S01-02），這裡把它翻譯成 ANONYMOUS。
    expect((await resolver.resolve(headers)).kind).toBe('anonymous')
  })

  it('去識別化過的帳號也一律當作未登入（即使 status 還沒改）', async () => {
    const { userId, headers } = await signedInUser()
    await db.sql(`update users set status = 'active', deidentified_at = now() where id = $1`, [userId])

    expect((await resolver.resolve(headers)).kind).toBe('anonymous')
  })

  it('must_change_password 也是當下讀的', async () => {
    const { userId, headers } = await signedInUser()
    const before = await resolver.resolve(headers)
    if (before.kind !== 'authenticated') throw new Error('unreachable')
    expect(before.mustChangePassword).toBe(false)

    await db.sql('update users set must_change_password = true where id = $1', [userId])
    const after = await resolver.resolve(headers)
    if (after.kind !== 'authenticated') throw new Error('unreachable')
    expect(after.mustChangePassword).toBe(true)
  })
})

describe('狀態矩陣：解出來的身分套上閘門，結果與規格一致', () => {
  it('pending 只能看與改自己的申請、改密、讀 session', async () => {
    const { userId, headers } = await signedInUser()
    await db.sql(`update users set status = 'pending' where id = $1`, [userId])
    const actor = await resolver.resolve(headers)

    expect(statusGate(actor, 'registration.viewOwn')).toBeNull()
    expect(statusGate(actor, 'registration.reviseOwn')).toBeNull()
    expect(statusGate(actor, 'self.changePassword')).toBeNull()
    expect(statusGate(actor, 'self.session')).toBeNull()
    expect(statusGate(actor, 'business')).toBe('ACCOUNT_PENDING')
    expect(statusGate(actor, 'self.linkAccount')).toBe('ACCOUNT_PENDING')
  })

  it('must-change 只能改密與登出', async () => {
    const { userId, headers } = await signedInUser()
    await db.sql(`update users set status = 'active', must_change_password = true where id = $1`, [userId])
    const actor = await resolver.resolve(headers)

    expect(statusGate(actor, 'self.changePassword')).toBeNull()
    expect(statusGate(actor, 'self.session')).toBeNull()
    expect(statusGate(actor, 'business')).toBe('PASSWORD_CHANGE_REQUIRED')
    expect(statusGate(actor, 'registration.viewOwn')).toBe('PASSWORD_CHANGE_REQUIRED')
  })

  it('disabled 一律當作未登入（每一種能力都是 UNAUTHENTICATED）', async () => {
    const { userId, headers } = await signedInUser()
    await db.sql(`update users set status = 'disabled' where id = $1`, [userId])
    const actor = await resolver.resolve(headers)

    expect(actor.kind).toBe('anonymous')
    for (const capability of ['self.session', 'self.changePassword', 'business'] as const) {
      expect(statusGate(actor, capability)).toBe('UNAUTHENTICATED')
    }
  })

  it('active 全部放行（狀態層面；角色與關係另判）', async () => {
    const { userId, headers } = await signedInUser()
    await db.sql(`update users set status = 'active' where id = $1`, [userId])
    const actor = await resolver.resolve(headers)

    for (const capability of ['self.session', 'self.changePassword', 'business', 'self.linkAccount'] as const) {
      expect(statusGate(actor, capability)).toBeNull()
    }
  })
})

describe('角色來自 role_assignments，不是套件的 users.role', () => {
  it('沒有指派就沒有角色', async () => {
    const { headers } = await signedInUser()
    const actor = await resolver.resolve(headers)
    if (actor.kind !== 'authenticated') throw new Error('unreachable')
    expect(actor.roles).toEqual([])
  })

  it('有效的指派會出現；撤銷之後就不見了', async () => {
    const { userId, headers } = await signedInUser()
    await db.sql(
      `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at)
       values (gen_random_uuid(), $1, 'admin', $1, now())`,
      [userId],
    )

    const granted = await resolver.resolve(headers)
    if (granted.kind !== 'authenticated') throw new Error('unreachable')
    expect(granted.roles).toEqual(['admin'])

    await db.sql(`update role_assignments set revoked_real_at = now() where user_id = $1`, [userId])
    const revoked = await resolver.resolve(headers)
    if (revoked.kind !== 'authenticated') throw new Error('unreachable')
    expect(revoked.roles).toEqual([])
  })

  it('套件自己的 users.role 不算業務角色', async () => {
    const { userId, headers } = await signedInUser()
    // admin plugin 的欄位設成 admin，但沒有任何 role_assignments。
    await db.sql(`update users set role = 'admin' where id = $1`, [userId])

    const actor = await resolver.resolve(headers)
    if (actor.kind !== 'authenticated') throw new Error('unreachable')
    expect(actor.roles, 'users.role 是套件欄，不是業務角色').toEqual([])
  })
})

describe('屆別成員關係', () => {
  it('學生帶著 profile 的屆別', async () => {
    const { userId, headers } = await signedInUser()
    const cohort = await db.sql(
      `insert into cohorts (id, code, name, created_by_kind)
       values (gen_random_uuid(), '115-A-${counter}', '115 學年', 'system') returning id`,
    )
    const cohortId = String(cohort.rows[0]!.id)
    await db.sql(
      `insert into user_profiles (user_id, display_name, name_normalized, cohort_id, contact_email)
       values ($1, '學生', 'xuesheng', $2, 'x@example.com')`,
      [userId, cohortId],
    )
    await db.sql(
      `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at)
       values (gen_random_uuid(), $1, 'student', $1, now())`,
      [userId],
    )

    const actor = await resolver.resolve(headers)
    if (actor.kind !== 'authenticated') throw new Error('unreachable')
    expect(actor.cohortMemberships).toEqual([{ cohortId, role: 'student' }])
  })

  it('沒有 profile 的人（老師、管理員）沒有屆別成員關係', async () => {
    const { userId, headers } = await signedInUser()
    await db.sql(
      `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at)
       values (gen_random_uuid(), $1, 'admin', $1, now())`,
      [userId],
    )
    const actor = await resolver.resolve(headers)
    if (actor.kind !== 'authenticated') throw new Error('unreachable')
    expect(actor.cohortMemberships).toEqual([])
  })
})
