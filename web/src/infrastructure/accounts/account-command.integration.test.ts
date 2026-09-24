import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountCommand, ResolvedActor, TeacherSetupCommand } from '@/application/accounts'
import {
  assertTestDatabaseReachable,
  createIsolatedDatabase,
  poolAsRole,
  TEST_DATABASE_URL,
  type IsolatedDatabase,
} from '../../../test/db'
import { migratedSchema } from '../../../test/migrations'

/**
 * 票 8：老師帳號與臨時密碼（ACC-06、07、08、18 的系統面；工程模組 01 §3、契約 03 §3）。
 *
 * 真的 Better Auth（建帳號、設密碼、撤 session 都經內部包裝器）＋真的 PostgreSQL（隔離 schema），
 * **全程以 `fju_app` 連線**：用例若偷偷需要更多權限，這裡會直接紅。
 *
 * 「做完的樣子」對照：
 * 1. 直接新增／預授權；老師補資料後 `needsSetup` 變 false。
 * 2. 臨時密碼只在第一次回應裡、核發前必記核實方式、舊密碼與舊登入失效、登入後強制改密。
 * 3. 秘密不在 DB（稽核、帳本、users）裡；重播拿不到秘密。
 * 另外：預授權的 Email 別人不能搶先註冊。
 */

const BASE_URL = 'http://127.0.0.1:3000'
const PASSWORD = 'Correct-Horse-Battery-9'

let db: IsolatedDatabase
let app: Pool
let command: AccountCommand
let setup: TeacherSetupCommand
let handlers: typeof import('@/infrastructure/auth/wrapper').authRouteHandlers
let makeCommand: (auth?: import('@/infrastructure/accounts/account-command').AccountAuthCalls) => AccountCommand
let resetSignUpLimiter: () => void
let resetSignInLimiter: () => void

let adminId: string
let adminHeaders: Headers

/** 這個檔核發過的每一組臨時密碼，最後一條測試逐一去 log 裡找（契約 03 §3：log 不含秘密）。 */
const issuedSecrets: string[] = []
const logged: string[] = []
function remember<T>(result: T): T {
  const secret = (result as { secret?: unknown }).secret
  if (typeof secret === 'string') issuedSecrets.push(secret)
  return result
}

let seq = 0
const uniqueEmail = (tag: string) => `t08-${tag}-${Date.now()}-${++seq}@example.com`
const requestId = () => `88888888-8888-4888-8888-${String(++seq).padStart(12, '0')}`

function actorOf(userId: string, roles: ('admin' | 'teacher' | 'student')[], patch: Partial<Extract<ResolvedActor, { kind: 'authenticated' }>> = {}): ResolvedActor {
  return { kind: 'authenticated', userId, roles, status: 'active', mustChangePassword: false, cohortMemberships: [], ...patch }
}
const admin = () => actorOf(adminId, ['admin'])

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

async function signUp(email: string, password = PASSWORD): Promise<{ userId: string; cookie: string }> {
  const response = await post('/sign-up/email', { email, password, name: '測試帳號' })
  expect(response.status, await response.clone().text()).toBe(200)
  const row = await one<{ id: string }>('select id from users where email = $1', [email])
  return { userId: row.id, cookie: cookieOf(response) }
}

async function signIn(email: string, password: string): Promise<Response> {
  return post('/sign-in/email', { email, password })
}

async function sessionUser(cookie: string): Promise<string | null> {
  const response = await handlers.GET(new Request(`${BASE_URL}/api/auth/get-session`, { headers: { cookie, origin: BASE_URL } }))
  if (response.status !== 200) return null
  const body = (await response.json()) as { user?: { id?: string } } | null
  return body?.user?.id ?? null
}

/** 整個資料庫裡有沒有出現這個字串（稽核、帳本、users、accounts……每一張表的每一列轉成文字來找）。 */
async function secretAppearsAnywhere(secret: string): Promise<string[]> {
  const tables = await db.sql(
    `select table_name from information_schema.tables where table_schema = current_schema() and table_type = 'BASE TABLE'`,
  )
  const hits: string[] = []
  for (const { table_name } of tables.rows) {
    const found = await db.sql(`select count(*)::int as n from "${String(table_name)}" t where t::text like $1`, [`%${secret}%`])
    if (Number(found.rows[0]!.n) > 0) hits.push(String(table_name))
  }
  return hits
}

beforeAll(async () => {
  await assertTestDatabaseReachable()
  db = await createIsolatedDatabase({ label: 't08-accounts', setup: migratedSchema })
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
  resetSignInLimiter = (await import('@/infrastructure/auth/sign-in-rate-limit')).resetSignInLimiter
  const { PgAccountCommand } = await import('@/infrastructure/accounts/account-command')
  const { PgTeacherSetupCommand } = await import('@/infrastructure/accounts/teacher-setup')
  const { PgAuditWriter } = await import('@/infrastructure/ops/audit-writer')
  const { PgOperationLedger } = await import('@/infrastructure/ops/operation-ledger')
  makeCommand = (auth) =>
    new PgAccountCommand({ audit: new PgAuditWriter(), ledger: new PgOperationLedger(() => app), db: () => app, ...(auth ? { auth } : {}) })
  command = makeCommand()
  setup = new PgTeacherSetupCommand({ audit: new PgAuditWriter(), db: () => app })

  // A1：真的註冊一個帳號拿 session，再提升成管理員（admin plugin 要 users.role='admin'）。
  const a1 = await signUp(uniqueEmail('a1'))
  adminId = a1.userId
  await db.sql(`update users set role = 'admin', status = 'active' where id = $1`, [adminId])
  await db.sql(
    `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at) values (gen_random_uuid(), $1, 'admin', $1, now())`,
    [adminId],
  )
  adminHeaders = new Headers({ cookie: a1.cookie })

  // 攔下整個檔的 console 輸出（Better Auth 的 logger 也寫 console），照樣印出來，但留一份拿來掃描。
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const original = console[level].bind(console)
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (a instanceof Error ? `${a.name} ${a.message} ${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
      original(...args)
    })
  }
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await app?.end()
  await db?.close()
})

beforeEach(() => {
  resetSignUpLimiter()
  resetSignInLimiter()
})

describe('直接新增老師（ACC-06）', () => {
  it('建好就是有老師角色的正常帳號；臨時密碼只在第一次回應裡，登入後被要求改密', async () => {
    const email = uniqueEmail('t1')
    const rid = requestId()
    const input = { mode: 'direct' as const, email, name: '林老師', verificationMethod: 'id_document', verificationNote: '', requestId: rid }
    const created = remember(await command.createTeacher(admin(), adminHeaders, input))
    expect(created).toMatchObject({ ok: true, expiresAt: null, receipt: { requestId: rid, kind: 'temp_password', issuedBy: adminId } })
    const secret = (created as { secret: string }).secret
    expect(secret).toMatch(/^[A-Za-z0-9]{4}(-[A-Za-z0-9]{4}){3}$/)
    const userId = (created as unknown as { account: { userId: string } }).account.userId

    expect(await one('select status, must_change_password, name from users where id = $1', [userId])).toEqual({
      status: 'active',
      must_change_password: true,
      name: '林老師',
    })
    expect(await one(`select role, granted_by_user_id from role_assignments where user_id = $1 and revoked_real_at is null`, [userId])).toEqual({
      role: 'teacher',
      granted_by_user_id: adminId,
    })
    expect(
      await one(`select from_status, to_status, verification_method, actor_user_id from user_status_events where user_id = $1`, [userId]),
    ).toEqual({ from_status: 'pending', to_status: 'active', verification_method: 'id_document', actor_user_id: adminId })
    expect(await one(`select actor_user_id, verification_method from audit_events where action = 'account.create_teacher' and target_id = $1`, [userId])).toEqual({
      actor_user_id: adminId,
      verification_method: 'id_document',
    })

    // 臨時密碼登得進去，而且 must-change 讓他只能改密碼。
    const signedIn = await signIn(email, secret)
    expect(signedIn.status).toBe(200)
    expect(((await signedIn.json()) as { user: { mustChangePassword: boolean } }).user.mustChangePassword).toBe(true)

    // 秘密不在資料庫的任何地方（雜湊不算：它不是原文）。
    expect(await secretAppearsAnywhere(secret)).toEqual([])

    // 同一個請求重送：拿到回執，**沒有**秘密。
    const replay = await command.createTeacher(admin(), adminHeaders, input)
    expect(replay).toMatchObject({ ok: true, receipt: { userId, temporaryPasswordIssued: true } })
    expect(JSON.stringify(replay)).not.toContain(secret)
    expect('secret' in replay).toBe(false)
    expect(await one('select count(*)::int as n from users where lower(email) = $1', [email])).toEqual({ n: 1 })
  })

  it('直接新增一定要記核實方式；Email 已經有帳號就不能再建', async () => {
    const email = uniqueEmail('dup')
    expect(
      await command.createTeacher(admin(), adminHeaders, { mode: 'direct', email, name: '沒核實', verificationMethod: '', verificationNote: '', requestId: requestId() }),
    ).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', details: { field: 'verificationMethod' } })
    expect(await one('select count(*)::int as n from users where email = $1', [email])).toEqual({ n: 0 })

    await signUp(email)
    expect(
      await command.createTeacher(admin(), adminHeaders, { mode: 'preauthorize', email: email.toUpperCase(), name: '', verificationMethod: '', verificationNote: '', requestId: requestId() }),
    ).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', details: { field: 'email' } })
    // 那個已經註冊的人沒有被變成老師。
    expect(await one(`select count(*)::int as n from role_assignments ra join users u on u.id = ra.user_id where u.email = $1`, [email])).toEqual({ n: 0 })
  })

  it('非管理員（老師、改密前的管理員、未登入）一律被擋，帳號沒建出來', async () => {
    const email = uniqueEmail('forbidden')
    const input = { mode: 'preauthorize' as const, email, name: '', verificationMethod: '', verificationNote: '', requestId: requestId() }
    expect(await command.createTeacher(actorOf(adminId, ['teacher']), adminHeaders, input)).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(await command.createTeacher(actorOf(adminId, ['admin'], { mustChangePassword: true }), adminHeaders, input)).toMatchObject({
      ok: false,
      code: 'PASSWORD_CHANGE_REQUIRED',
    })
    expect(await command.createTeacher({ kind: 'anonymous' }, adminHeaders, input)).toMatchObject({ ok: false, code: 'UNAUTHENTICATED' })
    expect(await one('select count(*)::int as n from users where email = $1', [email])).toEqual({ n: 0 })
  })
})

describe('預授權老師（ACC-07）', () => {
  it('只用 Email 建：沒有密碼、沒人登得進去；別人拿同一個 Email 註冊被拒，預授權帳號不變', async () => {
    const email = uniqueEmail('t2')
    const created = await command.createTeacher(admin(), adminHeaders, {
      mode: 'preauthorize',
      email,
      name: '',
      verificationMethod: '',
      verificationNote: '',
      requestId: requestId(),
    })
    expect(created).toMatchObject({ ok: true, receipt: { mode: 'preauthorize', name: null, temporaryPasswordIssued: false } })
    expect('secret' in created).toBe(false)
    const userId = (created as { receipt: { userId: string } }).receipt.userId

    expect(await one('select status, must_change_password from users where id = $1', [userId])).toEqual({ status: 'active', must_change_password: false })
    expect(await one('select count(*)::int as n from accounts where user_id = $1', [userId])).toEqual({ n: 0 })
    expect(await setup.needsSetup(userId)).toBe(true)

    // 搶先註冊：被拒，而且沒有替他建申請、沒有改到預授權帳號。
    const hijack = await post('/sign-up/email', { email, password: 'Hijacker-Password-9', name: '冒用者' })
    expect(hijack.status).toBeGreaterThanOrEqual(400)
    expect(await one('select count(*)::int as n from users where lower(email) = $1', [email])).toEqual({ n: 1 })
    expect(await one('select count(*)::int as n from accounts where user_id = $1', [userId])).toEqual({ n: 0 })
    expect(await one('select count(*)::int as n from registration_applications where user_id = $1', [userId])).toEqual({ n: 0 })
    expect((await signIn(email, 'Hijacker-Password-9')).status).toBeGreaterThanOrEqual(400)

    // 系辦之後替他發臨時密碼：套件補建 credential 帳號，老師就能用密碼登入（Google 由票 10 接）。
    const issued = remember(await command.issueTemporaryPassword(admin(), adminHeaders, {
      userId,
      verificationMethod: 'school_channel',
      verificationNote: '系主任秘書電話確認',
      reason: '',
      requestId: requestId(),
    }))
    expect(issued).toMatchObject({ ok: true })
    const secret = (issued as { secret: string }).secret
    expect((await signIn(email, secret)).status).toBe(200)
    expect(await one(`select count(*)::int as n from accounts where user_id = $1 and provider_id = 'credential'`, [userId])).toEqual({ n: 1 })
  })
})

describe('老師第一次登入補資料', () => {
  it('補姓名與聯絡資料（不需要學號）之後才算完成；補第二次回 CONFLICT；學生不能用', async () => {
    const email = uniqueEmail('t3')
    const created = await command.createTeacher(admin(), adminHeaders, {
      mode: 'preauthorize',
      email,
      name: '',
      verificationMethod: '',
      verificationNote: '',
      requestId: requestId(),
    })
    const userId = (created as { receipt: { userId: string } }).receipt.userId
    const teacher = actorOf(userId, ['teacher'])

    const view = await setup.view(teacher)
    // 預授權沒填姓名：`users.name` 暫放 Email，但畫面不把它當姓名預填。
    expect(view).toMatchObject({ ok: true, receipt: { loginEmail: email, displayName: '', contactEmail: email, completed: false } })

    expect(await setup.complete(teacher, { displayName: '', phone: '', contactEmail: email })).toMatchObject({
      ok: false,
      details: { field: 'displayName' },
    })
    expect(await setup.complete(teacher, { displayName: '陳老師', phone: '', contactEmail: 'chen@example.com' })).toMatchObject({ ok: true })
    expect(await setup.needsSetup(userId)).toBe(false)
    expect(await one('select name from users where id = $1', [userId])).toEqual({ name: '陳老師' })
    expect(
      await one('select display_name, student_no, cohort_id, phone, contact_email from user_profiles where user_id = $1', [userId]),
    ).toEqual({ display_name: '陳老師', student_no: null, cohort_id: null, phone: null, contact_email: 'chen@example.com' })
    expect(await one(`select count(*)::int as n from audit_events where action = 'account.complete_teacher_profile' and target_id = $1`, [userId])).toEqual({ n: 1 })

    expect(await setup.complete(teacher, { displayName: '改名', phone: '', contactEmail: 'x@example.com' })).toMatchObject({ ok: false, code: 'CONFLICT' })
    expect(await setup.complete(actorOf(userId, ['student']), { displayName: '陳', phone: '', contactEmail: 'c@example.com' })).toMatchObject({
      ok: false,
      code: 'FORBIDDEN',
    })
    // 還沒改臨時密碼的老師要先改密碼。
    expect(await setup.view(actorOf(userId, ['teacher'], { mustChangePassword: true }))).toMatchObject({ ok: false, code: 'PASSWORD_CHANGE_REQUIRED' })
  })

  it('沒有老師角色的人不需要補資料', async () => {
    expect(await setup.needsSetup(adminId)).toBe(false)
  })
})

describe('核發臨時密碼（ACC-08、ACC-18）', () => {
  it('替學生核發：舊密碼失效、舊登入撤掉、強制改密、稽核有核實方式；秘密不在 DB；重播拿不到秘密', async () => {
    const email = uniqueEmail('s07')
    const student = await signUp(email)
    expect(await sessionUser(student.cookie)).toBe(student.userId)

    const rid = requestId()
    const input = { userId: student.userId, verificationMethod: 'id_document', verificationNote: '9/24 系辦櫃台核對學生證', reason: '忘記密碼', requestId: rid }
    const issued = remember(await command.issueTemporaryPassword(admin(), adminHeaders, input))
    expect(issued).toMatchObject({ ok: true, expiresAt: null, receipt: { kind: 'temp_password', requestId: rid, issuedBy: adminId } })
    const secret = (issued as { secret: string }).secret

    expect(await sessionUser(student.cookie), '舊的登入要被撤掉').toBeNull()
    expect((await signIn(email, PASSWORD)).status, '舊密碼要失效').toBeGreaterThanOrEqual(400)
    const withTemp = await signIn(email, secret)
    expect(withTemp.status).toBe(200)
    expect(await one('select must_change_password from users where id = $1', [student.userId])).toEqual({ must_change_password: true })

    expect(
      await one(
        `select actor_user_id, verification_method, reason, payload from audit_events where action = 'account.issue_temporary_password' and target_id = $1`,
        [student.userId],
      ),
    ).toEqual({ actor_user_id: adminId, verification_method: 'id_document', reason: '忘記密碼', payload: { verificationNote: '9/24 系辦櫃台核對學生證' } })
    expect(await secretAppearsAnywhere(secret)).toEqual([])

    const replay = await command.issueTemporaryPassword(admin(), adminHeaders, input)
    expect(replay).toMatchObject({ ok: true, receipt: { userId: student.userId, verificationMethod: 'id_document' } })
    expect(JSON.stringify(replay)).not.toContain(secret)
    // 重播沒有再改一次密碼：剛剛那組還能用。
    expect((await signIn(email, secret)).status).toBe(200)

    // 同一個請求編號換內容：REQUEST_MISMATCH。
    expect(await command.issueTemporaryPassword(admin(), adminHeaders, { ...input, reason: '別的理由' })).toMatchObject({
      ok: false,
      code: 'REQUEST_MISMATCH',
    })
  })

  it('本人用臨時密碼登入後改密碼：must-change 清掉，臨時密碼從此不能用', async () => {
    const email = uniqueEmail('s08')
    const student = await signUp(email)
    const issued = remember(await command.issueTemporaryPassword(admin(), adminHeaders, {
      userId: student.userId,
      verificationMethod: 'id_document',
      verificationNote: '',
      reason: '',
      requestId: requestId(),
    }))
    const secret = (issued as { secret: string }).secret
    const cookie = cookieOf(await signIn(email, secret))
    const changed = await post('/change-password', { currentPassword: secret, newPassword: 'Brand-New-Password-2026' }, cookie)
    expect(changed.status).toBe(200)
    expect(await one('select must_change_password from users where id = $1', [student.userId])).toEqual({ must_change_password: false })
    expect((await signIn(email, secret)).status).toBeGreaterThanOrEqual(400)
    expect((await signIn(email, 'Brand-New-Password-2026')).status).toBe(200)
  })

  it('核實方式必選；不能替自己發；停用的帳號不能發——都不改任何東西', async () => {
    const email = uniqueEmail('s09')
    const student = await signUp(email)
    const base = { userId: student.userId, verificationMethod: 'id_document', verificationNote: '', reason: '' }

    expect(await command.issueTemporaryPassword(admin(), adminHeaders, { ...base, verificationMethod: '', requestId: requestId() })).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
      details: { field: 'verificationMethod' },
    })
    expect(await command.issueTemporaryPassword(admin(), adminHeaders, { ...base, userId: adminId, requestId: requestId() })).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
    })
    await db.sql(`update users set status = 'disabled' where id = $1`, [student.userId])
    expect(await command.issueTemporaryPassword(admin(), adminHeaders, { ...base, requestId: requestId() })).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
    })
    await db.sql(`update users set status = 'pending' where id = $1`, [student.userId])

    expect(await one('select must_change_password from users where id = $1', [student.userId])).toEqual({ must_change_password: false })
    expect(await one(`select count(*)::int as n from audit_events where action = 'account.issue_temporary_password' and target_id = $1`, [student.userId])).toEqual({ n: 0 })
    expect((await signIn(email, PASSWORD)).status, '原本的密碼沒被動到').toBe(200)

    expect(
      await command.issueTemporaryPassword(actorOf(adminId, ['teacher']), adminHeaders, { ...base, requestId: requestId() }),
    ).toMatchObject({ ok: false, code: 'FORBIDDEN' })
  })

  it('套件設密碼失敗：回錯、補一筆失敗稽核、帳本標 failed；同一個請求重送不回「已核發」；舊密碼仍然有效（票 10b）', async () => {
    const email = uniqueEmail('s10')
    const student = await signUp(email)
    const failing = makeCommand({
      createUser: async () => {
        throw new Error('not used')
      },
      setUserPassword: async () => {
        throw new Error('boom')
      },
      revokeUserSessions: async () => undefined,
    })
    const input = {
      userId: student.userId,
      verificationMethod: 'id_document',
      verificationNote: '',
      reason: '',
      requestId: requestId(),
    }
    const result = await failing.issueTemporaryPassword(admin(), adminHeaders, input)
    expect(result).toMatchObject({ ok: false, code: 'INTERNAL' })
    expect(await one(`select count(*)::int as n from audit_events where action = 'account.issue_temporary_password_failed' and target_id = $1`, [student.userId])).toEqual({ n: 1 })
    expect(
      await one(`select state from operation_records where operation_kind = 'account.issue_temporary_password' and request_id = $1`, [input.requestId]),
    ).toEqual({ state: 'failed' })
    expect((await signIn(email, PASSWORD)).status).toBe(200)

    // 回應在路上掉了、對話框用同一個請求編號重送：不能拿到「已核發」的回執（那組密碼根本沒生效）。
    // 用正常的指令重送也一樣——帳本說 failed 就是 failed，不會偷偷再設一次。
    for (const again of [failing, command]) {
      const replay = await again.issueTemporaryPassword(admin(), adminHeaders, input)
      expect(replay).toMatchObject({ ok: false, code: 'INTERNAL', message: expect.stringContaining('重新核發') })
      expect(replay).not.toHaveProperty('receipt')
    }
    expect((await signIn(email, PASSWORD)).status, '重播沒有偷偷設密碼').toBe(200)

    // 換一個新的請求編號重新核發：成功、拿得到秘密。
    const retry = remember(await command.issueTemporaryPassword(admin(), adminHeaders, { ...input, requestId: requestId() }))
    expect(retry).toMatchObject({ ok: true, secret: expect.any(String) })
  })

  it('用 Email 查帳號：只有管理員；查得到角色與狀態，查不到回欄位錯誤', async () => {
    const email = uniqueEmail('lookup')
    const student = await signUp(email)
    expect(await command.lookupByEmail(admin(), `  ${email.toUpperCase()} `)).toMatchObject({
      ok: true,
      receipt: { userId: student.userId, email, roles: [], status: 'pending' },
    })
    expect(await command.lookupByEmail(admin(), uniqueEmail('nobody'))).toMatchObject({ ok: false, details: { field: 'email' } })
    expect(await command.lookupByEmail(actorOf(student.userId, ['student']), email)).toMatchObject({ ok: false, code: 'FORBIDDEN' })
  })
})

describe('秘密不進 log（契約 03 §3）', () => {
  it('這個檔核發過的每一組臨時密碼，都沒有出現在任何 console 輸出裡', () => {
    expect(issuedSecrets.length).toBeGreaterThanOrEqual(4)
    expect(logged.length, '應該真的攔到 log（套件的警告、失敗時的錯誤）').toBeGreaterThan(0)
    for (const secret of issuedSecrets) {
      expect(logged.filter((line) => line.includes(secret))).toEqual([])
    }
  })
})
