import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountCommand, ResolvedActor, Role } from '@/application/accounts'
import {
  assertTestDatabaseReachable,
  createIsolatedDatabase,
  poolAsRole,
  TEST_DATABASE_URL,
  type IsolatedDatabase,
} from '../../../test/db'
import { migratedSchema } from '../../../test/migrations'

/**
 * 票 10b：管理員角色授予／取消、孤兒帳號補建角色（產品模組 01 §2.5；工程模組 01 §5 `grantRole`／`revokeRole`）。
 *
 * 真的 Better Auth（註冊拿 session、用套件的管理員能力證明 `users.role` 真的跟著變）＋真的 PostgreSQL
 * （隔離 schema），**全程以 `fju_app` 連線**。
 *
 * 「做完的樣子」對照：
 * 1. 授予：`role_assignments` 與 `users.role='admin'` 同一個交易；理由必填、留稽核與帳本；
 *    新管理員馬上用得了套件的管理員能力（發臨時密碼）。
 * 2. 取消：兩邊一起改回來；不能取消自己；兩位管理員同時互相取消只會成功一個（不會一位都不剩）。
 * 3. 孤兒帳號：補老師或管理員角色、待審的一併開通；不是孤兒就拒絕。
 */

const BASE_URL = 'http://127.0.0.1:3000'
const PASSWORD = 'Correct-Horse-Battery-9'

let db: IsolatedDatabase
let app: Pool
let command: AccountCommand
let handlers: typeof import('@/infrastructure/auth/wrapper').authRouteHandlers
let resetSignUpLimiter: () => void

let seq = 0
const uniqueEmail = (tag: string) => `t10b-${tag}-${Date.now()}-${++seq}@example.com`
const requestId = () => `10b10b10-1010-4010-8010-${String(++seq).padStart(12, '0')}`

function actorOf(userId: string, roles: Role[], patch: Partial<Extract<ResolvedActor, { kind: 'authenticated' }>> = {}): ResolvedActor {
  return { kind: 'authenticated', userId, roles, status: 'active', mustChangePassword: false, cohortMemberships: [], ...patch }
}

async function one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
  return (await db.sql(sql, params)).rows[0] as T
}

function post(path: string, body: unknown, cookie?: string): Promise<Response> {
  return handlers.POST(
    new Request(`${BASE_URL}/api/auth${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE_URL, 'x-real-ip': `203.0.113.${(seq % 250) + 1}`, ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    }),
  )
}

function cookieOf(response: Response): string {
  return (response.headers.get('set-cookie') ?? '').split(/,(?=[^;]+=)/)[0]!.split(';')[0]!
}

/** 真的註冊一個帳號（拿得到 session cookie），再用 owner 連線把狀態與角色擺成要的樣子。 */
async function account(opts: { status?: 'pending' | 'active' | 'disabled'; roles?: Role[]; profile?: boolean; application?: boolean } = {}) {
  const email = uniqueEmail('u')
  const response = await post('/sign-up/email', { email, password: PASSWORD, name: '測試帳號' })
  expect(response.status, await response.clone().text()).toBe(200)
  const userId = String((await one<{ id: string }>('select id from users where email = $1', [email])).id)
  const roles = opts.roles ?? []
  await db.sql(`update users set status = $2, role = $3 where id = $1`, [userId, opts.status ?? 'active', roles.includes('admin') ? 'admin' : 'user'])
  for (const role of roles) {
    await db.sql(
      `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at) values (gen_random_uuid(), $1, $2, $1, now())`,
      [userId, role],
    )
  }
  if (opts.profile) {
    await db.sql(
      `insert into user_profiles (user_id, display_name, name_normalized, contact_email) values ($1, '有資料的人', '有資料的人', $2)`,
      [userId, email],
    )
  }
  if (opts.application) {
    await db.sql(
      `insert into registration_applications (id, user_id, applied_name, student_no, phone, contact_email, login_email, state, revision, created_by_kind, created_by_user_id)
       values (gen_random_uuid(), $1, '申請人', '411510099', '0912-000-000', $2, $2, 'pending', 1, 'user', $1)`,
      [userId, email],
    )
  }
  return { userId, email, cookie: cookieOf(response), actor: actorOf(userId, roles), headers: new Headers({ cookie: cookieOf(response) }) }
}

/** 讓連線池先有兩條閒置連線，並行的兩個呼叫才會真的同時搶鎖。 */
async function warmPool() {
  const [c1, c2] = await Promise.all([app.connect(), app.connect()])
  c1.release()
  c2.release()
}

const validAdmins = (userId: string) =>
  one<{ n: number }>(`select count(*)::int as n from role_assignments where user_id = $1 and role = 'admin' and revoked_real_at is null`, [userId])

beforeAll(async () => {
  await assertTestDatabaseReachable()
  db = await createIsolatedDatabase({ label: 't10b-roles', setup: migratedSchema })
  app = await poolAsRole(db, 'fju_app')

  const url = new URL(TEST_DATABASE_URL)
  url.username = 'fju_app'
  url.password = process.env.TEST_FJU_APP_PASSWORD ?? 'fju_app_local_test'
  url.searchParams.set('options', `-c search_path=${db.schemaName}`)

  vi.resetModules()
  vi.stubEnv('DATABASE_URL', url.toString())
  vi.stubEnv('BETTER_AUTH_SECRET', 'integration-test-secret-integration-test')
  vi.stubEnv('BETTER_AUTH_URL', BASE_URL)

  handlers = (await import('@/infrastructure/auth/wrapper')).authRouteHandlers
  resetSignUpLimiter = (await import('@/infrastructure/auth/sign-up-rate-limit')).resetSignUpLimiter
  const { PgAccountCommand } = await import('@/infrastructure/accounts/account-command')
  const { PgAuditWriter } = await import('@/infrastructure/ops/audit-writer')
  const { PgOperationLedger } = await import('@/infrastructure/ops/operation-ledger')
  command = new PgAccountCommand({ audit: new PgAuditWriter(), ledger: new PgOperationLedger(() => app), db: () => app })
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await app?.end()
  await db?.close()
})

beforeEach(() => {
  resetSignUpLimiter()
})

describe('設為管理員', () => {
  it('老師 → 管理員：業務角色與套件的 users.role 一起寫、稽核有理由、重播回同一張回執；新管理員馬上用得了套件的管理員能力', async () => {
    const a1 = await account({ roles: ['admin'] })
    const teacher = await account({ roles: ['teacher'] })
    const student = await account({ roles: ['student'] })
    const input = { userId: teacher.userId, role: 'admin', reason: '新任系辦承辦人', requestId: requestId() }

    const granted = await command.grantRole(a1.actor, input)
    expect(granted).toMatchObject({ ok: true, receipt: { userId: teacher.userId, role: 'admin', granted: true } })
    expect(await validAdmins(teacher.userId)).toEqual({ n: 1 })
    expect(await one(`select role from users where id = $1`, [teacher.userId])).toEqual({ role: 'admin' })
    // 原本的老師角色還在。
    expect(await one(`select count(*)::int as n from role_assignments where user_id = $1 and role = 'teacher' and revoked_real_at is null`, [teacher.userId])).toEqual({ n: 1 })
    expect(
      await one(`select actor_user_id, reason, payload from audit_events where action = 'account.grant_role' and target_id = $1`, [teacher.userId]),
    ).toEqual({ actor_user_id: a1.userId, reason: '新任系辦承辦人', payload: { role: 'admin' } })

    // 同一個請求重送：同一張回執，不會多一列角色。
    expect(await command.grantRole(a1.actor, input)).toMatchObject({ ok: true, receipt: { userId: teacher.userId, granted: true } })
    expect(await validAdmins(teacher.userId)).toEqual({ n: 1 })

    // 套件看的是 users.role：新管理員替學生發臨時密碼，套件的 admin middleware 放行。
    const issued = await command.issueTemporaryPassword(actorOf(teacher.userId, ['admin', 'teacher']), teacher.headers, {
      userId: student.userId,
      verificationMethod: 'id_document',
      verificationNote: '',
      reason: '',
      requestId: requestId(),
    })
    expect(issued).toMatchObject({ ok: true, secret: expect.any(String) })
  })

  it('沒有角色的職員帳號（active）也可以設為管理員', async () => {
    const a1 = await account({ roles: ['admin'] })
    const staff = await account({ profile: true })
    expect(await command.grantRole(a1.actor, { userId: staff.userId, role: 'admin', reason: '系辦助理', requestId: requestId() })).toMatchObject({ ok: true })
    expect(await one(`select role from users where id = $1`, [staff.userId])).toEqual({ role: 'admin' })
  })

  it('理由必填、只能設管理員、不能對自己、學生／待審／停用不行、已經是管理員回 CONFLICT、非管理員被擋——都不改任何東西', async () => {
    const a1 = await account({ roles: ['admin'] })
    const other = await account({ roles: ['admin'] })
    const teacher = await account({ roles: ['teacher'] })
    const student = await account({ roles: ['student'] })
    const pending = await account({ status: 'pending' })
    const disabled = await account({ status: 'disabled', roles: ['teacher'] })
    const grant = (actor: ResolvedActor, userId: string, patch: Record<string, string> = {}) =>
      command.grantRole(actor, { userId, role: 'admin', reason: '理由', requestId: requestId(), ...patch })

    expect(await grant(a1.actor, teacher.userId, { reason: '   ' })).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', details: { field: 'reason' } })
    expect(await grant(a1.actor, teacher.userId, { role: 'teacher' })).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', details: { field: 'role' } })
    expect(await grant(a1.actor, a1.userId)).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(await grant(a1.actor, student.userId)).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    expect(await grant(a1.actor, pending.userId)).toMatchObject({ ok: false, code: 'CONFLICT' })
    expect(await grant(a1.actor, disabled.userId)).toMatchObject({ ok: false, code: 'CONFLICT' })
    expect(await grant(a1.actor, other.userId)).toMatchObject({ ok: false, code: 'CONFLICT' })
    expect(await grant(teacher.actor, student.userId)).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(await grant({ kind: 'anonymous' }, student.userId)).toMatchObject({ ok: false, code: 'UNAUTHENTICATED' })

    for (const who of [teacher, student, pending, disabled]) {
      expect(await validAdmins(who.userId)).toEqual({ n: 0 })
      expect(await one(`select role from users where id = $1`, [who.userId])).toEqual({ role: 'user' })
    }
    expect(await one(`select count(*)::int as n from audit_events where action = 'account.grant_role' and actor_user_id = $1`, [a1.userId])).toEqual({ n: 0 })
  })

  it('請求開始時是管理員、但此刻已被取消（actor 過期）→ 擋下', async () => {
    const a1 = await account({ roles: ['admin'] })
    const teacher = await account({ roles: ['teacher'] })
    await db.sql(`update role_assignments set revoked_real_at = now(), revoked_by_user_id = user_id where user_id = $1 and role = 'admin'`, [a1.userId])
    expect(await command.grantRole(a1.actor, { userId: teacher.userId, role: 'admin', reason: '理由', requestId: requestId() })).toMatchObject({
      ok: false,
      code: 'FORBIDDEN',
    })
    expect(await validAdmins(teacher.userId)).toEqual({ n: 0 })
  })
})

describe('取消管理員', () => {
  it('業務角色結束、users.role 改回 user、稽核有理由；老師角色不受影響；被取消的人馬上不能用套件的管理員能力', async () => {
    const a1 = await account({ roles: ['admin'] })
    const target = await account({ roles: ['admin', 'teacher'] })
    const student = await account({ roles: ['student'] })

    const revoked = await command.revokeRole(a1.actor, { userId: target.userId, role: 'admin', reason: '職務調整', requestId: requestId() })
    expect(revoked).toMatchObject({ ok: true, receipt: { userId: target.userId, role: 'admin', granted: false } })
    expect(await validAdmins(target.userId)).toEqual({ n: 0 })
    expect(
      await one(`select revoked_by_user_id, reason from role_assignments where user_id = $1 and role = 'admin'`, [target.userId]),
    ).toEqual({ revoked_by_user_id: a1.userId, reason: '職務調整' })
    expect(await one(`select role from users where id = $1`, [target.userId])).toEqual({ role: 'user' })
    expect(await one(`select count(*)::int as n from role_assignments where user_id = $1 and role = 'teacher' and revoked_real_at is null`, [target.userId])).toEqual({ n: 1 })
    expect(await one(`select reason from audit_events where action = 'account.revoke_role' and target_id = $1`, [target.userId])).toEqual({ reason: '職務調整' })

    // 正式環境的 actor 每次請求由 `ActorResolver` 重讀 `role_assignments`，他已經不是管理員。
    // 這裡故意塞一個過期的 actor 繞過用例那一層，證明套件那一層也擋：`users.role` 真的改回來了。
    expect(
      await command.issueTemporaryPassword(actorOf(target.userId, ['admin', 'teacher']), target.headers, {
        userId: student.userId,
        verificationMethod: 'id_document',
        verificationNote: '',
        reason: '',
        requestId: requestId(),
      }),
    ).toMatchObject({ ok: false })

    // 已經不是管理員：再取消一次（新的請求）回 CONFLICT。
    expect(await command.revokeRole(a1.actor, { userId: target.userId, role: 'admin', reason: '再一次', requestId: requestId() })).toMatchObject({
      ok: false,
      code: 'CONFLICT',
    })
  })

  it('不能取消自己的管理員角色', async () => {
    const a1 = await account({ roles: ['admin'] })
    expect(await command.revokeRole(a1.actor, { userId: a1.userId, role: 'admin', reason: '離職', requestId: requestId() })).toMatchObject({
      ok: false,
      code: 'FORBIDDEN',
    })
    expect(await validAdmins(a1.userId)).toEqual({ n: 1 })
  })

  it('最後一位管理員保護：兩位管理員同時互相取消，只有一個成功，系統至少留一位有效管理員', async () => {
    // 先把這個 schema 裡其他管理員都停用，讓 A、B 成為僅有的兩位有效管理員。
    await db.sql(
      `update users set status = 'disabled'
        where id in (select user_id from role_assignments where role = 'admin' and revoked_real_at is null)`,
    )
    const a = await account({ roles: ['admin'] })
    const b = await account({ roles: ['admin'] })
    const effective = () =>
      one<{ n: number }>(
        `select count(*)::int as n from role_assignments ra join users u on u.id = ra.user_id
          where ra.role = 'admin' and ra.revoked_real_at is null and u.status = 'active' and u.deidentified_at is null`,
      )
    expect(await effective()).toEqual({ n: 2 })

    // 先暖好兩條連線：不然第二個呼叫要現開 TCP 連線，第一個交易早就 commit 了，證明不了鎖。
    await warmPool()
    const [ab, ba] = await Promise.all([
      command.revokeRole(a.actor, { userId: b.userId, role: 'admin', reason: '互相取消', requestId: requestId() }),
      command.revokeRole(b.actor, { userId: a.userId, role: 'admin', reason: '互相取消', requestId: requestId() }),
    ])
    const outcomes = [ab, ba].map((r) => r.ok)
    expect(outcomes.filter(Boolean)).toHaveLength(1)
    expect([ab, ba].find((r) => !r.ok)).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(await effective()).toEqual({ n: 1 })

    // 剩下的那一位不能取消自己——系統永遠至少一位。
    const survivor = ab.ok ? a : b
    expect(await command.revokeRole(survivor.actor, { userId: survivor.userId, role: 'admin', reason: '離職', requestId: requestId() })).toMatchObject({
      ok: false,
      code: 'FORBIDDEN',
    })
    expect(await effective()).toEqual({ n: 1 })
  })

  it('最後一位管理員保護：A 取消 B 的同時 B 停用 A（取消與停用兩條路共用同一把鎖），只有一個成功', async () => {
    const { PgAccountDirectoryCommand } = await import('@/infrastructure/accounts/account-directory-command')
    const { PgAuditWriter } = await import('@/infrastructure/ops/audit-writer')
    const { PgOperationLedger } = await import('@/infrastructure/ops/operation-ledger')
    const directory = new PgAccountDirectoryCommand({ audit: new PgAuditWriter(), ledger: new PgOperationLedger(() => app), db: () => app })
    await db.sql(
      `update users set status = 'disabled'
        where id in (select user_id from role_assignments where role = 'admin' and revoked_real_at is null)`,
    )
    const a = await account({ roles: ['admin'] })
    const b = await account({ roles: ['admin'] })

    await warmPool()
    const [revoked, disabled] = await Promise.all([
      command.revokeRole(a.actor, { userId: b.userId, role: 'admin', reason: '同時', requestId: requestId() }),
      directory.disable(b.actor, { userId: a.userId, reason: '同時', requestId: requestId() }, { headers: b.headers }),
    ])
    expect([revoked, disabled].filter((r) => r.ok)).toHaveLength(1)
    expect([revoked, disabled].find((r) => !r.ok)).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(
      await one(
        `select count(*)::int as n from role_assignments ra join users u on u.id = ra.user_id
          where ra.role = 'admin' and ra.revoked_real_at is null and u.status = 'active' and u.deidentified_at is null`,
      ),
    ).toEqual({ n: 1 })
  })
})

describe('孤兒帳號補建角色', () => {
  it('待審、沒有角色／申請／個人資料 → 補成老師：開通、老師角色、狀態事件與稽核；之後就不是孤兒了', async () => {
    const a1 = await account({ roles: ['admin'] })
    const orphan = await account({ status: 'pending' })
    const input = { userId: orphan.userId, role: 'teacher', reason: '新增老師時系統出錯，補建', requestId: requestId() }

    const repaired = await command.repairOrphan(a1.actor, input)
    expect(repaired).toMatchObject({ ok: true, receipt: { userId: orphan.userId, role: 'teacher', activated: true } })
    expect(await one(`select status, role from users where id = $1`, [orphan.userId])).toEqual({ status: 'active', role: 'user' })
    expect(await one(`select role, granted_by_user_id from role_assignments where user_id = $1 and revoked_real_at is null`, [orphan.userId])).toEqual({
      role: 'teacher',
      granted_by_user_id: a1.userId,
    })
    expect(await one(`select from_status, to_status, actor_user_id from user_status_events where user_id = $1`, [orphan.userId])).toEqual({
      from_status: 'pending',
      to_status: 'active',
      actor_user_id: a1.userId,
    })
    expect(await one(`select reason, payload from audit_events where action = 'account.repair_orphan' and target_id = $1`, [orphan.userId])).toEqual({
      reason: '新增老師時系統出錯，補建',
      payload: { role: 'teacher', activated: true },
    })
    // 重播回同一張回執；換新的請求再補一次 → 已經不是孤兒。
    expect(await command.repairOrphan(a1.actor, input)).toMatchObject({ ok: true, receipt: { role: 'teacher' } })
    expect(await command.repairOrphan(a1.actor, { ...input, requestId: requestId() })).toMatchObject({ ok: false, code: 'CONFLICT' })
  })

  it('補成職員（管理員）：users.role 一起改成 admin', async () => {
    const a1 = await account({ roles: ['admin'] })
    const orphan = await account({ status: 'pending' })
    expect(await command.repairOrphan(a1.actor, { userId: orphan.userId, role: 'admin', reason: '系辦新同事', requestId: requestId() })).toMatchObject({
      ok: true,
      receipt: { role: 'admin', activated: true },
    })
    expect(await one(`select status, role from users where id = $1`, [orphan.userId])).toEqual({ status: 'active', role: 'admin' })
    expect(await validAdmins(orphan.userId)).toEqual({ n: 1 })
  })

  it('不是孤兒（有申請、有角色、有個人資料、已停用）、角色不對、沒寫理由、非管理員 → 拒絕且不改任何東西', async () => {
    const a1 = await account({ roles: ['admin'] })
    const applicant = await account({ status: 'pending', application: true })
    const teacher = await account({ roles: ['teacher'] })
    const withProfile = await account({ profile: true })
    const disabled = await account({ status: 'disabled' })
    const orphan = await account({ status: 'pending' })
    const repair = (actor: ResolvedActor, userId: string, patch: Record<string, string> = {}) =>
      command.repairOrphan(actor, { userId, role: 'teacher', reason: '補建', requestId: requestId(), ...patch })

    for (const who of [applicant, teacher, withProfile, disabled]) {
      expect(await repair(a1.actor, who.userId)).toMatchObject({ ok: false, code: 'CONFLICT' })
    }
    expect(await repair(a1.actor, orphan.userId, { role: 'student' })).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', details: { field: 'role' } })
    expect(await repair(a1.actor, orphan.userId, { reason: '' })).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', details: { field: 'reason' } })
    expect(await repair(teacher.actor, orphan.userId)).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(await one(`select status from users where id = $1`, [orphan.userId])).toEqual({ status: 'pending' })
    expect(await one(`select count(*)::int as n from role_assignments where user_id = $1`, [orphan.userId])).toEqual({ n: 0 })
    expect(await one(`select count(*)::int as n from role_assignments where user_id = $1`, [applicant.userId])).toEqual({ n: 0 })
  })
})
