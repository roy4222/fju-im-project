import { Pool } from 'pg'
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
let failingMailCommand: RegistrationCommand
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
  const { CaptureMailer } = await import('@/infrastructure/mail/capture-mailer')
  const { BrevoMailer } = await import('@/infrastructure/mail/brevo-mailer')
  const deps = {
    audit: new PgAuditWriter(),
    ledger: new PgOperationLedger(() => app),
    db: () => app,
    cohorts: new PgCohortStatusQuery(() => app),
  }
  // 審核結果信（VB-1）：一般用例注入擷取 mailer；另一個實例的 Brevo 永遠回 500，驗「寄失敗不影響審核」。
  command = new PgRegistrationCommand({ ...deps, mail: { mailer: new CaptureMailer({ db: () => app }), siteUrl: BASE_URL } })
  failingMailCommand = new PgRegistrationCommand({
    ...deps,
    mail: {
      mailer: new BrevoMailer({
        db: () => app,
        config: { apiKey: 'fake-key', from: '專題管理平台 <noreply@example.com>' },
        fetch: async () => new Response(JSON.stringify({ code: 'internal_error' }), { status: 500 }),
      }),
      siteUrl: BASE_URL,
    },
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

  it('沒有申請單的待審帳號（直接打 API 註冊的）：看到 none；沒驗證 Email 送不出（不建申請），驗證後補送一次就有第 1 版', async () => {
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

    const fields = { appliedName: '補送同學', studentNo: '411500123', departmentClass: '資管二乙', phone: '0933333333', contactEmail: email }
    // VB-3 Review：沒驗證 Email 的密碼帳號重放舊的「修改資料」入口送第一份申請 → 擋下，不建申請（AC-VI-50）。
    // 判斷讀資料庫，session 快照說什麼都一樣。
    const unverified = await command.reviseMine({ ...pendingActor(id), loginMethod: 'password' } as ResolvedActor, fields, null)
    expect(unverified).toMatchObject({ ok: false, code: 'FORBIDDEN', message: '請先完成 Email 驗證。' })
    expect(await one<{ n: number }>(`select count(*)::int as n from registration_applications where user_id = $1`, [id])).toEqual({ n: 0 })

    await one(`update users set email_verified = true where id = $1 returning id`, [id])
    const submitted = await command.reviseMine(actor, fields, null)
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

    const id = requestId()
    const input = {
      applicationId: row.applicationId, revision: 2, verificationMethod: '', verificationNote: '', reason: '', cohortId: null, requestId: id,
    }
    // 不帶核實方式也能核准（C2-10；AC-C2-15）：寫入固定值 office_review。
    const approved = await command.approve(admin(), input)
    expect(approved).toMatchObject({ ok: true, receipt: { decision: 'approved', cohortName: '115 學年度專題', verificationMethod: 'office_review' } })

    expect(await one(`select status from users where id = $1`, [userId])).toEqual({ status: 'active' })
    expect(await one(`select role, granted_by_user_id from role_assignments where user_id = $1`, [userId])).toEqual({ role: 'student', granted_by_user_id: adminId })
    expect(await one(`select cohort_id, student_no from student_identities where user_id = $1`, [userId])).toEqual({ cohort_id: cohort115, student_no: '411500005' })
    expect(await one(`select display_name, cohort_id, phone, department_class from user_profiles where user_id = $1`, [userId])).toEqual({
      display_name: '林小華', cohort_id: cohort115, phone: '0955-555-555', department_class: '資管二乙',
    })
    expect(await one(`select from_status, to_status, verification_method, actor_user_id from user_status_events where user_id = $1`, [userId])).toEqual({
      from_status: 'pending', to_status: 'active', verification_method: 'office_review', actor_user_id: adminId,
    })
    const decided = await one<Record<string, unknown>>(
      `select state, decided_by_user_id, verification_method, verification_note, assigned_cohort_id, roster_version_id is not null as has_version, revision
         from registration_applications where id = $1`,
      [row.applicationId],
    )
    expect(decided).toEqual({
      state: 'approved', decided_by_user_id: adminId, verification_method: 'office_review', verification_note: null,
      assigned_cohort_id: cohort115, has_version: true, revision: 2,
    })
    expect(await one(`select verification_method, cohort_id from audit_events where action = 'account.approve' and target_id = $1`, [row.applicationId])).toEqual({
      verification_method: 'office_review', cohort_id: cohort115,
    })

    // 同一個請求編號重送：回同一份回執，不重做；內容不同就拒絕。
    const replay = await command.approve(admin(), input)
    expect(replay).toMatchObject({ ok: true, receipt: { decidedAt: (approved as { receipt: { decidedAt: string } }).receipt.decidedAt } })
    expect(await command.approve(admin(), { ...input, reason: '改了' })).toMatchObject({ ok: false, code: 'REQUEST_MISMATCH' })
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
    // AC-C2-20：待審清單用「先前被退回過」標已重送（新申請的版本是 1，不能靠版本判斷）；沒被退回過的不標。
    const relisted = await command.listPending(admin())
    if (!relisted.ok) throw new Error(relisted.message)
    expect(relisted.receipt.applications.find((a) => a.userId === second)).toMatchObject({ revision: 1, previouslyRejected: true })
    expect(relisted.receipt.applications.find((a) => a.userId === first)?.previouslyRejected ?? false).toBe(false)
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

describe('票 7 審查建議（票 8 順手）', () => {
  it('待審修改有每人限速：一小時 20 次，第 21 次擋下且不留新版本；別人不受影響', async () => {
    const { resetReviseLimiter } = await import('@/infrastructure/accounts/registration-command')
    resetReviseLimiter()
    const userId = await register({ studentNo: '411588801' })
    const fields = { appliedName: '王小明', studentNo: '411588801', departmentClass: '資管二甲', phone: '0912345678', contactEmail: 'x@example.com' }
    for (let revision = 1; revision <= 20; revision += 1) {
      const result = await command.reviseMine(pendingActor(userId), { ...fields, phone: `09123456${String(revision).padStart(2, '0')}` }, revision)
      expect(result, `第 ${revision} 次應該放行`).toMatchObject({ ok: true })
    }
    const blocked = await command.reviseMine(pendingActor(userId), fields, 21)
    expect(blocked).toMatchObject({ ok: false, code: 'RATE_LIMITED' })
    expect(await one(`select revision from registration_applications where user_id = $1 and state = 'pending'`, [userId])).toEqual({ revision: 21 })

    const other = await register({ studentNo: '411588802' })
    expect(await command.reviseMine(pendingActor(other), { ...fields, studentNo: '411588802' }, 1)).toMatchObject({ ok: true })
    resetReviseLimiter()
  })

  it('核准與本人修改同時進來不會死鎖：兩邊都先鎖 users，一個成功、另一個得到明確的 CONFLICT', async () => {
    const userId = await register({ studentNo: '411588803' })
    const { id } = await one<{ id: string }>(`select id from registration_applications where user_id = $1`, [userId])
    const fields = { appliedName: '王小明', studentNo: '411588803', departmentClass: '資管二甲', phone: '0912345000', contactEmail: 'y@example.com' }
    for (let round = 0; round < 5; round += 1) {
      const current = await one<{ revision: number; state: string }>(`select revision, state from registration_applications where id = $1`, [id])
      if (current.state !== 'pending') break
      const [approved, revised] = await Promise.all([
        command.approve(activeActor(adminId, ['admin']), {
          applicationId: id, revision: current.revision, verificationMethod: 'id_document', verificationNote: '', reason: '', cohortId: cohort115, requestId: requestId(),
        }),
        command.reviseMine(pendingActor(userId), { ...fields, phone: `091234500${round}` }, current.revision),
      ])
      // 先拿到鎖的那一邊成功；另一邊看到的是新狀態（CONFLICT），不是資料庫死鎖錯誤（會直接 throw）。
      expect([approved.ok, revised.ok].filter(Boolean)).toHaveLength(1)
      if (!approved.ok) expect(approved).toMatchObject({ code: 'CONFLICT' })
      if (!revised.ok) expect(revised).toMatchObject({ code: 'CONFLICT' })
    }
  })
})

describe('批次核准（第三波 W6，AC-24）', () => {
  const admin = () => activeActor(adminId, ['admin'])

  it('勾 3 位：2 位名單比對到 → 核准；1 位學號已被使用 → 預覽與結果都略過並寫原因；重送不會重複核准', async () => {
    // 114 屆自己的名單（不動 115 屆給其他案例用的那一份）。
    const version = String(
      (
        await db.sql(
          `insert into roster_versions (id, cohort_id, imported_by_user_id, imported_real_at, summary)
           values (gen_random_uuid(), $1, $2, now(), '{}'::jsonb) returning id`,
          [cohort114, adminId],
        )
      ).rows[0]!.id,
    )
    for (const [no, name] of [['411400101', '批次一'], ['411400102', '批次二'], ['411400103', '批次三']] as const) {
      await db.sql(
        `insert into roster_entries (id, roster_version_id, student_no, name_raw, name_normalized)
         values (gen_random_uuid(), $1, $2, $3, $3)`,
        [version, no, name],
      )
    }
    const u1 = await register({ studentNo: '411400101', appliedName: '批次一' })
    const u2 = await register({ studentNo: '411400102', appliedName: '批次二' })
    // 先有人用 411400103 核准掉，第三位的學號就已被使用。
    const holder = await register({ studentNo: '411400103', appliedName: '批次三' })
    const u3 = await register({ studentNo: '411400103', appliedName: '批次三' })
    const appOf = async (userId: string) =>
      (await one<{ id: string }>(`select id from registration_applications where user_id = $1 and state = 'pending'`, [userId])).id
    expect(
      await command.approve(admin(), {
        applicationId: await appOf(holder), revision: 1, verificationMethod: 'id_document', verificationNote: '', reason: '', cohortId: null, requestId: requestId(),
      }),
    ).toMatchObject({ ok: true })

    const ids = [await appOf(u1), await appOf(u2), await appOf(u3)]
    const preview = await command.previewApproveMany(admin(), ids)
    if (!preview.ok) throw new Error(preview.message)
    expect(preview.receipt.missing).toBe(0)
    expect(preview.receipt.rows.map((r) => [r.appliedName, r.rosterMatch, r.cohortName, r.skipLabel])).toEqual([
      ['批次一', 'matched', '114 學年度專題', null],
      ['批次二', 'matched', '114 學年度專題', null],
      ['批次三', 'matched', null, '學號已被使用'],
    ])

    // 核實欄位不對：整批不做。
    // 照畫面的做法：預覽可核准的固定成要核准的清單；預覽略過的另外送，只回報原因。
    const items = preview.receipt.rows
      .filter((r) => !r.skip)
      .map((r) => ({ applicationId: r.applicationId, revision: r.revision, requestId: requestId() }))
    const previewSkipped = preview.receipt.rows.filter((r) => r.skip).map((r) => r.applicationId)
    const bad = await command.approveMany(admin(), { items, previewSkipped, verificationMethod: 'other', verificationNote: '', reason: '' })
    expect(bad).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', details: { field: 'verificationNote' } })
    expect(await one(`select status from users where id = $1`, [u1])).toEqual({ status: 'pending' })

    const input = { items, previewSkipped, verificationMethod: 'id_document', verificationNote: '10/12 櫃台核對學生證', reason: '' }
    const done = await command.approveMany(admin(), input)
    if (!done.ok) throw new Error(done.message)
    expect(done.receipt.approved.map((a) => [a.appliedName, a.cohortName])).toEqual([
      ['批次一', '114 學年度專題'],
      ['批次二', '114 學年度專題'],
    ])
    expect(done.receipt.skipped).toEqual([{ applicationId: ids[2], appliedName: '批次三', reason: '學號已被使用' }])

    for (const u of [u1, u2]) expect(await one(`select status from users where id = $1`, [u])).toEqual({ status: 'active' })
    expect(await one(`select status from users where id = $1`, [u3])).toEqual({ status: 'pending' })
    const audits = `select count(*)::int as n from audit_events where action = 'account.approve' and target_id = any($1::uuid[])`
    expect(await one(audits, [ids])).toEqual({ n: 2 })
    expect(await one(`select verification_method from audit_events where action = 'account.approve' and target_id = $1`, [ids[0]])).toEqual({
      verification_method: 'id_document',
    })

    // 結果未知時再按一次（同一組請求編號）：已核准的回放回執，不多寫紀錄。
    const replay = await command.approveMany(admin(), input)
    expect(replay).toMatchObject({ ok: true, receipt: { approved: [{ appliedName: '批次一' }, { appliedName: '批次二' }] } })
    expect(await one(audits, [ids])).toEqual({ n: 2 })
  })

  it('非管理員預覽或批次核准一律被擋；沒勾、重複、超過上限都擋', async () => {
    const userId = await register({ studentNo: '411400199' })
    const { id } = await one<{ id: string }>(`select id from registration_applications where user_id = $1`, [userId])
    const input = { items: [{ applicationId: id, revision: 1, requestId: requestId() }], previewSkipped: [], verificationMethod: 'id_document', verificationNote: '', reason: '' }
    expect(await command.approveMany(activeActor(studentAdminLike, ['student']), input)).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(await command.previewApproveMany(ANON, [id])).toMatchObject({ ok: false, code: 'UNAUTHENTICATED' })
    expect(await command.previewApproveMany(admin(), [])).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    expect(await command.previewApproveMany(admin(), [id, id])).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    expect(await command.previewApproveMany(admin(), Array.from({ length: 201 }, () => id))).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    expect(await one(`select status from users where id = $1`, [userId])).toEqual({ status: 'pending' })
  })
})

describe('批次核准：預覽之後名單變了（第三波 W6 審查修正）', () => {
  const admin = () => activeActor(adminId, ['admin'])

  /** 新開一屆、匯入一版名單（每次呼叫都是這一屆的最新版本）。 */
  async function rosterVersion(cohortId: string, entries: readonly (readonly [string, string])[]) {
    const version = String(
      (
        await db.sql(
          `insert into roster_versions (id, cohort_id, imported_by_user_id, imported_real_at, summary)
           values (gen_random_uuid(), $1, $2, clock_timestamp(), '{}'::jsonb) returning id`,
          [cohortId, adminId],
        )
      ).rows[0]!.id,
    )
    for (const [no, name] of entries) {
      await db.sql(
        `insert into roster_entries (id, roster_version_id, student_no, name_raw, name_normalized)
         values (gen_random_uuid(), $1, $2, $3, $3)`,
        [version, no, name],
      )
    }
  }
  async function newCohort(code: string) {
    return String(
      (
        await db.sql(
          `insert into cohorts (id, code, name, created_by_kind) values (gen_random_uuid(), $1, $2, 'system') returning id`,
          [code, `${code} 學年度專題`],
        )
      ).rows[0]!.id,
    )
  }
  const appOf = async (userId: string) =>
    (await one<{ id: string }>(`select id from registration_applications where user_id = $1 and state = 'pending'`, [userId])).id
  const input = (items: { applicationId: string; revision: number; requestId: string }[], previewSkipped: string[] = []) => ({
    items,
    previewSkipped,
    verificationMethod: 'id_document',
    verificationNote: '',
    reason: '',
  })

  it('預覽後名單改成姓名不符：每筆在自己的交易裡重查資格，略過、仍待審、沒有核准紀錄', async () => {
    const cohort = await newCohort('113')
    await rosterVersion(cohort, [['410900001', '改名前']])
    const userId = await register({ studentNo: '410900001', appliedName: '改名前' })
    const id = await appOf(userId)
    const preview = await command.previewApproveMany(admin(), [id])
    expect(preview).toMatchObject({ ok: true, receipt: { rows: [{ applicationId: id, skip: null }] } })

    // 系辦確認前，名單換了一版：姓名變了。
    await rosterVersion(cohort, [['410900001', '改名後']])
    const done = await command.approveMany(admin(), input([{ applicationId: id, revision: 1, requestId: requestId() }]))
    expect(done).toMatchObject({
      ok: true,
      receipt: { approved: [], skipped: [{ applicationId: id, appliedName: '改名前', reason: '姓名跟名單不同，請個別審核' }] },
    })
    expect(await one(`select status from users where id = $1`, [userId])).toEqual({ status: 'pending' })
    expect(await one(`select state from registration_applications where id = $1`, [id])).toEqual({ state: 'pending' })
    expect(await one(`select count(*)::int as n from audit_events where action = 'account.approve' and target_id = $1`, [id])).toEqual({ n: 0 })

    // 單筆審核照舊：系辦個別打開核對後，姓名不符仍可以核准（名單只協助判斷）。
    expect(
      await command.approve(admin(), {
        applicationId: id, revision: 1, verificationMethod: 'id_document', verificationNote: '', reason: '', cohortId: null, requestId: requestId(),
      }),
    ).toMatchObject({ ok: true })
  })

  it('預覽時略過的人，確認前名單補齊了也不會被核准：執行只能縮小、不能擴大，略過的照樣回報原因', async () => {
    const cohort = await newCohort('112')
    await rosterVersion(cohort, [['411200001', '名單上']])
    const onRoster = await register({ studentNo: '411200001', appliedName: '名單上' })
    const offRoster = await register({ studentNo: '411200002', appliedName: '名單外' })
    const [a, b] = [await appOf(onRoster), await appOf(offRoster)]
    const preview = await command.previewApproveMany(admin(), [a, b])
    if (!preview.ok) throw new Error(preview.message)
    expect(preview.receipt.rows.map((r) => r.skip)).toEqual([null, 'not_found'])

    // 確認前把第二位補進名單：現在兩位都符合。
    await rosterVersion(cohort, [['411200001', '名單上'], ['411200002', '名單外']])
    const done = await command.approveMany(admin(), input([{ applicationId: a, revision: 1, requestId: requestId() }], [b]))
    expect(done).toMatchObject({
      ok: true,
      receipt: {
        approved: [{ applicationId: a }],
        skipped: [{ applicationId: b, appliedName: '名單外', reason: '預覽時不在可核准名單，請重新預覽或個別審核' }],
      },
    })
    expect(await one(`select status from users where id = $1`, [offRoster])).toEqual({ status: 'pending' })

    // 同一位不能同時在「要核准」與「預覽略過」兩邊。
    expect(
      await command.approveMany(admin(), input([{ applicationId: b, revision: 1, requestId: requestId() }], [b])),
    ).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    expect(await one(`select status from users where id = $1`, [offRoster])).toEqual({ status: 'pending' })
  })
})

describe('審核結果信（B 階段 VB-1，AC-VI-53）', () => {
  const admin = () => activeActor(adminId, ['admin'])
  let studentNo = 411500700
  const appOf = async (userId: string) =>
    (await one<{ id: string }>(`select id from registration_applications where user_id = $1 and state = 'pending'`, [userId])).id
  const outboxOf = (email: string) =>
    db.sql(
      `select template, to_email, subject, body_text, status, error from mail_outbox where to_email = $1 and template = 'registration_result' order by created_at`,
      [email],
    )
  const approveInput = async (userId: string) => ({
    applicationId: await appOf(userId), revision: 1, verificationMethod: 'id_document', verificationNote: '', reason: '', cohortId: cohort115, requestId: requestId(),
  })

  it('核准後 mail_outbox 有一列寄給登入 Email、連到 /login；不含姓名與學號；同請求編號重送不再寄', async () => {
    const email = uniqueEmail('mail-ok')
    const no = String(++studentNo)
    const userId = await register({ studentNo: no, appliedName: '寄信測試', loginEmail: email })
    const input = await approveInput(userId)
    expect(await command.approve(admin(), input)).toMatchObject({ ok: true, receipt: { decision: 'approved' } })

    const { rows } = await outboxOf(email)
    expect(rows).toEqual([
      {
        template: 'registration_result',
        to_email: email,
        subject: '【專題管理平台】帳號已開通',
        body_text: `你的帳號已開通，請到 ${BASE_URL}/login 登入。`,
        status: 'captured',
        error: null,
      },
    ])
    expect(String(rows[0]!.body_text)).not.toContain('寄信測試')
    expect(String(rows[0]!.body_text)).not.toContain(no)

    expect(await command.approve(admin(), input)).toMatchObject({ ok: true })
    expect((await outboxOf(email)).rows).toHaveLength(1)
  })

  it('退回後的信帶理由並連到 /register/pending', async () => {
    const email = uniqueEmail('mail-reject')
    const userId = await register({ studentNo: String(++studentNo), appliedName: '退回測試', loginEmail: email })
    const rejected = await command.reject(admin(), { applicationId: await appOf(userId), revision: 1, reason: '學號打錯', requestId: requestId() })
    expect(rejected).toMatchObject({ ok: true, receipt: { decision: 'rejected' } })
    expect((await outboxOf(email)).rows).toEqual([
      {
        template: 'registration_result',
        to_email: email,
        subject: '【專題管理平台】註冊申請被退回',
        body_text: `你的註冊申請被退回。理由：學號打錯。請到 ${BASE_URL}/register/pending 修改後重新送出。`,
        status: 'captured',
        error: null,
      },
    ])
  })

  it('批次核准：每位核准的人各一封，略過的人沒有', async () => {
    const e1 = uniqueEmail('mail-bulk1')
    const e2 = uniqueEmail('mail-bulk2')
    // 自己一屆、自己一份名單，不跟上面的案例搶學號。
    const cohort108 = String(
      (
        await db.sql(
          `insert into cohorts (id, code, name, created_by_kind, is_registration_open)
           values (gen_random_uuid(), '108', '108 學年度專題', 'system', false) returning id`,
        )
      ).rows[0]!.id,
    )
    const version = String(
      (
        await db.sql(
          `insert into roster_versions (id, cohort_id, imported_by_user_id, imported_real_at, summary)
           values (gen_random_uuid(), $1, $2, now(), '{}'::jsonb) returning id`,
          [cohort108, adminId],
        )
      ).rows[0]!.id,
    )
    await db.sql(
      `insert into roster_entries (id, roster_version_id, student_no, name_raw, name_normalized)
       values (gen_random_uuid(), $1, '410800777', '寄信批次', '寄信批次')`,
      [version],
    )
    const u1 = await register({ studentNo: '410800777', appliedName: '寄信批次', loginEmail: e1 })
    const u2 = await register({ studentNo: '411599999', appliedName: '不在名單', loginEmail: e2 })
    const items = [
      { applicationId: await appOf(u1), revision: 1, requestId: requestId() },
      { applicationId: await appOf(u2), revision: 1, requestId: requestId() },
    ]
    const done = await command.approveMany(admin(), { items, previewSkipped: [], verificationMethod: 'id_document', verificationNote: '', reason: '' })
    if (!done.ok) throw new Error(done.message)
    expect(done.receipt.skipped.map((s) => [s.appliedName, s.reason])).toEqual([['不在名單', '名單比對不到，請個別審核']])
    expect(done.receipt.approved.map((a) => a.appliedName)).toEqual(['寄信批次'])
    expect((await outboxOf(e1)).rows.map((r) => [r.template, r.status])).toEqual([['registration_result', 'captured']])
    expect((await outboxOf(e2)).rows).toEqual([])
  })

  it('連線池滿載：10 筆同時退回、10 筆同時核准都做完、各寄一封（交易連線先還回池子再寄信，Review 第 1 輪）', async () => {
    // 正式設定的池子上限是 10。交易 commit 後若還抓著連線去寄信，寄信要的那一條永遠等不到 → 全部卡住。
    // 這裡給取連線 5 秒逾時，卡住就變成寄信失敗（outbox 少列），測試直接紅，不會掛著。
    const url = new URL(TEST_DATABASE_URL)
    url.username = 'fju_app'
    url.password = process.env.TEST_FJU_APP_PASSWORD ?? 'fju_app_local_test'
    const full = new Pool({ connectionString: url.toString(), max: 10, connectionTimeoutMillis: 5_000, options: `-c search_path=${db.schemaName}` })
    const { PgRegistrationCommand } = await import('@/infrastructure/accounts/registration-command')
    const { PgAuditWriter } = await import('@/infrastructure/ops/audit-writer')
    const { PgOperationLedger } = await import('@/infrastructure/ops/operation-ledger')
    const { PgCohortStatusQuery } = await import('@/infrastructure/cohorts/pg-cohorts')
    const { CaptureMailer } = await import('@/infrastructure/mail/capture-mailer')
    const saturated = new PgRegistrationCommand({
      audit: new PgAuditWriter(),
      ledger: new PgOperationLedger(() => full),
      db: () => full,
      cohorts: new PgCohortStatusQuery(() => full),
      mail: { mailer: new CaptureMailer({ db: () => full }), siteUrl: BASE_URL },
    })
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const batch = async (tag: string) => {
        const emails = Array.from({ length: 10 }, (_, i) => uniqueEmail(`${tag}${i}`))
        const users: string[] = []
        for (const email of emails) users.push(await register({ studentNo: String(++studentNo), appliedName: '滿載測試', loginEmail: email }))
        return { emails, users }
      }
      const countFor = async (emails: string[]) =>
        Number((await one<{ n: number }>(`select count(*)::int as n from mail_outbox where to_email = any($1) and template = 'registration_result' and status = 'captured'`, [emails])).n)

      const rejecting = await batch('pool-rej')
      const rejected = await Promise.all(
        await Promise.all(
          rejecting.users.map(async (u) => ({ applicationId: await appOf(u), revision: 1, reason: '學號打錯', requestId: requestId() })),
        ).then((inputs) => inputs.map((input) => saturated.reject(admin(), input))),
      )
      expect(rejected.filter((r) => r.ok)).toHaveLength(10)
      expect(await countFor(rejecting.emails)).toBe(10)

      const approving = await batch('pool-ok')
      const inputs = await Promise.all(approving.users.map((u) => approveInput(u)))
      const approved = await Promise.all(inputs.map((input) => saturated.approve(admin(), input)))
      expect(approved.filter((r) => r.ok)).toHaveLength(10)
      expect(await countFor(approving.emails)).toBe(10)
      expect(full.waitingCount).toBe(0)
      expect(errors).not.toHaveBeenCalled()
    } finally {
      errors.mockRestore()
      await full.end()
    }
  })

  it('寄信失敗（Brevo 500）：核准照樣成功、帳號開通，那一列記 failed、不存內文', async () => {
    const email = uniqueEmail('mail-fail')
    const userId = await register({ studentNo: String(++studentNo), appliedName: '寄失敗', loginEmail: email })
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const approved = await failingMailCommand.approve(admin(), await approveInput(userId))
    errors.mockRestore()
    expect(approved).toMatchObject({ ok: true, receipt: { decision: 'approved' } })
    expect(await one(`select status from users where id = $1`, [userId])).toEqual({ status: 'active' })
    expect((await outboxOf(email)).rows).toEqual([
      {
        template: 'registration_result',
        to_email: email,
        subject: '【專題管理平台】帳號已開通',
        body_text: null,
        status: 'failed',
        error: 'brevo_500_internal_error',
      },
    ])
  })
})

describe('Q42 自動開通（VB-6，AC-VI-55、56）', () => {
  const admin = () => activeActor(adminId, ['admin'])
  let rosterVersion: string
  const googleActor = (userId: string): ResolvedActor => ({ ...pendingActor(userId), loginMethod: 'google' }) as ResolvedActor

  /** 115 屆最新一版名單多一列（學號、姓名、名單 Email）。 */
  const rosterRow = async (studentNo: string, name: string, email: string | null) =>
    db.sql(
      `insert into roster_entries (id, roster_version_id, student_no, name_raw, name_normalized, department_class, email)
       values (gen_random_uuid(), $1, $2, $3, lower($3), '資管二甲', $4)`,
      [rosterVersion, studentNo, name, email],
    )
  /** 待審、Email 已驗證的帳號；`google` 時多一個 Google 登入方式（Google 回呼建帳號後的樣子）。 */
  const pendingUser = async (email: string, google = true) => {
    const id = String(
      (
        await db.sql(
          `insert into users (id, name, email, email_verified, updated_at, status)
           values (gen_random_uuid(), 'Google 名字', $1, true, now(), 'pending') returning id`,
          [email],
        )
      ).rows[0]!.id,
    )
    if (google) {
      await db.sql(
        `insert into accounts (id, account_id, provider_id, user_id, created_at, updated_at)
         values (gen_random_uuid(), $1, 'google', $2, now(), now())`,
        [`sub-${email}`, id],
      )
    }
    return id
  }
  const fieldsOf = (appliedName: string, studentNo: string, contactEmail: string) => ({
    appliedName,
    studentNo,
    departmentClass: '資管二甲',
    phone: '0912-345-678',
    contactEmail,
  })
  const stateOf = (userId: string) =>
    one<{ state: string; verification_method: string | null; status: string }>(
      `select ra.state, ra.verification_method, u.status
         from registration_applications ra join users u on u.id = ra.user_id where ra.user_id = $1`,
      [userId],
    )

  beforeAll(async () => {
    rosterVersion = (await one<{ id: string }>(`select id from roster_versions where cohort_id = $1`, [cohort115])).id
    await rosterRow('411401002', '李小華', 'g2@example.com')
  })

  it('AC-VI-55：Google 來、Email＋學號＋姓名命中開放屆別同一列、學號沒人用 → 直接開通（系統核准、稽核一筆、不寄信）', async () => {
    const userId = await pendingUser('g2@example.com')
    const result = await command.reviseMine(googleActor(userId), fieldsOf('李小華', '411401002', 'g2@example.com'), null)
    expect(result).toMatchObject({ ok: true, receipt: { revision: 1, autoApproved: true } })

    const application = await one<Record<string, unknown>>(
      `select id, state, verification_method, verification_note, decided_by_user_id, decided_real_at, assigned_cohort_id
         from registration_applications where user_id = $1`,
      [userId],
    )
    expect(application).toMatchObject({
      state: 'approved',
      verification_method: 'google_email_match',
      verification_note: null,
      decided_by_user_id: null,
      assigned_cohort_id: cohort115,
    })
    expect(application.decided_real_at).not.toBeNull()
    expect(await one(`select status, name from users where id = $1`, [userId])).toEqual({ status: 'active', name: '李小華' })
    expect(await one(`select cohort_id, student_no from user_profiles where user_id = $1`, [userId])).toEqual({
      cohort_id: cohort115,
      student_no: '411401002',
    })
    expect(
      await one(`select granted_by_user_id, reason from role_assignments where user_id = $1 and role = 'student'`, [userId]),
    ).toEqual({ granted_by_user_id: userId, reason: '自動開通（Google Email 與名單相同）' })
    expect(await one(`select cohort_id, student_no from student_identities where user_id = $1`, [userId])).toEqual({
      cohort_id: cohort115,
      student_no: '411401002',
    })
    expect(
      await one(`select actor_kind, actor_user_id, verification_method from user_status_events where user_id = $1`, [userId]),
    ).toEqual({ actor_kind: 'system', actor_user_id: null, verification_method: 'google_email_match' })
    const audits = await db.sql(
      `select actor_kind, actor_user_id, action, scope, cohort_id, reason, verification_method, payload
         from audit_events where target_id = $1 order by real_at, action`,
      [application.id],
    )
    // 證據：自動開通那一列（PR 說明引用這段輸出）。
    console.info('[AC-VI-55 audit_events]', JSON.stringify(audits.rows.find((r) => r.action === 'registration.auto_approve')))
    expect(audits.rows.map((r) => r.action).sort()).toEqual(['registration.apply', 'registration.auto_approve'])
    expect(audits.rows.find((r) => r.action === 'registration.auto_approve')).toMatchObject({
      actor_kind: 'system',
      actor_user_id: null,
      scope: 'cohort',
      cohort_id: cohort115,
      reason: 'Google Email 與名單相同，自動開通',
      verification_method: 'google_email_match',
      payload: { userId, revision: 1, rosterMatch: 'matched', emailComparison: 'same' },
    })
    // 不寄「帳號已開通」（畫面直接告訴他）。
    expect(await one(`select count(*)::int as n from mail_outbox where to_email = 'g2@example.com'`)).toEqual({ n: 0 })
    // 「帳號已開通」頁的判斷：讀資料庫，是自動開通。
    expect(await command.autoApprovedMine(activeActor(userId, ['student']))).toBe(true)
    // 已開通：沒有待審申請可看，也不會出現在系辦待審清單。
    expect(await command.viewMine(activeActor(userId, ['student']))).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    const listed = await command.listPending(admin())
    expect(listed.ok && listed.receipt.applications.some((a) => a.userId === userId)).toBe(false)
  })

  it('AC-VI-56：密碼註冊 Email 相同、Email 不同、學號已被占用、姓名不同、+suffix、全形字 → 六種都照舊待審、不報錯', async () => {
    await rosterRow('411401010', '李小華', 'g10@example.com') // (a)
    await rosterRow('411401011', '李小華', 'g11@example.com') // (b)
    await rosterRow('411401012', '李小華', 'g12@example.com') // (c)
    await rosterRow('411401013', '李小華', 'g13@example.com') // (d)
    await rosterRow('411401014', '李小華', 'g14@example.com') // (e)
    await rosterRow('411401015', '李小華', 'g15@example.com') // (f)

    // (c) 先讓別人用 411401012 經系辦核准占用（名單同一列，但那人 Email 不同、走人工審核）。
    const holder = await pendingUser('holder-g12@example.com', false)
    expect(await command.reviseMine(pendingActor(holder), fieldsOf('李小華', '411401012', 'holder-g12@example.com'), null)).toMatchObject({
      ok: true,
    })
    const holderApp = (await one<{ id: string }>(`select id from registration_applications where user_id = $1`, [holder])).id
    expect(
      await command.approve(admin(), {
        applicationId: holderApp, revision: 1, verificationMethod: 'id_document', verificationNote: '', reason: '', cohortId: cohort115, requestId: requestId(),
      }),
    ).toMatchObject({ ok: true })
    // 系辦人工核准的學生不是自動開通（「帳號已開通」頁不給他看）；待審、沒登入也都不是。
    expect(await command.autoApprovedMine(activeActor(holder, ['student']))).toBe(false)
    expect(await command.autoApprovedMine(ANON)).toBe(false)

    const cases: { tag: string; email: string; studentNo: string; name: string; password?: true }[] = [
      { tag: '(a) 密碼註冊', email: 'g10@example.com', studentNo: '411401010', name: '李小華', password: true },
      { tag: '(b) Email 不同', email: 'g11x@example.com', studentNo: '411401011', name: '李小華' },
      { tag: '(c) 學號已被占用', email: 'g12@example.com', studentNo: '411401012', name: '李小華' },
      { tag: '(d) 姓名不同', email: 'g13@example.com', studentNo: '411401013', name: '李小花' },
      { tag: '(e) +suffix', email: 'g14+x@example.com', studentNo: '411401014', name: '李小華' },
      { tag: '(f) 全形 g', email: 'ｇ15@example.com', studentNo: '411401015', name: '李小華' },
    ]
    for (const c of cases) {
      const userId = await pendingUser(c.email, !c.password)
      const actor = c.password ? ({ ...pendingActor(userId), loginMethod: 'password' } as ResolvedActor) : googleActor(userId)
      const result = await command.reviseMine(actor, fieldsOf(c.name, c.studentNo, c.email), null)
      expect(result, c.tag).toMatchObject({ ok: true, receipt: { revision: 1 } })
      expect(result.ok && result.receipt.autoApproved, c.tag).toBeFalsy()
      expect(await stateOf(userId), c.tag).toEqual({ state: 'pending', verification_method: null, status: 'pending' })
      expect(await one(`select count(*)::int as n from student_identities where user_id = $1`, [userId]), c.tag).toEqual({ n: 0 })
    }
    expect(await one(`select count(*)::int as n from audit_events where action = 'registration.auto_approve' and payload->>'userId' = $1`, [holder])).toEqual({ n: 0 })
  })

  it('被退回後重送：就算資料完全符合也不自動開通（系辦的決定不由系統推翻）', async () => {
    await rosterRow('411401020', '李小華', 'g20@example.com')
    const userId = await pendingUser('g20@example.com')
    // 第一次送錯姓名 → 待審 → 系辦退回。
    expect(await command.reviseMine(googleActor(userId), fieldsOf('李小花', '411401020', 'g20@example.com'), null)).toMatchObject({ ok: true })
    const first = (await one<{ id: string }>(`select id from registration_applications where user_id = $1`, [userId])).id
    expect(await command.reject(admin(), { applicationId: first, revision: 1, reason: '姓名有誤', requestId: requestId() })).toMatchObject({ ok: true })

    const again = await command.reviseMine(googleActor(userId), fieldsOf('李小華', '411401020', 'g20@example.com'), null)
    expect(again).toMatchObject({ ok: true, receipt: { revision: 1 } })
    expect(again.ok && again.receipt.autoApproved).toBeFalsy()
    expect(await one(`select status from users where id = $1`, [userId])).toEqual({ status: 'pending' })
    expect(
      await one(`select state, verification_method from registration_applications where user_id = $1 and id <> $2`, [userId, first]),
    ).toEqual({ state: 'pending', verification_method: null })
  })

  it('並行：兩個人同時用同一個學號（Email 只差大小寫，都算相同）→ 只有一人自動開通，另一人安靜留在待審', async () => {
    await rosterRow('411401030', '李小華', 'race@example.com')
    const a = await pendingUser('race@example.com')
    const b = await pendingUser('RACE@example.com')
    const results = await Promise.all([
      command.reviseMine(googleActor(a), fieldsOf('李小華', '411401030', 'race@example.com'), null),
      command.reviseMine(googleActor(b), fieldsOf('李小華', '411401030', 'RACE@example.com'), null),
    ])
    for (const r of results) expect(r).toMatchObject({ ok: true, receipt: { revision: 1 } })
    expect(results.filter((r) => r.ok && r.receipt.autoApproved).length).toBe(1)
    const states = [await stateOf(a), await stateOf(b)].map((s) => s.state).sort()
    expect(states).toEqual(['approved', 'pending'])
    expect(await one(`select count(*)::int as n from student_identities where student_no = '411401030'`)).toEqual({ n: 1 })
    expect(
      await one(`select count(*)::int as n from audit_events where action = 'registration.auto_approve' and payload->>'userId' = any($1::text[])`, [[a, b]]),
    ).toEqual({ n: 1 })
  })

  it('未驗證 Email 的密碼帳號連「修改待審申請」也送不出（reviseMine 開頭擋，所有路徑）', async () => {
    const userId = await register({ studentNo: '411401040', appliedName: '舊帳號' })
    await one(`update users set email_verified = false where id = $1 returning id`, [userId])
    const actor = { ...pendingActor(userId), loginMethod: 'password' } as ResolvedActor
    const result = await command.reviseMine(actor, fieldsOf('舊帳號', '411401041', 'x@example.com'), 1)
    expect(result).toMatchObject({ ok: false, code: 'FORBIDDEN', message: '請先完成 Email 驗證。' })
    expect(await one(`select revision, student_no from registration_applications where user_id = $1`, [userId])).toEqual({
      revision: 1,
      student_no: '411401040',
    })
  })
})
