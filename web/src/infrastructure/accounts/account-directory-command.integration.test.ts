import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_DIRECTORY_FILTER, type AccountDirectoryCommand, type DirectoryFilter, type ResolvedActor } from '@/application/accounts'
import {
  assertTestDatabaseReachable,
  createIsolatedDatabase,
  poolAsRole,
  TEST_DATABASE_URL,
  type IsolatedDatabase,
} from '../../../test/db'
import { migratedSchema } from '../../../test/migrations'

/**
 * 票 9：帳號列表、停用／恢復、批次停用與匯出（ACC-09、ACC-14 的還原、ACC-15）。
 *
 * 真的 Better Auth（建帳號、登入、banUser／unbanUser 經內部包裝器）＋真的 PostgreSQL（隔離 schema）。
 * **全程以 `fju_app` 連線**——用例若偷偷需要更多權限，這裡會直接紅。
 */

const BASE_URL = 'http://127.0.0.1:3000'
const PASSWORD = 'Correct-Horse-Battery-9'

let db: IsolatedDatabase
let app: Pool
let command: AccountDirectoryCommand
let handlers: typeof import('@/infrastructure/auth/wrapper').authRouteHandlers
let resolver: import('@/application/accounts').ActorResolver
let resetSignUpLimiter: () => void
let resetSignInLimiter: () => void
let makeCommand: (call?: import('@/infrastructure/accounts/session-revocation').RevocationCall) => AccountDirectoryCommand

let cohort114: string
let cohort115: string
let admin: { userId: string; headers: Headers }
let teacherId: string

let seq = 0
const requestId = () => `99999999-9999-4999-8999-${String(++seq).padStart(12, '0')}`
const uniqueEmail = (tag: string) => `t09-${tag}-${Date.now()}-${++seq}@example.com`

function adminActor(): ResolvedActor {
  return { kind: 'authenticated', userId: admin.userId, roles: ['admin'], status: 'active', mustChangePassword: false, cohortMemberships: [] }
}
function teacherActor(): ResolvedActor {
  return { kind: 'authenticated', userId: teacherId, roles: ['teacher'], status: 'active', mustChangePassword: false, cohortMemberships: [] }
}
const filter = (patch: Partial<DirectoryFilter>): DirectoryFilter => ({ ...DEFAULT_DIRECTORY_FILTER, ...patch })

async function one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
  return (await db.sql(sql, params)).rows[0] as T
}

let ipSeq = 0
async function signUp(email: string, name: string): Promise<{ userId: string; cookie: string }> {
  const response = await handlers.POST(
    new Request(`${BASE_URL}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE_URL, 'x-real-ip': `203.0.113.${++ipSeq}` },
      body: JSON.stringify({ email, password: PASSWORD, name }),
    }),
  )
  expect(response.status).toBe(200)
  const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0]!
  const row = await one<{ id: string }>('select id from users where email = $1', [email])
  return { userId: row.id, cookie }
}

async function signIn(email: string): Promise<number> {
  const response = await handlers.POST(
    new Request(`${BASE_URL}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE_URL, 'x-real-ip': `203.0.113.${++ipSeq}` },
      body: JSON.stringify({ email, password: PASSWORD }),
    }),
  )
  return response.status
}

/** 一個已核准的學生（有 profile、學生角色、占用學號）＋一個真的登入 session。 */
async function student(studentNo: string, name: string, cohortId = cohort114, dept: string | null = '資管二甲') {
  const email = uniqueEmail('s')
  const { userId, cookie } = await signUp(email, name)
  await db.sql(`update users set status = 'active', name = $2 where id = $1`, [userId, name])
  await db.sql(
    `insert into user_profiles (user_id, display_name, name_normalized, student_no, department_class, cohort_id, phone, contact_email)
     values ($1, $2, lower($2), $3, $4, $5, '0912-000-000', $6)`,
    [userId, name, studentNo, dept, cohortId, email],
  )
  await db.sql(
    `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at) values (gen_random_uuid(), $1, 'student', $2, now())`,
    [userId, admin.userId],
  )
  await db.sql(`insert into student_identities (cohort_id, student_no, user_id) values ($1, upper($2), $3)`, [cohortId, studentNo, userId])
  return { userId, cookie, email }
}

beforeAll(async () => {
  await assertTestDatabaseReachable()
  db = await createIsolatedDatabase({ label: 't09-accounts', setup: migratedSchema })
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
  resolver = new (await import('@/infrastructure/auth/actor-resolver')).DbActorResolver()
  const { PgAccountDirectoryCommand } = await import('@/infrastructure/accounts/account-directory-command')
  const { SessionRevocationExecutor } = await import('@/infrastructure/accounts/session-revocation')
  const { PgAuditWriter } = await import('@/infrastructure/ops/audit-writer')
  const { PgOperationLedger } = await import('@/infrastructure/ops/operation-ledger')
  makeCommand = (call) =>
    new PgAccountDirectoryCommand({
      audit: new PgAuditWriter(),
      ledger: new PgOperationLedger(() => app),
      db: () => app,
      ...(call ? { revocations: new SessionRevocationExecutor({ db: () => app, call }) } : {}),
    })
  command = makeCommand()

  const cohort = async (code: string) =>
    String(
      (
        await db.sql(
          `insert into cohorts (id, code, name, created_by_kind) values (gen_random_uuid(), $1, $2, 'system') returning id`,
          [code, `${code} 學年度專題`],
        )
      ).rows[0]!.id,
    )
  cohort114 = await cohort('114')
  cohort115 = await cohort('115')

  // 管理員：Better Auth admin plugin 的 `users.role='admin'`（內部包裝呼叫 banUser 要看到它）＋業務角色。
  const a = await signUp('a1-t09@example.com', '系辦 A1')
  await db.sql(`update users set status = 'active', role = 'admin' where id = $1`, [a.userId])
  await db.sql(
    `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at) values (gen_random_uuid(), $1, 'admin', $1, now())`,
    [a.userId],
  )
  admin = { userId: a.userId, headers: new Headers({ cookie: a.cookie }) }

  const t = await signUp('t1-t09@example.com', '老師 T1')
  teacherId = t.userId
  await db.sql(`update users set status = 'active' where id = $1`, [teacherId])
  await db.sql(
    `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at) values (gen_random_uuid(), $1, 'teacher', $2, now())`,
    [teacherId, admin.userId],
  )
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

describe('列表與統計（做完的樣子 1）', () => {
  it('待審的人從註冊申請讀資料；核准的人從個人資料讀；搜尋、篩選、排序都在伺服器', async () => {
    const approved = await student('0411400101', '列表甲')
    // 待審：還沒有 user_profiles，只有註冊申請。
    const pendingEmail = uniqueEmail('p')
    const pending = await signUp(pendingEmail, '列表乙（登入名）')
    await db.sql(
      `insert into registration_applications
         (id, user_id, applied_name, student_no, department_class, phone, contact_email, login_email, created_by_kind, created_by_user_id)
       values (gen_random_uuid(), $1, '列表乙', '0411400102', '資管二乙', '0922-222-222', 'yi@example.com', $2, 'user', $1)`,
      [pending.userId, pendingEmail],
    )

    const all = await command.list(adminActor(), filter({ q: '列表' }))
    expect(all.ok).toBe(true)
    if (!all.ok) return
    expect(all.receipt.total).toBe(2)
    const byId = new Map(all.receipt.rows.map((r) => [r.userId, r]))
    expect(byId.get(pending.userId)).toMatchObject({
      name: '列表乙', studentNo: '0411400102', departmentClass: '資管二乙', phone: '0922-222-222',
      contactEmail: 'yi@example.com', status: 'pending', applicationState: 'pending', roles: [], cohortCode: null,
    })
    expect(byId.get(approved.userId)).toMatchObject({ name: '列表甲', studentNo: '0411400101', status: 'active', roles: ['student'], cohortCode: '114' })

    // 搜尋學號、Email（聯絡 Email 也算）；搜尋字裡的 % 不當萬用字元。
    expect(await command.list(adminActor(), filter({ q: '0411400102' }))).toMatchObject({ receipt: { total: 1 } })
    expect(await command.list(adminActor(), filter({ q: 'yi@example' }))).toMatchObject({ receipt: { total: 1 } })
    expect(await command.list(adminActor(), filter({ q: '列%' }))).toMatchObject({ receipt: { total: 0 } })

    // 篩選：狀態、角色、屆別。
    expect(await command.list(adminActor(), filter({ q: '列表', status: 'pending' }))).toMatchObject({ receipt: { total: 1 } })
    expect(await command.list(adminActor(), filter({ q: '列表', role: 'student' }))).toMatchObject({ receipt: { total: 1 } })
    expect(await command.list(adminActor(), filter({ q: '列表', cohortId: cohort115 }))).toMatchObject({ receipt: { total: 0 } })

    // 排序：學號升冪、降冪。
    const asc = await command.list(adminActor(), filter({ q: '列表', sort: 'studentNo', dir: 'asc' }))
    const desc = await command.list(adminActor(), filter({ q: '列表', sort: 'studentNo', dir: 'desc' }))
    expect(asc.ok && asc.receipt.rows.map((r) => r.studentNo)).toEqual(['0411400101', '0411400102'])
    expect(desc.ok && desc.receipt.rows.map((r) => r.studentNo)).toEqual(['0411400102', '0411400101'])
  })

  it('統計磚：待審核、已核准、已停用、已核准學生', async () => {
    const summary = await command.summary(adminActor())
    expect(summary.ok).toBe(true)
    if (!summary.ok) return
    const counted = await one<{ pending: number; active: number; disabled: number }>(
      `select count(*) filter (where status = 'pending')::int as pending,
              count(*) filter (where status = 'active')::int as active,
              count(*) filter (where status = 'disabled')::int as disabled from users`,
    )
    expect(summary.receipt).toMatchObject(counted)
    expect(summary.receipt.pendingApplications).toBeGreaterThanOrEqual(1)
    expect(summary.receipt.activeStudents).toBeLessThan(summary.receipt.active)
  })

  it('只有管理員：老師 FORBIDDEN、未登入 UNAUTHENTICATED', async () => {
    expect(await command.list(teacherActor(), DEFAULT_DIRECTORY_FILTER)).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(await command.summary({ kind: 'anonymous' })).toMatchObject({ ok: false, code: 'UNAUTHENTICATED' })
    expect(await command.exportCsv(teacherActor(), { kind: 'filter', filter: DEFAULT_DIRECTORY_FILTER })).toMatchObject({ ok: false, code: 'FORBIDDEN' })
  })
})

describe('停用即失效、恢復可再登入（做完的樣子 2；ACC-09）', () => {
  it('停用：狀態、事件、釋出學號、撤 session、稽核一次寫齊；舊 session 下一個動作就是未登入', async () => {
    const s = await student('0411400201', '停用甲')
    const before = await resolver.resolve(new Headers({ cookie: s.cookie }))
    expect(before.kind).toBe('authenticated')

    const rid = requestId()
    const input = { userId: s.userId, reason: '休學', requestId: rid }
    const result = await command.disable(adminActor(), input, { headers: admin.headers })
    expect(result).toMatchObject({ ok: true, receipt: { status: 'disabled', name: '停用甲', revocation: 'done' } })

    expect(await one('select status, banned from users where id = $1', [s.userId])).toEqual({ status: 'disabled', banned: true })
    expect(await one('select from_status, to_status, reason, actor_user_id from user_status_events where user_id = $1', [s.userId])).toEqual({
      from_status: 'active', to_status: 'disabled', reason: '休學', actor_user_id: admin.userId,
    })
    expect(await one('select count(*)::int as n from student_identities where user_id = $1', [s.userId])).toEqual({ n: 0 })
    expect(await one(`select trigger, kind, state, expected_user_status from session_revocations where user_id = $1`, [s.userId])).toEqual({
      trigger: 'status_event', kind: 'ban', state: 'done', expected_user_status: 'disabled',
    })
    expect(await one('select count(*)::int as n from sessions where user_id = $1', [s.userId])).toEqual({ n: 0 })
    expect(await one(`select reason, actor_user_id, cohort_id from audit_events where action = 'account.disable' and target_id = $1`, [s.userId])).toEqual({
      reason: '休學', actor_user_id: admin.userId, cohort_id: cohort114,
    })
    // 角色不動（停用不是刪除）。
    expect(await one(`select count(*)::int as n from role_assignments where user_id = $1 and revoked_real_at is null`, [s.userId])).toEqual({ n: 1 })

    // 舊分頁的 cookie：下一個動作就是未登入；也不能再登入。
    expect(await resolver.resolve(new Headers({ cookie: s.cookie }))).toEqual({ kind: 'anonymous' })
    expect(await signIn(s.email)).not.toBe(200)

    // 同一個請求編號重送：回同一份回執，不重做；已停用再停用 CONFLICT；停用自己 FORBIDDEN。
    expect(await command.disable(adminActor(), input, { headers: admin.headers })).toMatchObject({ ok: true, receipt: { status: 'disabled' } })
    expect(await one('select count(*)::int as n from user_status_events where user_id = $1', [s.userId])).toEqual({ n: 1 })
    expect(await command.disable(adminActor(), { ...input, requestId: requestId() }, { headers: admin.headers })).toMatchObject({ ok: false, code: 'CONFLICT' })
    expect(await command.disable(adminActor(), { userId: admin.userId, reason: 'x', requestId: requestId() }, { headers: admin.headers })).toMatchObject({
      ok: false, code: 'FORBIDDEN',
    })
    expect(await command.disable(adminActor(), { ...input, reason: '  ', requestId: requestId() }, { headers: admin.headers })).toMatchObject({
      ok: false, code: 'VALIDATION_FAILED',
    })
    expect(await command.disable(teacherActor(), { ...input, requestId: requestId() }, { headers: admin.headers })).toMatchObject({ ok: false, code: 'FORBIDDEN' })

    // 恢復：狀態回來、學號重新占用（存大寫）、Better Auth 解除封鎖、可以再登入。
    const restored = await command.restore(adminActor(), { userId: s.userId, reason: '復學', requestId: requestId() }, { headers: admin.headers })
    expect(restored).toMatchObject({ ok: true, receipt: { status: 'active', revocation: 'done' } })
    expect(await one('select status, banned from users where id = $1', [s.userId])).toEqual({ status: 'active', banned: false })
    expect(await one('select cohort_id, student_no from student_identities where user_id = $1', [s.userId])).toEqual({ cohort_id: cohort114, student_no: '0411400201' })
    expect(await one(`select count(*)::int as n from audit_events where action = 'account.restore' and target_id = $1`, [s.userId])).toEqual({ n: 1 })
    expect(await signIn(s.email)).toBe(200)
  })

  it('待審的帳號不用停用處理（請退回）', async () => {
    const p = await signUp(uniqueEmail('p2'), '待審丙')
    expect(await command.disable(adminActor(), { userId: p.userId, reason: 'x', requestId: requestId() }, { headers: admin.headers })).toMatchObject({
      ok: false, code: 'CONFLICT',
    })
  })

  it('恢復時學號已被同屆另一個有效帳號占用（包括正規化以前的小寫舊列）→ STUDENT_NO_TAKEN，整筆回滾', async () => {
    const first = await student('ab411400301', '恢復甲')
    expect(await command.disable(adminActor(), { userId: first.userId, reason: '重複註冊', requestId: requestId() }, { headers: admin.headers })).toMatchObject({ ok: true })
    // 停用期間，同一個學號被別人核准，而且是以前沒正規化的小寫舊列。
    const second = await student('AB411400301', '恢復乙')
    await db.sql(`update student_identities set student_no = 'ab411400301' where user_id = $1`, [second.userId])

    const restored = await command.restore(adminActor(), { userId: first.userId, reason: '復學', requestId: requestId() }, { headers: admin.headers })
    expect(restored).toMatchObject({ ok: false, code: 'STUDENT_NO_TAKEN' })
    expect(await one('select status from users where id = $1', [first.userId])).toEqual({ status: 'disabled' })
    expect(await one(`select count(*)::int as n from user_status_events where user_id = $1`, [first.userId])).toEqual({ n: 1 })
  })

  it('Better Auth 那一層失敗：停用照樣生效，工作列記 failed 留給收斂', async () => {
    const failing = makeCommand(async () => {
      throw Object.assign(new Error('boom'), { status: 'UNAUTHORIZED' })
    })
    const s = await student('0411400401', '失敗甲')
    const result = await failing.disable(adminActor(), { userId: s.userId, reason: '休學', requestId: requestId() }, { headers: admin.headers })
    expect(result).toMatchObject({ ok: true, receipt: { status: 'disabled', revocation: 'failed' } })
    expect(await one('select status from users where id = $1', [s.userId])).toEqual({ status: 'disabled' })
    expect(await one(`select state, last_error, outcome_unknown from session_revocations where user_id = $1`, [s.userId])).toEqual({
      state: 'failed', last_error: 'UNAUTHORIZED', outcome_unknown: false,
    })
    // 入口層只看 users.status：session 還在，但已經是未登入。
    expect(await resolver.resolve(new Headers({ cookie: s.cookie }))).toEqual({ kind: 'anonymous' })
  })

  it('新的狀態事件把還在排隊的舊工作取消（附錄 A 規則 1）', async () => {
    let calls = 0
    // 第一次呼叫前什麼都不做：模擬「排了工作但還沒執行」。
    const never = makeCommand(async () => {
      calls += 1
    })
    const s = await student('0411400501', '排隊甲')
    await db.sql(`update users set status = 'disabled' where id = $1`, [s.userId])
    const ev = await one<{ id: string }>(
      `insert into user_status_events (id, user_id, from_status, to_status, actor_kind, actor_user_id, real_at)
       values (gen_random_uuid(), $1, 'active', 'disabled', 'user', $2, now() - interval '1 minute') returning id`,
      [s.userId, admin.userId],
    )
    await db.sql(
      `insert into session_revocations (id, user_id, status_event_id, kind, expected_user_status, requested_real_at)
       values (gen_random_uuid(), $1, $2, 'ban', 'disabled', now() - interval '1 minute')`,
      [s.userId, ev.id],
    )
    expect(await never.restore(adminActor(), { userId: s.userId, reason: '誤停', requestId: requestId() }, { headers: admin.headers })).toMatchObject({ ok: true })
    const rows = (await db.sql(`select kind, state, cancel_reason from session_revocations where user_id = $1 order by requested_real_at`, [s.userId])).rows
    expect(rows).toEqual([
      { kind: 'ban', state: 'cancelled', cancel_reason: 'superseded_by_event' },
      { kind: 'unban', state: 'done', cancel_reason: null },
    ])
    expect(calls).toBe(1)
  })
})

describe('批次停用（做完的樣子 4）', () => {
  it('預覽分成將停用／已停用／找不到／重複；確認後只停用預覽裡的人；名單變了就 CONFLICT', async () => {
    const a = await student('0411400601', '批次甲', cohort115)
    const b = await student('0411400602', '批次乙', cohort115)
    const c = await student('0411400603', '批次丙', cohort115)
    await command.disable(adminActor(), { userId: c.userId, reason: '先停', requestId: requestId() }, { headers: admin.headers })
    const text = '0411400601\n\n0411400602\n0411400603\n0411499999\n0411400601\n'

    const preview = await command.previewBulkDisable(adminActor(), text)
    expect(preview.ok).toBe(true)
    if (!preview.ok) return
    expect(preview.receipt.hits.map((h) => h.userId).sort()).toEqual([a.userId, b.userId].sort())
    expect(preview.receipt.alreadyDisabled.map((h) => h.userId)).toEqual([c.userId])
    expect(preview.receipt.notFound.map((n) => n.studentNo)).toEqual(['0411499999'])
    expect(preview.receipt.duplicates.map((d) => d.line)).toEqual([6])

    // 格式不對整份退件；老師不能預覽。
    expect(await command.previewBulkDisable(adminActor(), '0411400601,王小明')).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    expect(await command.previewBulkDisable(teacherActor(), text)).toMatchObject({ ok: false, code: 'FORBIDDEN' })

    // 預覽之後有人先被單獨停用了：確認時名單不同 → CONFLICT，一個都不動。
    await command.disable(adminActor(), { userId: b.userId, reason: '單獨停', requestId: requestId() }, { headers: admin.headers })
    const stale = await command.bulkDisable(
      adminActor(),
      { text, expectedUserIds: preview.receipt.hits.map((h) => h.userId), reason: '畢業', requestId: requestId() },
      { headers: admin.headers },
    )
    expect(stale).toMatchObject({ ok: false, code: 'CONFLICT' })
    expect(await one('select status from users where id = $1', [a.userId])).toEqual({ status: 'active' })

    // 重新預覽 → 確認。
    const again = await command.previewBulkDisable(adminActor(), text)
    if (!again.ok) throw new Error(again.message)
    expect(again.receipt.hits.map((h) => h.userId)).toEqual([a.userId])
    const done = await command.bulkDisable(
      adminActor(),
      { text, expectedUserIds: [a.userId], reason: '畢業', requestId: requestId() },
      { headers: admin.headers },
    )
    expect(done).toMatchObject({ ok: true, receipt: { disabled: 1, names: ['批次甲'], revocationFailed: 0 } })
    expect(await one('select status, banned from users where id = $1', [a.userId])).toEqual({ status: 'disabled', banned: true })
    expect(await one(`select count(*)::int as n from audit_events where action = 'account.disable' and target_id = $1`, [a.userId])).toEqual({ n: 1 })
    expect(await one(`select reason, payload->>'disabled' as disabled from audit_events where action = 'account.bulk_disable'`)).toEqual({
      reason: '畢業', disabled: '1',
    })
    // 沒有任何東西被刪掉：帳號、學生資料都還在。
    expect(await one('select count(*)::int as n from user_profiles where user_id = $1', [a.userId])).toEqual({ n: 1 })
  })
})

describe('匯出 CSV（做完的樣子 3；ACC-15）', () => {
  it('勾選的人：欄位固定、學號保留前導零、系級與待審者也匯得出來，寫匯出稽核', async () => {
    const s = await student('0411400701', '匯出甲', cohort114, '資管二甲')
    const pending = await signUp(uniqueEmail('px'), '匯出乙登入名')
    await db.sql(
      `insert into registration_applications
         (id, user_id, applied_name, student_no, department_class, phone, contact_email, login_email, created_by_kind, created_by_user_id)
       values (gen_random_uuid(), $1, '=匯出乙', '0411400702', '資管二乙', '0933-333-333', 'px@example.com', 'px-login@example.com', 'user', $1)`,
      [pending.userId],
    )
    const result = await command.exportCsv(adminActor(), { kind: 'ids', userIds: [s.userId, pending.userId] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.receipt.count).toBe(2)
    const csv = result.receipt.csv
    expect(csv.charCodeAt(0)).toBe(0xfeff)
    const lines = csv.slice(1).trimEnd().split('\r\n')
    expect(lines[0]).toBe('"姓名","學號","系級","屆別","手機","登入 Email","聯絡 Email","角色","狀態"')
    expect(lines[1]).toMatch(/^"匯出甲","0411400701","資管二甲","114","0912-000-000",/)
    expect(lines[2]).toMatch(/^"'=匯出乙","0411400702","資管二乙","","0933-333-333",/)
    expect(lines[2]).toMatch(/"待審核"$/)
    expect(lines).toHaveLength(3)

    const audit = await one<{ actor_user_id: string; payload: Record<string, unknown> }>(
      `select actor_user_id, payload from audit_events where action = 'account.export' order by real_at desc limit 1`,
    )
    expect(audit).toEqual({ actor_user_id: admin.userId, payload: { kind: 'ids', requested: 2, count: 2 } })
  })

  it('全部篩選結果：不限分頁，筆數等於列表總數；不混入別的屆', async () => {
    for (let i = 0; i < 3; i += 1) await student(`0411500${800 + i}`, `全選${i}`, cohort115)
    const f = filter({ cohortId: cohort115, q: '全選' })
    const listed = await command.list(adminActor(), f)
    const exported = await command.exportCsv(adminActor(), { kind: 'filter', filter: f })
    expect(listed.ok && exported.ok).toBe(true)
    if (!listed.ok || !exported.ok) return
    expect(exported.receipt.count).toBe(listed.receipt.total)
    expect(exported.receipt.csv).not.toContain('"114"')
  })
})
