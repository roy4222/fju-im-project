import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_DIRECTORY_FILTER, type AccountDirectoryCommand, type ResolvedActor } from '@/application/accounts'
import {
  assertTestDatabaseReachable,
  createIsolatedDatabase,
  poolAsRole,
  TEST_DATABASE_URL,
  type IsolatedDatabase,
} from '../../../test/db'
import { migratedSchema } from '../../../test/migrations'

/**
 * 票 40：去識別化（ACC-14；工程模組 01 §3 active → deidentified；產品模組 01 §2.5）。
 *
 * 真的 Better Auth（註冊、登入、session、封鎖）＋真的 PostgreSQL（隔離 schema），**全程以 `fju_app` 連線**：
 * 用例若需要更多權限（例如刪 accounts 或改不可變表），這裡會直接紅。
 */

const BASE_URL = 'http://127.0.0.1:3000'
const PASSWORD = 'Correct-Horse-Battery-9'

let db: IsolatedDatabase
let app: Pool
let command: AccountDirectoryCommand
let handlers: typeof import('@/infrastructure/auth/wrapper').authRouteHandlers
let resolver: import('@/application/accounts').ActorResolver
let signoffQuery: import('@/infrastructure/signoff/pg-signoff').PgSignoffQuery
let resetSignUpLimiter: () => void
let resetSignInLimiter: () => void

let cohortId: string
let admin: { userId: string; headers: Headers }
let teacherId: string

let seq = 0
const requestId = () => `40404040-4040-4040-8040-${String(++seq).padStart(12, '0')}`
const uniqueEmail = (tag: string) => `t40-${tag}-${Date.now()}-${++seq}@example.com`

function adminActor(): ResolvedActor {
  return { kind: 'authenticated', userId: admin.userId, roles: ['admin'], status: 'active', mustChangePassword: false, cohortMemberships: [] }
}
function teacherActor(): ResolvedActor {
  return { kind: 'authenticated', userId: teacherId, roles: ['teacher'], status: 'active', mustChangePassword: false, cohortMemberships: [] }
}

async function one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
  return (await db.sql(sql, params)).rows[0] as T
}
async function count(sql: string, params: unknown[] = []): Promise<number> {
  return Number((await db.sql(sql, params)).rows[0]!.n)
}

let ipSeq = 0
async function signUp(email: string, name: string): Promise<{ userId: string; cookie: string }> {
  const response = await handlers.POST(
    new Request(`${BASE_URL}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE_URL, 'x-real-ip': `198.51.100.${++ipSeq}` },
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
      headers: { 'content-type': 'application/json', origin: BASE_URL, 'x-real-ip': `198.51.100.${++ipSeq}` },
      body: JSON.stringify({ email, password: PASSWORD }),
    }),
  )
  return response.status
}

/**
 * 一個已核准、有歷史的學生：個人資料、學生角色、學號占用、註冊申請（含不可變的修改版本）、
 * 連過 Google（accounts 列帶 id_token）、組別成員、一個真的登入 session。
 */
async function student(studentNo: string, name: string) {
  const email = uniqueEmail('s')
  const { userId, cookie } = await signUp(email, name)
  await db.sql(`update users set status = 'active', name = $2 where id = $1`, [userId, name])
  await db.sql(
    `insert into user_profiles (user_id, display_name, name_normalized, student_no, department_class, cohort_id, phone, contact_email, open_to_join)
     values ($1, $2, lower($2), $3, '資管二甲', $4, '0912-000-000', $5, true)`,
    [userId, name, studentNo, cohortId, email],
  )
  await db.sql(
    `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at) values (gen_random_uuid(), $1, 'student', $2, now())`,
    [userId, admin.userId],
  )
  await db.sql(`insert into student_identities (cohort_id, student_no, user_id) values ($1, upper($2), $3)`, [cohortId, studentNo, userId])
  const application = await one<{ id: string }>(
    `insert into registration_applications
       (id, user_id, applied_name, student_no, department_class, phone, contact_email, login_email, roster_match, state,
        decided_by_user_id, decided_real_at, verification_method, created_by_kind, created_by_user_id)
     values (gen_random_uuid(), $1, $2, $3, '資管二甲', '0912-000-000', $4, $4, $5::jsonb, 'approved', $6, now(), 'id_document', 'user', $1)
     returning id`,
    [userId, name, studentNo, email, JSON.stringify({ matched: true, entry: { name, studentNo } }), admin.userId],
  )
  await db.sql(
    `insert into application_revisions (id, application_id, revision, snapshot) values (gen_random_uuid(), $1, 1, $2::jsonb)`,
    [application.id, JSON.stringify({ appliedName: name, studentNo, phone: '0912-000-000' })],
  )
  await db.sql(
    `insert into accounts (id, account_id, provider_id, user_id, id_token, access_token, scope, created_at, updated_at)
     values (gen_random_uuid(), $2, 'google', $1, 'header.payload-with-email.sig', 'ya29.token', 'openid email profile', now(), now())`,
    [userId, `google-sub-${studentNo}`],
  )
  return { userId, cookie, email, applicationId: application.id }
}

/** 一個組別＋主指導＋簽核包（版本快照裡有這位學生），`state` 是目前版本狀態。 */
async function signoffWith(studentId: string, studentName: string, studentNo: string, code: string) {
  const group = await one<{ id: string }>(
    `insert into groups (id, cohort_id, code, group_type, established_real_at, established_business_at, created_by_kind)
     values (gen_random_uuid(), $1, $2, 'general', now(), now(), 'system') returning id`,
    [cohortId, code],
  )
  await db.sql(
    `insert into group_memberships (id, group_id, cohort_id, user_id, valid_from, added_by_kind, created_at, updated_at)
     values (gen_random_uuid(), $1, $2, $3, now(), 'system', now(), now())`,
    [group.id, cohortId, studentId],
  )
  const assignment = await one<{ id: string }>(
    `insert into advisor_assignments (id, group_id, teacher_user_id, source, valid_from, assigned_by_user_id, reason)
     values (gen_random_uuid(), $1, $2, 'admin', now(), $3, '指派') returning id`,
    [group.id, teacherId, admin.userId],
  )
  const pkg = await one<{ id: string }>(
    `insert into signoff_packages (id, group_id, cohort_id, purpose, created_by_user_id)
     values (gen_random_uuid(), $1, $2, 'result_confirmation', $3) returning id`,
    [group.id, cohortId, admin.userId],
  )
  const participants = {
    students: [{ userId: studentId, displayName: studentName, studentNo, membershipId: 'm' }],
    advisor: { userId: teacherId, displayName: '老師 T1', assignmentId: assignment.id },
  }
  const version = await one<{ id: string }>(
    `insert into signoff_package_versions
       (id, package_id, version_no, content_text, content_checksum, participants, created_by_user_id, created_real_at, created_business_at)
     values (gen_random_uuid(), $1, 1, '<p>同意書</p>', encode(sha256(convert_to('<p>同意書</p>', 'UTF8')), 'hex'), $2::jsonb, $3, now(), now())
     returning id`,
    [pkg.id, JSON.stringify(participants), admin.userId],
  )
  await db.sql(`insert into signoff_version_status (version_id, state) values ($1, 'collecting')`, [version.id])
  await db.sql(`update signoff_packages set current_version_id = $2 where id = $1`, [pkg.id, version.id])
  const event = await one<{ id: string }>(
    `insert into domain_events (id, type, scope, source_type, source_id, actor_kind, occurred_real_at, occurred_business_at)
     values (gen_random_uuid(), 'test.vote', 'global', 'test', gen_random_uuid(), 'system', now(), now()) returning id`,
  )
  await db.sql(
    `insert into approvals (id, version_id, user_id, role, display_name_at, student_no_at, result, reason, login_method,
                            button_text, event_id, request_id, real_at, business_at)
     values (gen_random_uuid(), $1, $2, 'student', $3, $4, 'agree', null, 'password', '我已閱讀並同意', $5, gen_random_uuid(), now(), now())`,
    [version.id, studentId, studentName, studentNo, event.id],
  )
  return { groupId: group.id, versionId: version.id }
}

beforeAll(async () => {
  await assertTestDatabaseReachable()
  db = await createIsolatedDatabase({ label: 't40-deidentify', setup: migratedSchema })
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
  const { PgAuditWriter } = await import('@/infrastructure/ops/audit-writer')
  const { PgOperationLedger } = await import('@/infrastructure/ops/operation-ledger')
  const { PgSignoffQuery } = await import('@/infrastructure/signoff/pg-signoff')
  command = new PgAccountDirectoryCommand({ audit: new PgAuditWriter(), ledger: new PgOperationLedger(() => app), db: () => app })
  signoffQuery = new PgSignoffQuery({ pool: () => app })

  cohortId = String(
    (
      await db.sql(
        `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
         values (gen_random_uuid(), '114', '114 學年度專題', 'active', '2026-06-30', 'system') returning id`,
      )
    ).rows[0]!.id,
  )

  const a = await signUp('a1-t40@example.com', '系辦 A1')
  await db.sql(`update users set status = 'active', role = 'admin' where id = $1`, [a.userId])
  await db.sql(
    `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at) values (gen_random_uuid(), $1, 'admin', $1, now())`,
    [a.userId],
  )
  admin = { userId: a.userId, headers: new Headers({ cookie: a.cookie }) }

  const t = await signUp('t1-t40@example.com', '老師 T1')
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

describe('權限：只有系辦', () => {
  it('老師 FORBIDDEN、未登入 UNAUTHENTICATED；資料不變', async () => {
    const s = await student('0411404001', '權限甲')
    const input = { userId: s.userId, reason: '本人申請', confirmText: s.email, requestId: requestId() }
    expect(await command.previewDeidentify(teacherActor(), s.userId)).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(await command.deidentify(teacherActor(), input, { headers: admin.headers })).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(await command.deidentify({ kind: 'anonymous' }, input, { headers: admin.headers })).toMatchObject({
      ok: false,
      code: 'UNAUTHENTICATED',
    })
    expect(await one('select name, email, deidentified_at from users where id = $1', [s.userId])).toEqual({
      name: '權限甲',
      email: s.email,
      deidentified_at: null,
    })
    expect(await resolver.resolve(new Headers({ cookie: s.cookie }))).toMatchObject({ kind: 'authenticated' })
  })
})

describe('前置條件與二次確認', () => {
  it('理由必填、照打的 Email 不對都擋下，什麼都沒改', async () => {
    const s = await student('0411404011', '確認甲')
    expect(
      await command.deidentify(adminActor(), { userId: s.userId, reason: ' ', confirmText: s.email, requestId: requestId() }, { headers: admin.headers }),
    ).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    expect(
      await command.deidentify(
        adminActor(),
        { userId: s.userId, reason: '本人申請', confirmText: 'someone-else@example.com', requestId: requestId() },
        { headers: admin.headers },
      ),
    ).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', details: { field: 'confirmText' } })
    expect(await one('select deidentified_at from users where id = $1', [s.userId])).toEqual({ deidentified_at: null })
    expect(await count(`select count(*) as n from user_status_events where user_id = $1`, [s.userId])).toBe(0)
    expect(await count(`select count(*) as n from audit_events where action = 'account.deidentify' and target_id = $1`, [s.userId])).toBe(0)
  })

  it('不能對自己；待審的帳號不行', async () => {
    const me = await command.previewDeidentify(adminActor(), admin.userId)
    expect(me.ok && me.receipt.blockers).toContain('不能去識別化自己的帳號。')
    expect(
      await command.deidentify(
        adminActor(),
        { userId: admin.userId, reason: '測試', confirmText: 'a1-t40@example.com', requestId: requestId() },
        { headers: admin.headers },
      ),
    ).toMatchObject({ ok: false, code: 'FORBIDDEN' })

    const pendingEmail = uniqueEmail('p')
    const pending = await signUp(pendingEmail, '待審乙')
    await db.sql(
      `insert into registration_applications
         (id, user_id, applied_name, student_no, phone, contact_email, login_email, created_by_kind, created_by_user_id)
       values (gen_random_uuid(), $1, '待審乙', '0411404012', '0922', $2, $2, 'user', $1)`,
      [pending.userId, pendingEmail],
    )
    const preview = await command.previewDeidentify(adminActor(), pending.userId)
    expect(preview.ok && preview.receipt.blockers.join()).toMatch(/待審核/)
    expect(
      await command.deidentify(
        adminActor(),
        { userId: pending.userId, reason: '測試', confirmText: pendingEmail, requestId: requestId() },
        { headers: admin.headers },
      ),
    ).toMatchObject({ ok: false, code: 'CONFLICT' })
  })

  it('還在進行中的簽核裡就擋（先成員異動）；簽核完成後就可以', async () => {
    const s = await student('0411404021', '簽核甲')
    const { versionId } = await signoffWith(s.userId, '簽核甲', '0411404021', 'G40A')
    const preview = await command.previewDeidentify(adminActor(), s.userId)
    expect(preview.ok && preview.receipt.blockers.join()).toMatch(/G40A 進行中的簽核/)
    const blocked = await command.deidentify(
      adminActor(),
      { userId: s.userId, reason: '本人申請', confirmText: s.email, requestId: requestId() },
      { headers: admin.headers },
    )
    expect(blocked).toMatchObject({ ok: false, code: 'CONFLICT' })
    expect(await one('select deidentified_at from users where id = $1', [s.userId])).toEqual({ deidentified_at: null })

    await db.sql(`update signoff_version_status set state = 'complete', completed_real_at = now() where version_id = $1`, [versionId])
    const after = await command.previewDeidentify(adminActor(), s.userId)
    expect(after.ok && after.receipt.blockers).toEqual([])
  })
})

describe('去識別化本身（ACC-14）', () => {
  it('清個資、撤 session、寫事件與稽核；不可變紀錄與業務關聯都還在；簽核畫面改顯示代稱', async () => {
    const s = await student('0411404031', '去識別甲')
    const { versionId, groupId } = await signoffWith(s.userId, '去識別甲', '0411404031', 'G40B')
    await db.sql(`update signoff_version_status set state = 'complete', completed_real_at = now() where version_id = $1`, [versionId])
    const snapshotBefore = await one<{ snapshot: string }>(
      `select snapshot::text as snapshot from application_revisions where application_id = $1`,
      [s.applicationId],
    )
    expect(await resolver.resolve(new Headers({ cookie: s.cookie }))).toMatchObject({ kind: 'authenticated' })

    const preview = await command.previewDeidentify(adminActor(), s.userId)
    expect(preview).toMatchObject({ ok: true, receipt: { name: '去識別甲', loginEmail: s.email, studentNo: '0411404031', blockers: [] } })
    const retained = preview.ok ? Object.fromEntries(preview.receipt.retained.map((r) => [r.label, r.count])) : {}
    expect(retained).toMatchObject({ 組別成員紀錄: 1, 簽核表態: 1 })

    const rid = requestId()
    const result = await command.deidentify(
      adminActor(),
      { userId: s.userId, reason: '本人申請刪除個資', confirmText: `  ${s.email.toUpperCase()} `, requestId: rid },
      { headers: admin.headers },
    )
    expect(result).toMatchObject({ ok: true, receipt: { userId: s.userId, revocation: 'done' } })
    if (!result.ok) return
    const pseudonym = result.receipt.pseudonym
    expect(pseudonym).toMatch(/^已去識別化使用者 [0-9A-F]{6}$/)

    // 帳號列：代稱、置換 Email、停用＋deidentified_at、Better Auth 封鎖。
    const user = await one<Record<string, unknown>>(
      'select name, email, email_verified, image, status, deidentified_at is not null as deidentified, banned from users where id = $1',
      [s.userId],
    )
    expect(user).toEqual({
      name: pseudonym,
      email: `deidentified-${s.userId}@deidentified.invalid`,
      email_verified: false,
      image: null,
      status: 'disabled',
      deidentified: true,
      banned: true,
    })
    // 個人資料與註冊申請：個資清掉；屆別關聯留著。
    expect(
      await one('select display_name, student_no, department_class, phone, contact_email, open_to_join, cohort_id from user_profiles where user_id = $1', [
        s.userId,
      ]),
    ).toEqual({
      display_name: pseudonym,
      student_no: null,
      department_class: null,
      phone: null,
      contact_email: `deidentified-${s.userId}@deidentified.invalid`,
      open_to_join: false,
      cohort_id: cohortId,
    })
    expect(
      await one('select applied_name, student_no, phone, login_email, roster_match::text as roster_match, state from registration_applications where user_id = $1', [
        s.userId,
      ]),
    ).toEqual({
      applied_name: pseudonym,
      student_no: '',
      phone: '',
      login_email: `deidentified-${s.userId}@deidentified.invalid`,
      roster_match: '{}',
      state: 'approved',
    })
    // 登入方式：密碼、Google 權杖與代號都作廢（列留著，fju_app 沒有 DELETE）。
    const accounts = (await db.sql('select account_id, provider_id, password, id_token, access_token, scope from accounts where user_id = $1', [s.userId])).rows
    expect(accounts.length).toBe(2)
    for (const a of accounts) {
      expect(a).toMatchObject({ password: null, id_token: null, access_token: null, scope: null })
      expect(String(a.account_id)).toMatch(/^deidentified:/)
    }
    expect(await count(`select count(*) as n from accounts where account_id = 'google-sub-0411404031'`)).toBe(0)
    // 學號占用釋出；session 全撤；舊 cookie 下一個動作就是未登入；原 Email 登入不了。
    expect(await count('select count(*) as n from student_identities where user_id = $1', [s.userId])).toBe(0)
    expect(await count('select count(*) as n from sessions where user_id = $1', [s.userId])).toBe(0)
    expect(await resolver.resolve(new Headers({ cookie: s.cookie }))).toEqual({ kind: 'anonymous' })
    expect(await signIn(s.email)).not.toBe(200)
    expect(await count('select count(*) as n from sessions where user_id = $1', [s.userId])).toBe(0)

    // 狀態事件、撤 session 工作、稽核：有理由與操作者，沒有個資。
    expect(await one('select from_status, to_status, reason, actor_user_id from user_status_events where user_id = $1', [s.userId])).toEqual({
      from_status: 'active',
      to_status: 'deidentified',
      reason: '本人申請刪除個資',
      actor_user_id: admin.userId,
    })
    expect(await one('select kind, state, expected_user_status from session_revocations where user_id = $1', [s.userId])).toEqual({
      kind: 'revoke_all',
      state: 'done',
      expected_user_status: 'deidentified',
    })
    const audit = await one<{ reason: string; actor_user_id: string; payload: string }>(
      `select reason, actor_user_id, payload::text as payload from audit_events where action = 'account.deidentify' and target_id = $1`,
      [s.userId],
    )
    expect(audit).toMatchObject({ reason: '本人申請刪除個資', actor_user_id: admin.userId })
    const ledger = await one<{ receipt: string }>(
      `select receipt::text as receipt from operation_records where operation_kind = 'account.deidentify' and request_id = $1`,
      [rid],
    )
    for (const text of [audit.payload, ledger.receipt]) {
      expect(text).not.toContain('去識別甲')
      expect(text).not.toContain('0411404031')
      expect(text).not.toContain(s.email)
    }

    // 保留：角色、組別成員、指導、簽核表態（當時的姓名照不可變原則不改寫）、註冊申請修改版本。
    expect(await count('select count(*) as n from role_assignments where user_id = $1 and revoked_real_at is null', [s.userId])).toBe(1)
    expect(await count('select count(*) as n from group_memberships where user_id = $1 and group_id = $2', [s.userId, groupId])).toBe(1)
    expect(await one('select display_name_at, student_no_at from approvals where user_id = $1', [s.userId])).toEqual({
      display_name_at: '去識別甲',
      student_no_at: '0411404031',
    })
    expect(
      await one<{ snapshot: string }>(`select snapshot::text as snapshot from application_revisions where application_id = $1`, [s.applicationId]),
    ).toEqual(snapshotBefore)

    // 被引用的歷史：簽核畫面讀快照時換成代稱、拿掉學號。
    const detail = await signoffQuery.versionDetail(adminActor(), versionId)
    expect(detail.ok).toBe(true)
    if (detail.ok) {
      expect(detail.receipt.participants.students[0]).toMatchObject({ userId: s.userId, displayName: pseudonym, studentNo: null })
      expect(JSON.stringify(detail.receipt)).not.toContain('去識別甲')
    }

    // 列表：狀態是已去識別化，可以用狀態篩出來；原姓名搜不到。
    const listed = await command.list(adminActor(), { ...DEFAULT_DIRECTORY_FILTER, status: 'deidentified' })
    expect(listed.ok && listed.receipt.rows.find((r) => r.userId === s.userId)).toMatchObject({ name: pseudonym, status: 'deidentified', studentNo: null })
    expect(await command.list(adminActor(), { ...DEFAULT_DIRECTORY_FILTER, q: '去識別甲' })).toMatchObject({ receipt: { total: 0 } })
  })

  it('從停用狀態也能做；同一個請求重送回同一張回執，換新請求或恢復都被拒（不可逆）', async () => {
    const s = await student('0411404041', '冪等甲')
    expect(
      await command.disable(adminActor(), { userId: s.userId, reason: '休學', requestId: requestId() }, { headers: admin.headers }),
    ).toMatchObject({ ok: true })

    const rid = requestId()
    const input = { userId: s.userId, reason: '本人申請', confirmText: s.email, requestId: rid }
    const first = await command.deidentify(adminActor(), input, { headers: admin.headers })
    expect(first).toMatchObject({ ok: true })
    const replay = await command.deidentify(adminActor(), input, { headers: admin.headers })
    expect(replay).toMatchObject({ ok: true })
    if (first.ok && replay.ok) expect(replay.receipt.pseudonym).toBe(first.receipt.pseudonym)
    expect(await count(`select count(*) as n from user_status_events where user_id = $1 and to_status = 'deidentified'`, [s.userId])).toBe(1)
    expect(await one(`select from_status from user_status_events where user_id = $1 and to_status = 'deidentified'`, [s.userId])).toEqual({
      from_status: 'disabled',
    })

    // 新請求：原 Email 已經不在帳號上，照打哪個都一樣被狀態擋下。
    const again = await command.deidentify(
      adminActor(),
      { userId: s.userId, reason: '再一次', confirmText: `deidentified-${s.userId}@deidentified.invalid`, requestId: requestId() },
      { headers: admin.headers },
    )
    expect(again).toMatchObject({ ok: false, code: 'CONFLICT' })
    expect(await command.restore(adminActor(), { userId: s.userId, reason: '想恢復', requestId: requestId() }, { headers: admin.headers })).toMatchObject({
      ok: false,
      code: 'CONFLICT',
    })
    expect(await count(`select count(*) as n from audit_events where action = 'account.deidentify' and target_id = $1`, [s.userId])).toBe(1)
  })
})
