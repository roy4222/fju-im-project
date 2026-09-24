import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RegistrationCommand, ResolvedActor } from '@/application/accounts'
import {
  assertTestDatabaseReachable,
  createIsolatedDatabase,
  poolAsRole,
  TEST_DATABASE_URL,
  type IsolatedDatabase,
} from '../../../test/db'
import { migratedSchema } from '../../../test/migrations'

/**
 * 票 7：學生註冊與審核（ACC-02、03、04、05；工程模組 01 §3、§6、§8）。
 *
 * 真的 Better Auth（建帳號、限速 hook）＋真的 PostgreSQL（隔離 schema）。
 * **全程以 `fju_app` 連線**——Better Auth 也是——用例若偷偷需要更多權限，這裡會直接紅。
 */

const BASE_URL = 'http://127.0.0.1:3000'
const PASSWORD = 'Correct-Horse-Battery-9'

let db: IsolatedDatabase
let app: Pool
let command: RegistrationCommand
let handlers: typeof import('@/infrastructure/auth/wrapper').authRouteHandlers
let resetSignUpLimiter: () => void
let adminId: string
let studentAdminLike: string
let cohort115: string
let cohort114: string

const ANON: ResolvedActor = { kind: 'anonymous' }

function pendingActor(userId: string): ResolvedActor {
  return { kind: 'authenticated', userId, roles: [], status: 'pending', mustChangePassword: false, cohortMemberships: [] }
}
function activeActor(userId: string, roles: ('admin' | 'student')[]): ResolvedActor {
  return { kind: 'authenticated', userId, roles, status: 'active', mustChangePassword: false, cohortMemberships: [] }
}

let seq = 0
const uniqueEmail = (tag: string) => `t07-${tag}-${Date.now()}-${++seq}@example.com`
const requestId = () => `77777777-7777-4777-8777-${String(++seq).padStart(12, '0')}`
let ipSeq = 0
const freshIp = () => `198.51.100.${++ipSeq}`

async function register(patch: Partial<Parameters<RegistrationCommand['apply']>[1]> = {}, ip = freshIp()) {
  const result = await command.apply(
    ANON,
    {
      appliedName: '王小明',
      studentNo: '411500001',
      departmentClass: '資管二甲',
      phone: '0912-345-678',
      loginEmail: uniqueEmail('s'),
      password: PASSWORD,
      passwordConfirm: PASSWORD,
      ...patch,
    },
    ip,
  )
  if (!result.ok) throw new Error(`註冊失敗：${result.code} ${result.message}`)
  return result.receipt.userId
}

async function one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
  return (await db.sql(sql, params)).rows[0] as T
}

beforeAll(async () => {
  await assertTestDatabaseReachable()
  db = await createIsolatedDatabase({ label: 't07-registration', setup: migratedSchema })
  app = await poolAsRole(db, 'fju_app')

  // Better Auth 也用 fju_app 連同一個隔離 schema。
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
  const { PgRegistrationCommand } = await import('@/infrastructure/accounts/registration-command')
  const { PgAuditWriter } = await import('@/infrastructure/ops/audit-writer')
  const { PgOperationLedger } = await import('@/infrastructure/ops/operation-ledger')
  const { PgCohortStatusQuery } = await import('@/infrastructure/cohorts/pg-cohorts')
  command = new PgRegistrationCommand({
    audit: new PgAuditWriter(),
    ledger: new PgOperationLedger(() => app),
    db: () => app,
    cohorts: new PgCohortStatusQuery(() => app),
  })

  const user = async (email: string, name: string) =>
    String(
      (
        await db.sql(
          `insert into users (id, name, email, email_verified, updated_at, status)
           values (gen_random_uuid(), $2, $1, false, now(), 'active') returning id`,
          [email, name],
        )
      ).rows[0]!.id,
    )
  adminId = await user('a1-t07@example.com', '系辦 A1')
  studentAdminLike = await user('s-active-t07@example.com', '已核准學生')

  const cohort = async (code: string, open: boolean) =>
    String(
      (
        await db.sql(
          `insert into cohorts (id, code, name, created_by_kind, is_registration_open)
           values (gen_random_uuid(), $1, $2, 'system', $3) returning id`,
          [code, `${code} 學年度專題`, open],
        )
      ).rows[0]!.id,
    )
  cohort115 = await cohort('115', true)
  cohort114 = await cohort('114', false)

  // 115 屆名單：S01 有 Email、S05 名單 Email 與註冊不同、S09 名單沒填 Email。
  const version = String(
    (
      await db.sql(
        `insert into roster_versions (id, cohort_id, imported_by_user_id, imported_real_at, summary)
         values (gen_random_uuid(), $1, $2, now(), '{}'::jsonb) returning id`,
        [cohort115, adminId],
      )
    ).rows[0]!.id,
  )
  for (const [no, name, email, dept] of [
    ['411500001', '王小明', 's01-roster@example.com', '資管二甲'],
    ['411500003', '陳大文', 's03@example.com', '資管二甲'],
    ['411500005', '林小華', 's05-roster@example.com', '資管二乙'],
    ['411500009', 'John Smith', null, null],
  ] as const) {
    await db.sql(
      `insert into roster_entries (id, roster_version_id, student_no, name_raw, name_normalized, department_class, email)
       values (gen_random_uuid(), $1, $2, $3, lower($3), $4, $5)`,
      [version, no, name, dept, email],
    )
  }
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await app?.end()
  await db?.close()
})

beforeEach(() => resetSignUpLimiter())

describe('註冊（ACC-02 前半）', () => {
  it('送出 → 帳號 pending、申請第 1 版、快照、比對結果、稽核都在；沒有任何自動核准', async () => {
    const email = uniqueEmail('s01')
    const userId = await register({ loginEmail: email, studentNo: '411500001', appliedName: '王小明' })

    expect(await one(`select status from users where id = $1`, [userId])).toEqual({ status: 'pending' })
    const application = await one<{
      id: string
      revision: number
      state: string
      login_email: string
      contact_email: string
      department_class: string
      roster_match: { status: string; emailComparison: string }
      created_by_kind: string
    }>(`select * from registration_applications where user_id = $1`, [userId])
    expect(application).toMatchObject({
      revision: 1,
      state: 'pending',
      login_email: email,
      contact_email: email,
      department_class: '資管二甲',
      created_by_kind: 'user',
    })
    // 名單符合、Email 不同（名單上是 s01-roster@）——只標記，照樣待審。
    expect(application.roster_match).toMatchObject({ status: 'matched', emailComparison: 'different' })
    expect(await one(`select count(*)::int as n from application_revisions where application_id = $1`, [application.id])).toEqual({ n: 1 })
    expect(await one(`select count(*)::int as n from audit_events where action = 'registration.apply' and target_id = $1`, [application.id])).toEqual({ n: 1 })
    // 沒有角色、沒有占用學號：還不是學生。
    expect(await one(`select count(*)::int as n from role_assignments where user_id = $1`, [userId])).toEqual({ n: 0 })
    expect(await one(`select count(*)::int as n from student_identities where user_id = $1`, [userId])).toEqual({ n: 0 })
  })

  it('Email 已被用過：統一訊息，不說是什麼狀態的帳號，也不多建申請', async () => {
    const email = uniqueEmail('dup')
    await register({ loginEmail: email })
    const before = await one<{ n: number }>(`select count(*)::int as n from registration_applications`)
    const again = await command.apply(
      ANON,
      { appliedName: '別人', studentNo: '411599999', departmentClass: '資管二甲', phone: '0911111111', loginEmail: email, password: PASSWORD, passwordConfirm: PASSWORD },
      freshIp(),
    )
    expect(again).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', message: '這個 Email 無法用來註冊。如果你已經有帳號，請直接登入。' })
    expect(await one(`select count(*)::int as n from registration_applications`)).toEqual(before)
  })

  it('欄位不合格在建帳號之前就擋：不建 users、不吃限速額度', async () => {
    const email = uniqueEmail('bad')
    const ip = freshIp()
    const result = await command.apply(
      ANON,
      { appliedName: '王小明', studentNo: '411500001', departmentClass: '資管二甲', phone: '0912345678', loginEmail: email, password: 'short', passwordConfirm: 'short' },
      ip,
    )
    expect(result).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', details: { field: 'password' } })
    expect(await one(`select count(*)::int as n from users where email = $1`, [email])).toEqual({ n: 0 })
  })

  it('已經登入的人不能再註冊一個', async () => {
    const result = await command.apply(activeActor(studentAdminLike, ['student']), {
      appliedName: 'x', studentNo: '1', departmentClass: 'x', phone: '0912345678', loginEmail: uniqueEmail('x'), password: PASSWORD, passwordConfirm: PASSWORD,
    }, freshIp())
    expect(result).toMatchObject({ ok: false, code: 'FORBIDDEN' })
  })

  it('直接打 HTTP 註冊也擋 12 字元以下的密碼（套件預設只要 8）', async () => {
    const response = await handlers.POST(
      new Request(`${BASE_URL}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: BASE_URL, 'x-real-ip': freshIp() },
        body: JSON.stringify({ email: uniqueEmail('http8'), password: 'Short-pw9', name: '短密碼' }),
      }),
    )
    expect(response.status).toBe(400)
  })
})

describe('限速：同一個 IP 一小時 30 次（契約 03 §6）', () => {
  it('表單與直接打 API 算同一個桶：30 次放行、第 31 次兩條路都擋；換一個 IP 不受影響', async () => {
    const ip = '203.0.113.77'
    for (let i = 0; i < 15; i += 1) await register({ studentNo: `41170${String(i).padStart(4, '0')}` }, ip)
    for (let i = 0; i < 15; i += 1) {
      const response = await handlers.POST(
        new Request(`${BASE_URL}/api/auth/sign-up/email`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: BASE_URL, 'x-real-ip': ip },
          body: JSON.stringify({ email: uniqueEmail('http'), password: PASSWORD, name: 'API 註冊' }),
        }),
      )
      expect(response.status).toBe(200)
    }

    const viaForm = await command.apply(
      ANON,
      { appliedName: '第 31 位', studentNo: '411799999', departmentClass: '資管二甲', phone: '0912345678', loginEmail: uniqueEmail('31'), password: PASSWORD, passwordConfirm: PASSWORD },
      ip,
    )
    expect(viaForm).toMatchObject({ ok: false, code: 'RATE_LIMITED' })
    const viaApi = await handlers.POST(
      new Request(`${BASE_URL}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: BASE_URL, 'x-real-ip': ip },
        body: JSON.stringify({ email: uniqueEmail('http31'), password: PASSWORD, name: 'API 第 31' }),
      }),
    )
    expect(viaApi.status).toBe(429)

    // 被擋的那兩次都沒有建帳號。
    expect(await one(`select count(*)::int as n from users where name in ('第 31 位', 'API 第 31')`)).toEqual({ n: 0 })
    // 另一個 IP（例如另一個網路的同學）照常可以註冊。
    await register({ studentNo: '411788888' }, '203.0.113.78')
  })

  it('偽造的 X-Forwarded-For 換不到新額度：有 X-Real-IP（Caddy 覆寫的那一個）就只看它', async () => {
    const ip = '203.0.113.90'
    for (let i = 0; i < 30; i += 1) {
      const response = await handlers.POST(
        new Request(`${BASE_URL}/api/auth/sign-up/email`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: BASE_URL,
            'x-real-ip': ip,
            'x-forwarded-for': `10.0.0.${i}`,
          },
          body: JSON.stringify({ email: uniqueEmail('xff'), password: PASSWORD, name: 'XFF' }),
        }),
      )
      expect(response.status).toBe(200)
    }
    const spoofed = await handlers.POST(
      new Request(`${BASE_URL}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: BASE_URL, 'x-real-ip': ip, 'x-forwarded-for': '10.9.9.9' },
        body: JSON.stringify({ email: uniqueEmail('xff31'), password: PASSWORD, name: 'XFF 31' }),
      }),
    )
    expect(spoofed.status).toBe(429)
  })
})

describe('本人：看與改自己的申請（§2.4 Q7）', () => {
  it('看得到自己的資料與版本；**看不到名單比對結果**（不洩漏某學號在不在名單上）', async () => {
    const userId = await register({ studentNo: '411500003', appliedName: '陳大文' })
    const mine = await command.viewMine(pendingActor(userId))
    expect(mine).toMatchObject({ ok: true, receipt: { state: 'pending', current: { studentNo: '411500003', revision: 1 } } })
    const json = JSON.stringify(mine)
    for (const leak of ['rosterMatch', 'matched', 'not_found', 'roster', 'hit']) expect(json).not.toContain(leak)
  })

  it('修改 → 第 2 版、留快照、重新比對、狀態仍是待審；拿舊版本再改回 CONFLICT', async () => {
    const userId = await register({ studentNo: '411500003', appliedName: '陳大文' })
    const actor = pendingActor(userId)
    const revised = await command.reviseMine(
      actor,
      { appliedName: '陳大文', studentNo: '411599998', departmentClass: '資管二甲', phone: '0922-000-111', contactEmail: 'chen@gmail.com' },
      1,
    )
    expect(revised).toMatchObject({ ok: true, receipt: { revision: 2 } })

    const row = await one<{ revision: number; state: string; student_no: string; contact_email: string; roster_match: { status: string } }>(
      `select revision, state, student_no, contact_email, roster_match from registration_applications where user_id = $1`,
      [userId],
    )
    expect(row).toMatchObject({ revision: 2, state: 'pending', student_no: '411599998', contact_email: 'chen@gmail.com' })
    // 重新比對：改了學號之後就不在名單上了。
    expect(row.roster_match.status).toBe('not_found')
    expect(await one(`select status from users where id = $1`, [userId])).toEqual({ status: 'pending' })
    const snapshots = await db.sql(
      `select ar.revision, ar.snapshot->>'studentNo' as student_no from application_revisions ar
         join registration_applications ra on ra.id = ar.application_id where ra.user_id = $1 order by ar.revision`,
      [userId],
    )
    expect(snapshots.rows).toEqual([
      { revision: 1, student_no: '411500003' },
      { revision: 2, student_no: '411599998' },
    ])

    const stale = await command.reviseMine(
      actor,
      { appliedName: '陳大文', studentNo: '411500003', departmentClass: '資管二甲', phone: '0922-000-111', contactEmail: 'chen@gmail.com' },
      1,
    )
    expect(stale).toMatchObject({ ok: false, code: 'CONFLICT' })
  })

  it('已開通的人不能用這條路改學號', async () => {
    const result = await command.reviseMine(
      activeActor(studentAdminLike, ['student']),
      { appliedName: 'x', studentNo: '1', departmentClass: 'x', phone: '0912345678', contactEmail: 'a@b.co' },
      1,
    )
    expect(result).toMatchObject({ ok: false, code: 'FORBIDDEN' })
  })

  it('沒有申請單的待審帳號（直接打 API 註冊的）：看到 none，補送一次就有第 1 版', async () => {
    const email = uniqueEmail('api-only')
    const response = await handlers.POST(
      new Request(`${BASE_URL}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: BASE_URL, 'x-real-ip': freshIp() },
        body: JSON.stringify({ email, password: PASSWORD, name: 'API' }),
      }),
    )
    expect(response.status).toBe(200)
    const { id } = await one<{ id: string }>(`select id from users where email = $1`, [email])
    const actor = pendingActor(id)
    expect(await command.viewMine(actor)).toMatchObject({ ok: true, receipt: { state: 'none', current: null, loginEmail: email } })

    const submitted = await command.reviseMine(
      actor,
      { appliedName: '補送同學', studentNo: '411500123', departmentClass: '資管二乙', phone: '0933333333', contactEmail: email },
      null,
    )
    expect(submitted).toMatchObject({ ok: true, receipt: { revision: 1 } })
    expect(await command.viewMine(actor)).toMatchObject({ ok: true, receipt: { state: 'pending' } })
  })
})

describe('系辦審核', () => {
  const admin = () => activeActor(adminId, ['admin'])

  it('待審清單只有管理員看得到；學生、待審的人、未登入都被擋', async () => {
    expect(await command.listPending(activeActor(studentAdminLike, ['student']))).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(await command.listPending(pendingActor(studentAdminLike))).toMatchObject({ ok: false, code: 'ACCOUNT_PENDING' })
    expect(await command.listPending(ANON)).toMatchObject({ ok: false, code: 'UNAUTHENTICATED' })
    expect(await command.listPending(admin())).toMatchObject({ ok: true })
  })

  it('ACC-02／05：名單符合＋Email 不同都並列；學生改過資料 → 舊畫面核准 CONFLICT → 重載後核准，全部寫齊', async () => {
    const email = uniqueEmail('s05')
    const userId = await register({ studentNo: '411500005', appliedName: '林小華', departmentClass: '資管二乙', loginEmail: email })
    const listed = await command.listPending(admin())
    if (!listed.ok) throw new Error(listed.message)
    const row = listed.receipt.applications.find((a) => a.userId === userId)!
    expect(row.flags).toEqual(['roster_matched', 'email_different'])
    expect(row.match.hit).toMatchObject({ nameRaw: '林小華', email: 's05-roster@example.com', cohortId: cohort115 })
    expect(row).toMatchObject({ cohortLocked: true, suggestedCohortId: cohort115, revision: 1 })

    // 系辦開著第 1 版的畫面，學生改了手機（第 2 版）。
    await command.reviseMine(
      pendingActor(userId),
      { appliedName: '林小華', studentNo: '411500005', departmentClass: '資管二乙', phone: '0955-555-555', contactEmail: email },
      1,
    )
    const stale = await command.approve(admin(), {
      applicationId: row.applicationId, revision: 1, verificationMethod: 'id_document', verificationNote: '', reason: '', cohortId: null, requestId: requestId(),
    })
    expect(stale).toMatchObject({ ok: false, code: 'CONFLICT', details: { currentRevision: 2 } })
    expect(await one(`select status from users where id = $1`, [userId])).toEqual({ status: 'pending' })

    // 核實方式必選。
    const noMethod = await command.approve(admin(), {
      applicationId: row.applicationId, revision: 2, verificationMethod: '', verificationNote: '', reason: '', cohortId: null, requestId: requestId(),
    })
    expect(noMethod).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', details: { field: 'verificationMethod' } })

    const id = requestId()
    const input = {
      applicationId: row.applicationId, revision: 2, verificationMethod: 'id_document', verificationNote: '9/24 櫃台核對學生證', reason: '', cohortId: null, requestId: id,
    }
    const approved = await command.approve(admin(), input)
    expect(approved).toMatchObject({ ok: true, receipt: { decision: 'approved', cohortName: '115 學年度專題', verificationMethod: 'id_document' } })

    expect(await one(`select status from users where id = $1`, [userId])).toEqual({ status: 'active' })
    expect(await one(`select role, granted_by_user_id from role_assignments where user_id = $1`, [userId])).toEqual({ role: 'student', granted_by_user_id: adminId })
    expect(await one(`select cohort_id, student_no from student_identities where user_id = $1`, [userId])).toEqual({ cohort_id: cohort115, student_no: '411500005' })
    expect(await one(`select display_name, cohort_id, phone, department_class from user_profiles where user_id = $1`, [userId])).toEqual({
      display_name: '林小華', cohort_id: cohort115, phone: '0955-555-555', department_class: '資管二乙',
    })
    expect(await one(`select from_status, to_status, verification_method, actor_user_id from user_status_events where user_id = $1`, [userId])).toEqual({
      from_status: 'pending', to_status: 'active', verification_method: 'id_document', actor_user_id: adminId,
    })
    const decided = await one<Record<string, unknown>>(
      `select state, decided_by_user_id, verification_method, verification_note, assigned_cohort_id, roster_version_id is not null as has_version, revision
         from registration_applications where id = $1`,
      [row.applicationId],
    )
    expect(decided).toEqual({
      state: 'approved', decided_by_user_id: adminId, verification_method: 'id_document', verification_note: '9/24 櫃台核對學生證',
      assigned_cohort_id: cohort115, has_version: true, revision: 2,
    })
    expect(await one(`select verification_method, cohort_id from audit_events where action = 'account.approve' and target_id = $1`, [row.applicationId])).toEqual({
      verification_method: 'id_document', cohort_id: cohort115,
    })

    // 同一個請求編號重送：回同一份回執，不重做；內容不同就拒絕。
    const replay = await command.approve(admin(), input)
    expect(replay).toMatchObject({ ok: true, receipt: { decidedAt: (approved as { receipt: { decidedAt: string } }).receipt.decidedAt } })
    expect(await command.approve(admin(), { ...input, verificationMethod: 'other', verificationNote: '改了' })).toMatchObject({ ok: false, code: 'REQUEST_MISMATCH' })
    // 新的請求編號：已經處理過了。
    expect(await command.approve(admin(), { ...input, requestId: requestId() })).toMatchObject({ ok: false, code: 'CONFLICT' })
  })

  it('學號占用表一律存大寫；同屆只差大小寫（含正規化以前的小寫舊列）→ STUDENT_NO_TAKEN（票 9）', async () => {
    const approveInto114 = async (applicationUserId: string) => {
      const listed = await command.listPending(admin())
      if (!listed.ok) throw new Error(listed.message)
      const row = listed.receipt.applications.find((a) => a.userId === applicationUserId)!
      return command.approve(admin(), {
        applicationId: row.applicationId, revision: row.revision, verificationMethod: 'id_document', verificationNote: '', reason: '', cohortId: cohort114, requestId: requestId(),
      })
    }
    const first = await register({ studentNo: 'b411400077', appliedName: '大小寫甲' })
    expect(await approveInto114(first)).toMatchObject({ ok: true })
    expect(await one(`select student_no from student_identities where user_id = $1`, [first])).toEqual({ student_no: 'B411400077' })
    // 顯示用的學號照本人填的原樣。
    expect(await one(`select student_no from user_profiles where user_id = $1`, [first])).toEqual({ student_no: 'b411400077' })

    const second = await register({ studentNo: 'B411400077', appliedName: '大小寫乙' })
    expect(await approveInto114(second)).toMatchObject({ ok: false, code: 'STUDENT_NO_TAKEN' })

    // 正規化以前寫進去的小寫舊列：主鍵擋不到，要靠 upper() 先查。
    await db.sql(`update student_identities set student_no = lower(student_no) where user_id = $1`, [first])
    expect(await approveInto114(second)).toMatchObject({ ok: false, code: 'STUDENT_NO_TAKEN' })
    expect(await one(`select status from users where id = $1`, [second])).toEqual({ status: 'pending' })
  })

  it('ACC-03：未命中要系辦指定屆別；沒有開放註冊屆別時伺服器不代選', async () => {
    const userId = await register({ studentNo: '411566666', appliedName: '沒在名單' })
    const listed = await command.listPending(admin())
    if (!listed.ok) throw new Error(listed.message)
    const row = listed.receipt.applications.find((a) => a.userId === userId)!
    expect(row.flags).toEqual(['not_found'])
    expect(row).toMatchObject({ cohortLocked: false, suggestedCohortId: cohort115 })

    await db.sql(`update cohorts set is_registration_open = false where id = $1`, [cohort115])
    try {
      const again = await command.listPending(admin())
      if (!again.ok) throw new Error(again.message)
      expect(again.receipt.registrationOpenCohort).toBeNull()
      expect(again.receipt.applications.find((a) => a.userId === userId)!.suggestedCohortId).toBeNull()

      const missing = await command.approve(admin(), {
        applicationId: row.applicationId, revision: 1, verificationMethod: 'school_channel', verificationNote: '教務處陳組長電話確認', reason: '', cohortId: null, requestId: requestId(),
      })
      expect(missing).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', details: { field: 'cohortId' } })
      const otherNoNote = await command.approve(admin(), {
        applicationId: row.applicationId, revision: 1, verificationMethod: 'other', verificationNote: '', reason: '', cohortId: cohort114, requestId: requestId(),
      })
      expect(otherNoNote).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', details: { field: 'verificationNote' } })

      const approved = await command.approve(admin(), {
        applicationId: row.applicationId, revision: 1, verificationMethod: 'school_channel', verificationNote: '教務處陳組長電話確認', reason: '轉學生', cohortId: cohort114, requestId: requestId(),
      })
      expect(approved).toMatchObject({ ok: true, receipt: { cohortName: '114 學年度專題' } })
      expect(await one(`select cohort_id from user_profiles where user_id = $1`, [userId])).toEqual({ cohort_id: cohort114 })
      // 不把他算進原本的名單。
      expect(await one(`select count(*)::int as n from roster_entries where student_no = '411566666'`)).toEqual({ n: 0 })
    } finally {
      await db.sql(`update cohorts set is_registration_open = true where id = $1`, [cohort115])
    }
  })

  it('ACC-04：重複學號標出來；核准第二個同學號 → STUDENT_NO_TAKEN，整筆回滾；退回要理由，本人看得到', async () => {
    const first = await register({ studentNo: '411500009', appliedName: 'John Smith' })
    const second = await register({ studentNo: '411500009', appliedName: 'john  SMITH' })
    const listed = await command.listPending(admin())
    if (!listed.ok) throw new Error(listed.message)
    const rowFirst = listed.receipt.applications.find((a) => a.userId === first)!
    const rowSecond = listed.receipt.applications.find((a) => a.userId === second)!
    expect(rowSecond.flags).toEqual(['roster_matched', 'duplicate_student_no', 'email_roster_blank'])
    expect(rowSecond.duplicates.otherPending).toBe(1)

    await command.approve(admin(), {
      applicationId: rowFirst.applicationId, revision: 1, verificationMethod: 'id_document', verificationNote: '', reason: '', cohortId: null, requestId: requestId(),
    })
    const again = await command.listPending(admin())
    if (!again.ok) throw new Error(again.message)
    expect(again.receipt.applications.find((a) => a.userId === second)!.duplicates.activeHolders).toEqual([{ name: 'John Smith', cohortCode: '115' }])

    const taken = await command.approve(admin(), {
      applicationId: rowSecond.applicationId, revision: 1, verificationMethod: 'id_document', verificationNote: '', reason: '', cohortId: null, requestId: requestId(),
    })
    expect(taken).toMatchObject({ ok: false, code: 'STUDENT_NO_TAKEN' })
    expect(await one(`select status from users where id = $1`, [second])).toEqual({ status: 'pending' })
    expect(await one(`select state from registration_applications where id = $1`, [rowSecond.applicationId])).toEqual({ state: 'pending' })
    expect(await one(`select count(*)::int as n from role_assignments where user_id = $1`, [second])).toEqual({ n: 0 })

    const noReason = await command.reject(admin(), { applicationId: rowSecond.applicationId, revision: 1, reason: ' ', requestId: requestId() })
    expect(noReason).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', details: { field: 'reason' } })
    const rejected = await command.reject(admin(), {
      applicationId: rowSecond.applicationId, revision: 1, reason: '這個學號已經有人用了，請到系辦確認身分', requestId: requestId(),
    })
    expect(rejected).toMatchObject({ ok: true, receipt: { decision: 'rejected' } })
    // 帳號留著（仍是待審），第一個人的帳號與占用不受影響。
    expect(await one(`select status from users where id = $1`, [second])).toEqual({ status: 'pending' })
    expect(await one(`select status from users where id = $1`, [first])).toEqual({ status: 'active' })
    expect(await one(`select count(*)::int as n from student_identities where student_no = '411500009'`)).toEqual({ n: 1 })

    const mine = await command.viewMine(pendingActor(second))
    expect(mine).toMatchObject({ ok: true, receipt: { state: 'rejected', rejection: { reason: '這個學號已經有人用了，請到系辦確認身分' } } })

    // 被退回後修改重送：新的一筆申請、第 1 版、待審；舊的那筆不能再被核准。
    const resubmitted = await command.reviseMine(
      pendingActor(second),
      { appliedName: 'John Smith Jr', studentNo: '411500010', departmentClass: '資管二甲', phone: '0912345678', contactEmail: 'j@example.com' },
      null,
    )
    expect(resubmitted).toMatchObject({ ok: true, receipt: { revision: 1 } })
    expect((resubmitted as { receipt: { applicationId: string } }).receipt.applicationId).not.toBe(rowSecond.applicationId)
    expect(await command.viewMine(pendingActor(second))).toMatchObject({ ok: true, receipt: { state: 'pending', rejection: null } })
    expect(
      await command.approve(admin(), {
        applicationId: rowSecond.applicationId, revision: 1, verificationMethod: 'id_document', verificationNote: '', reason: '', cohortId: null, requestId: requestId(),
      }),
    ).toMatchObject({ ok: false, code: 'CONFLICT' })
  })

  it('非管理員核准或退回一律被擋，資料不變', async () => {
    const userId = await register({ studentNo: '411577777' })
    const { id } = await one<{ id: string }>(`select id from registration_applications where user_id = $1`, [userId])
    const input = { applicationId: id, revision: 1, verificationMethod: 'id_document', verificationNote: '', reason: 'x', cohortId: null, requestId: requestId() }
    expect(await command.approve(activeActor(studentAdminLike, ['student']), input)).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(await command.approve(pendingActor(userId), input)).toMatchObject({ ok: false, code: 'ACCOUNT_PENDING' })
    expect(await command.reject(ANON, input)).toMatchObject({ ok: false, code: 'UNAUTHENTICATED' })
    expect(await one(`select state from registration_applications where id = $1`, [id])).toEqual({ state: 'pending' })
    expect(await one(`select status from users where id = $1`, [userId])).toEqual({ status: 'pending' })
  })
})
