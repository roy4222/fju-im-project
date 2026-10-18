import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { assertTestDatabaseReachable, createIsolatedDatabase, poolAsRole, type IsolatedDatabase } from '../../../test/db'
import { migratedSchema } from '../../../test/migrations'
import type { ResolvedActor } from '@/application/accounts'
import type { ItemInput } from '@/application/items'
import { PgProfileEditCommand } from '@/infrastructure/accounts/pg-profile-edit'
import { PgItemCommand } from '@/infrastructure/items/pg-items'
import { PgDueWorkScheduler } from '@/infrastructure/notifications/pg-due-work-scheduler'
import { PgEventPublisher } from '@/infrastructure/notifications/pg-event-publisher'
import { PgAuditWriter } from '@/infrastructure/ops/audit-writer'
import { FsFileStorage } from '@/infrastructure/ops/file-storage'
import { PgOperationLedger } from '@/infrastructure/ops/operation-ledger'
import { PgResponsePresence } from '@/infrastructure/submissions/pg-response-presence'
import { PgSubmissionCommand } from '@/infrastructure/submissions/pg-submissions'

/**
 * C2-08：帳號列「編輯」（調屆、學生↔老師互轉；設計方案 §3.8、§3.9；AC-C2-21、22、23）。
 *
 * 全部以正式執行角色 `fju_app` 連線；作業用真用例建立與發布、繳交用真用例送出（`submission_versions` 是真的），
 * 名單就是發布時展開的那一份。業務鐘是假鐘；撤 session 用假的套件呼叫記下來（真的撤 session 在 e2e 走一次）。
 *
 * 「做完的樣子」對照：
 * 1. 調屆（AC-C2-21a）：`user_profiles` 三欄、`student_identities` 舊列不在新列在、舊屆名單移出、新屆截止前的個人收件加入、
 *    稽核 before/after；不撤 session。
 * 2. 學生 → 老師（AC-C2-21b）：student 角色撤、teacher 新增；學號占用刪、個人資料學號屆別清空；名單移出；稽核含 role；撤 session。
 * 3. 老師 → 學生（AC-C2-21c）：反過來；新屆名單加入。
 * 4. 前置不成立（AC-C2-22）：在組、有繳交、指導中、評分指派、學生缺學號屆別——都擋下，資料庫無變動。
 * 5. 學號占用（AC-C2-23）：「這個學號在 116 屆已經有人」，資料不變。
 */

let owner: IsolatedDatabase
let app: Pool
let adminId: string
let command: PgProfileEditCommand
let items: PgItemCommand
let submissions: PgSubmissionCommand
const revoked: string[] = []
const businessNow = new Date('2026-10-01T02:00:00Z')
const businessClock = { now: async () => new Date(businessNow.getTime()) }

let c115: { id: string; stageId: string }
let c116: { id: string; stageId: string }
let archived: string

const FIELDS = [{ key: 'topic', type: 'text', label: '題目', required: true }]

function adminActor(): ResolvedActor {
  return { kind: 'authenticated', userId: adminId, roles: ['admin'], status: 'active', mustChangePassword: false, cohortMemberships: [] }
}

let seq = 0

async function one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
  return (await owner.sql(sql, params)).rows[0] as T
}

async function newCohort(code: string, status = 'preparing'): Promise<{ id: string; stageId: string }> {
  const cohort = await one<{ id: string }>(
    `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
     values (gen_random_uuid(), $1, $1, $2, '2027-06-30', 'system') returning id`,
    [code, status],
  )
  const stage = await one<{ id: string }>(
    `insert into cohort_stages (id, cohort_id, seq, name, start_date, created_by_kind)
     values (gen_random_uuid(), $1, 1, '成組期', '2026-09-15', 'system') returning id`,
    [cohort.id],
  )
  return { id: cohort.id, stageId: stage.id }
}

async function newUser(name: string): Promise<string> {
  seq += 1
  const user = await one<{ id: string }>(
    `insert into users (id, name, email, email_verified, updated_at, status)
     values (gen_random_uuid(), $1, $2, true, now(), 'active') returning id`,
    [name, `pe${seq}-${Date.now()}@example.com`],
  )
  return user.id
}

async function grant(userId: string, role: string) {
  await owner.sql(
    `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at) values (gen_random_uuid(), $1, $2, $3, now())`,
    [userId, role, adminId],
  )
}

async function newStudent(name: string, cohortId: string, studentNo?: string): Promise<{ id: string; studentNo: string }> {
  const id = await newUser(name)
  const no = studentNo ?? `41190${String(++seq).padStart(4, '0')}`
  await grant(id, 'student')
  await owner.sql(
    `insert into user_profiles (user_id, display_name, name_normalized, student_no, cohort_id, contact_email, profile_completed_at)
     values ($1, $2, $2, $3, $4, $5, now())`,
    [id, name, no, cohortId, `${id}@contact.example.com`],
  )
  await owner.sql('insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)', [cohortId, no, id])
  return { id, studentNo: no }
}

async function newTeacher(name: string): Promise<string> {
  const id = await newUser(name)
  await grant(id, 'teacher')
  await owner.sql(
    `insert into user_profiles (user_id, display_name, name_normalized, contact_email, profile_completed_at) values ($1, $2, $2, $3, now())`,
    [id, name, `${id}@contact.example.com`],
  )
  return id
}

async function newGroup(cohortId: string, code: string, members: string[]): Promise<string> {
  const g = await one<{ id: string }>(
    `insert into groups (id, cohort_id, code, group_type, established_real_at, established_business_at, created_by_kind)
     values (gen_random_uuid(), $1, $2, 'general', now(), now(), 'system') returning id`,
    [cohortId, code],
  )
  for (const m of members) {
    await owner.sql(
      `insert into group_memberships (id, group_id, cohort_id, user_id, valid_from, added_by_kind) values (gen_random_uuid(), $1, $2, $3, now(), 'system')`,
      [g.id, cohortId, m],
    )
  }
  return g.id
}

function itemInput(cohortId: string, stageId: string, patch: Partial<ItemInput> = {}): ItemInput {
  return {
    cohortId,
    placement: 'submission',
    title: '作業',
    summary: '',
    body: '請交。',
    category: '',
    coverFileId: null,
    attachmentFileIds: [],
    audienceKind: 'cohort_students',
    groupIds: [],
    receiverUnit: 'individual',
    stageId,
    opensAt: '',
    dueAt: '2026-12-31T23:59',
    fields: FIELDS,
    ...patch,
  }
}

async function published(cohort: { id: string; stageId: string }, title: string, patch: Partial<ItemInput> = {}): Promise<string> {
  const created = await items.create(adminActor(), itemInput(cohort.id, cohort.stageId, { title, ...patch }), randomUUID())
  if (!created.ok) throw new Error(`${created.code} ${created.message}`)
  const done = await items.publish(adminActor(), created.receipt.itemId, created.receipt.revision, { notify: false }, randomUUID())
  if (!done.ok) throw new Error(`${done.code} ${done.message}`)
  return created.receipt.itemId
}

async function submit(studentId: string, cohortId: string, itemId: string) {
  const actor: ResolvedActor = {
    kind: 'authenticated',
    userId: studentId,
    roles: ['student'],
    status: 'active',
    mustChangePassword: false,
    cohortMemberships: [{ cohortId, role: 'student' }],
  }
  const saved = await submissions.saveDraft(actor, itemId, 0, { topic: '智慧校園' }, randomUUID())
  if (!saved.ok) throw new Error(`${saved.code} ${saved.message}`)
  const sent = await submissions.submit(actor, itemId, saved.receipt.revision, randomUUID())
  if (!sent.ok) throw new Error(`${sent.code} ${sent.message}`)
}

/** 我在名單上的目前列（item → 是否在名單上）。 */
async function currentRoster(userId: string): Promise<string[]> {
  const rows = await owner.sql(
    `select item_id from response_rosters where receiver_kind = 'user' and receiver_id = $1 and eligible_to_business_at is null order by item_id`,
    [userId],
  )
  return rows.rows.map((r) => String(r.item_id))
}

async function snapshot(userId: string) {
  return {
    profile: await one(`select display_name, student_no, cohort_id from user_profiles where user_id = $1`, [userId]),
    identities: (await owner.sql(`select cohort_id, student_no from student_identities where user_id = $1`, [userId])).rows,
    roles: (await owner.sql(`select role, revoked_real_at is null as active from role_assignments where user_id = $1 order by role, granted_real_at`, [userId])).rows,
    audits: (await one<{ n: number }>(`select count(*)::int as n from audit_events where action = 'account.profile_edit' and target_id = $1`, [userId])).n,
    roster: await currentRoster(userId),
  }
}

const edit = (userId: string, patch: { name: string; role: string | null; studentNo?: string; cohortId?: string }) =>
  command.edit(adminActor(), new Headers(), { userId, studentNo: '', cohortId: '', requestId: randomUUID(), ...patch })

beforeAll(async () => {
  await assertTestDatabaseReachable()
  owner = await createIsolatedDatabase({ label: 'c2_08_profile_edit', setup: migratedSchema })
  app = await poolAsRole(owner, 'fju_app')

  const admin = await one<{ id: string }>(
    `insert into users (id, name, email, email_verified, updated_at, status) values (gen_random_uuid(), 'A1', 'a1-pe@example.com', true, now(), 'active') returning id`,
  )
  adminId = admin.id
  await owner.sql(`insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at) values (gen_random_uuid(), $1, 'admin', $1, now())`, [adminId])

  const storage = new FsFileStorage({
    root: () => '/tmp/rv-c2-08-unused',
    environmentMaxBytes: () => 1024,
    ticketSecret: () => 'profile-edit-integration-secret-profile',
    policies: {},
    db: () => app,
  })
  items = new PgItemCommand({
    audit: new PgAuditWriter(),
    ledger: new PgOperationLedger(() => app),
    events: new PgEventPublisher(),
    dueWork: new PgDueWorkScheduler({ testKindsEnabled: false }),
    files: storage,
    responses: new PgResponsePresence(),
    businessClock,
    pool: () => app,
  })
  submissions = new PgSubmissionCommand({
    audit: new PgAuditWriter(),
    ledger: new PgOperationLedger(() => app),
    businessClock,
    files: storage,
    events: new PgEventPublisher(),
    pool: () => app,
  })
  command = new PgProfileEditCommand({
    audit: new PgAuditWriter(),
    ledger: new PgOperationLedger(() => app),
    db: () => app,
    businessClock,
    auth: {
      createUser: vi.fn(),
      setUserPassword: vi.fn(),
      revokeUserSessions: async (_headers, input) => {
        revoked.push(input.userId)
      },
    },
  })

  c115 = await newCohort('115')
  c116 = await newCohort('116')
  archived = (await newCohort('110', 'archived')).id
})

afterAll(async () => {
  await app?.end()
  await owner?.close()
})

describe('調屆（AC-C2-21a）', () => {
  it('改姓名、學號、屆別 115→116：三欄更新、占用換列、舊屆名單移出、新屆截止前的個人收件加入、稽核 before/after、不撤 session', async () => {
    const sx1 = await newStudent('SX1', c115.id)
    const old = await published(c115, '115 的作業')
    const fresh = await published(c116, '116 的作業')
    const closed = await published(c116, '116 已截止', { dueAt: '2026-09-20T23:59' }).catch(() => null)
    const groupOnly = await published(c116, '116 組別收件', { receiverUnit: 'group' })
    expect(await currentRoster(sx1.id)).toEqual([old])

    const done = await edit(sx1.id, { name: '  SX1 改名 ', role: 'student', studentNo: '411012399', cohortId: c116.id })
    expect(done).toMatchObject({ ok: true, receipt: { name: 'SX1 改名', role: 'student', cohortCode: '116', roleChanged: false } })

    const s = await snapshot(sx1.id)
    expect(s.profile).toEqual({ display_name: 'SX1 改名', student_no: '411012399', cohort_id: c116.id })
    expect(s.identities).toEqual([{ cohort_id: c116.id, student_no: '411012399' }])
    expect(s.roster).toEqual([fresh])
    expect(s.roster).not.toContain(groupOnly)
    if (closed) expect(s.roster).not.toContain(closed)
    const removed = await one<{ removed_reason: string; eligible_to_business_at: Date }>(
      `select removed_reason, eligible_to_business_at from response_rosters where item_id = $1 and receiver_id = $2`,
      [old, sx1.id],
    )
    expect(removed.removed_reason).toBe('改屆別')
    const audit = await one<{ payload: { before: Record<string, unknown>; after: Record<string, unknown> }; role: string }>(
      `select payload, role from audit_events where action = 'account.profile_edit' and target_id = $1`,
      [sx1.id],
    )
    expect(audit.payload.before).toMatchObject({ name: 'SX1', studentNo: sx1.studentNo, cohortCode: '115', role: 'student' })
    expect(audit.payload.after).toMatchObject({ name: 'SX1 改名', studentNo: '411012399', cohortCode: '116', role: 'student' })
    expect(revoked).not.toContain(sx1.id)
  })

  it('封存的屆不能改過去', async () => {
    const s = await newStudent('封存', c115.id)
    expect(await edit(s.id, { name: '封存', role: 'student', studentNo: s.studentNo, cohortId: archived })).toMatchObject({
      ok: false,
      details: { field: 'cohortId' },
    })
  })
})

describe('學生↔老師互轉（AC-C2-21b、c）', () => {
  it('學生 → 老師：student 撤、teacher 新增；占用刪、學號屆別清空；名單移出；稽核含 role；撤 session', async () => {
    const sx = await newStudent('SX1b', c116.id)
    await published(c116, '116 作業 b')
    expect((await currentRoster(sx.id)).length).toBeGreaterThan(0)

    const done = await edit(sx.id, { name: 'SX1b', role: 'teacher' })
    expect(done).toMatchObject({ ok: true, receipt: { role: 'teacher', roleChanged: true } })

    const s = await snapshot(sx.id)
    expect(s.roles).toEqual([
      { role: 'student', active: false },
      { role: 'teacher', active: true },
    ])
    expect(s.identities).toEqual([])
    expect(s.profile).toMatchObject({ student_no: null, cohort_id: null })
    expect(s.roster).toEqual([])
    const audit = await one<{ payload: { before: { role: string }; after: { role: string } } }>(
      `select payload from audit_events where action = 'account.profile_edit' and target_id = $1`,
      [sx.id],
    )
    expect([audit.payload.before.role, audit.payload.after.role]).toEqual(['student', 'teacher'])
    expect(revoked).toContain(sx.id)
    // 重登落在老師後台（不被送去老師補資料頁）：學生原本就補過資料。
    expect(await one(`select profile_completed_at is not null as done from user_profiles where user_id = $1`, [sx.id])).toEqual({ done: true })
  })

  it('老師 → 學生：teacher 撤、student 新增；占用插、個人資料寫入；新屆名單加入；撤 session', async () => {
    const t2 = await newTeacher('T2')
    const item = await published(c116, '116 作業 c')

    const done = await edit(t2, { name: 'T2', role: 'student', studentNo: '411099001', cohortId: c116.id })
    expect(done).toMatchObject({ ok: true, receipt: { role: 'student', cohortCode: '116', roleChanged: true } })

    const s = await snapshot(t2)
    expect(s.roles).toEqual([
      { role: 'student', active: true },
      { role: 'teacher', active: false },
    ])
    expect(s.identities).toEqual([{ cohort_id: c116.id, student_no: '411099001' }])
    expect(s.profile).toMatchObject({ student_no: '411099001', cohort_id: c116.id })
    expect(s.roster).toContain(item)
    expect(revoked).toContain(t2)
  })

  it('還沒補資料的老師（沒有 user_profiles）也能改成學生：補一列個人資料', async () => {
    const id = await newUser('沒資料老師')
    await grant(id, 'teacher')
    expect(await edit(id, { name: '沒資料老師', role: 'student', studentNo: '411099002', cohortId: c116.id })).toMatchObject({ ok: true })
    expect((await snapshot(id)).profile).toMatchObject({ display_name: '沒資料老師', student_no: '411099002', cohort_id: c116.id })
  })
})

describe('前置不成立（AC-C2-22）：擋下，資料庫無變動', () => {
  it('(a) 在 115 屆第 3 組：屆別不能改（姓名、學號仍可改）；(a′) 也不能改成老師', async () => {
    const sx = await newStudent('SX在組', c115.id)
    const groupId = await newGroup(c115.id, '第 3 組', [sx.id])

    const view = await command.view(adminActor(), sx.id)
    expect(view).toMatchObject({
      ok: true,
      receipt: {
        role: 'student',
        cohortLock: { reason: '他在 115 屆第 3 組，先到分組把他移出才能改屆別', groupId },
        toTeacherBlocked: '他在 115 屆第 3 組，不能改成老師',
      },
    })
    if (view.ok) expect(view.receipt.cohorts.map((c) => c.code)).not.toContain('110')

    const before = await snapshot(sx.id)
    expect(await edit(sx.id, { name: 'SX在組', role: 'student', studentNo: sx.studentNo, cohortId: c116.id })).toMatchObject({
      ok: false,
      message: '他在 115 屆第 3 組，先到分組把他移出才能改屆別',
    })
    expect(await edit(sx.id, { name: 'SX在組', role: 'teacher' })).toMatchObject({ ok: false, message: '他在 115 屆第 3 組，不能改成老師' })
    expect(await snapshot(sx.id)).toEqual(before)

    // 姓名、學號在同一屆裡仍可改。
    expect(await edit(sx.id, { name: 'SX在組改名', role: 'student', studentNo: '411012398', cohortId: c115.id })).toMatchObject({ ok: true })
    expect((await snapshot(sx.id)).identities).toEqual([{ cohort_id: c115.id, student_no: '411012398' }])
  })

  it('(b) 沒有組別但有 2 筆繳交紀錄：不能改成老師', async () => {
    const sx2 = await newStudent('SX2', c115.id)
    await submit(sx2.id, c115.id, await published(c115, '115 繳交一'))
    await submit(sx2.id, c115.id, await published(c115, '115 繳交二'))
    const view = await command.view(adminActor(), sx2.id)
    expect(view).toMatchObject({ ok: true, receipt: { cohortLock: null, toTeacherBlocked: '有 2 筆繳交紀錄，不能改成老師' } })
    const before = await snapshot(sx2.id)
    expect(await edit(sx2.id, { name: 'SX2', role: 'teacher' })).toMatchObject({ ok: false, message: '有 2 筆繳交紀錄，不能改成老師' })
    expect(await snapshot(sx2.id)).toEqual(before)
  })

  it('(c) 老師指導中 1 組、有 3 筆有效評分指派：不能改成學生', async () => {
    const t1 = await newTeacher('T1')
    const groups = [await newGroup(c115.id, `T1組${++seq}`, []), await newGroup(c115.id, `T1組${++seq}`, []), await newGroup(c115.id, `T1組${++seq}`, [])]
    await owner.sql(
      `insert into advisor_assignments (id, group_id, teacher_user_id, source, valid_from, assigned_by_user_id, reason)
       values (gen_random_uuid(), $1, $2, 'admin', now(), $3, '抽籤結果')`,
      [groups[0], t1, adminId],
    )
    for (const g of groups) {
      await owner.sql(
        `insert into evaluator_assignments (id, group_id, stage_key, teacher_user_id, valid_from, assigned_by_user_id) values (gen_random_uuid(), $1, 's1', $2, now(), $3)`,
        [g, t1, adminId],
      )
    }
    const view = await command.view(adminActor(), t1)
    expect(view).toMatchObject({ ok: true, receipt: { role: 'teacher', toStudentBlocked: '他指導中 1 組、有 3 筆評分指派，不能改成學生' } })
    const before = await snapshot(t1)
    expect(await edit(t1, { name: 'T1', role: 'student', studentNo: '411099009', cohortId: c116.id })).toMatchObject({
      ok: false,
      message: '他指導中 1 組、有 3 筆評分指派，不能改成學生',
    })
    expect(await snapshot(t1)).toEqual(before)
  })

  it('(d) 老師改學生、學號留空：「學生要有學號和屆別」', async () => {
    const t = await newTeacher('T2d')
    const before = await snapshot(t)
    expect(await edit(t, { name: 'T2d', role: 'student', studentNo: '', cohortId: c116.id })).toMatchObject({ ok: false, message: '學生要有學號和屆別' })
    expect(await snapshot(t)).toEqual(before)
  })

  it('管理員不能直接改成學生（先取消管理員）；自己、停用的人不能編輯', async () => {
    const t = await newTeacher('兼管理員')
    await grant(t, 'admin')
    expect(await edit(t, { name: '兼管理員', role: 'student', studentNo: '411099010', cohortId: c116.id })).toMatchObject({
      ok: false,
      message: '管理員不能改成學生；請先取消管理員。',
    })
    expect(await edit(adminId, { name: 'A1', role: null })).toMatchObject({ ok: false, message: '自己的資料請到我的帳號改' })
    const d = await newTeacher('停用的')
    await owner.sql(`update users set status = 'disabled' where id = $1`, [d])
    expect(await command.view(adminActor(), d)).toMatchObject({ ok: false, message: '已停用，先恢復才能編輯' })
  })

  it('不是管理員不能讀也不能存', async () => {
    const t = await newTeacher('旁觀')
    const teacher: ResolvedActor = { kind: 'authenticated', userId: t, roles: ['teacher'], status: 'active', mustChangePassword: false, cohortMemberships: [] }
    expect(await command.view(teacher, t)).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(await command.edit(teacher, new Headers(), { userId: t, name: 'x', role: 'teacher', studentNo: '', cohortId: '', requestId: randomUUID() })).toMatchObject({
      ok: false,
      code: 'FORBIDDEN',
    })
  })
})

describe('學號占用（AC-C2-23）', () => {
  it('116 屆已有 411012345：另一人改成 411012345／116 → 「這個學號在 116 屆已經有人」，資料不變', async () => {
    await newStudent('占用者', c116.id, '411012345')
    const other = await newStudent('另一人', c115.id)
    const before = await snapshot(other.id)
    expect(await edit(other.id, { name: '另一人', role: 'student', studentNo: '411012345', cohortId: c116.id })).toMatchObject({
      ok: false,
      code: 'CONFLICT',
      message: '這個學號在 116 屆已經有人',
    })
    expect(await snapshot(other.id)).toEqual(before)
  })

  it('同一個請求編號重送只做一次', async () => {
    const s = await newStudent('重送', c115.id)
    const input = { userId: s.id, name: '重送改名', role: 'student', studentNo: s.studentNo, cohortId: c115.id, requestId: randomUUID() }
    expect(await command.edit(adminActor(), new Headers(), input)).toMatchObject({ ok: true })
    expect(await command.edit(adminActor(), new Headers(), input)).toMatchObject({ ok: true, receipt: { name: '重送改名' } })
    expect((await snapshot(s.id)).audits).toBe(1)
  })
})
