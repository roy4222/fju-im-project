import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool, PoolClient } from 'pg'
import { assertTestDatabaseReachable, createIsolatedDatabase, poolAsRole, type IsolatedDatabase } from '../../../test/db'
import { migratedSchema } from '../../../test/migrations'
import type { ResolvedActor } from '@/application/accounts'
import { describeGroupImportReceipt } from '@/application/groups'
import type { SignoffParticipantHook } from '@/application/signoff'
import { PgGroupImportCommand } from '@/infrastructure/groups/pg-group-import'
import { PgGroupCommand } from '@/infrastructure/groups/pg-groups'
import { PgDueWorkScheduler } from '@/infrastructure/notifications/pg-due-work-scheduler'
import { PgEventPublisher } from '@/infrastructure/notifications/pg-event-publisher'
import { PgAuditWriter } from '@/infrastructure/ops/audit-writer'
import { FsFileStorage } from '@/infrastructure/ops/file-storage'
import { PgOperationLedger } from '@/infrastructure/ops/operation-ledger'

/**
 * C3-16：系辦匯入分組（設計方案③ §6.4；AC-C3-21、22）。
 *
 * 以正式執行角色 `fju_app` 連線。加人走真的 `PgGroupCommand.addMember`，簽核 hook 用一個記錄呼叫的替身，
 * 證明「匯入加人 → 同交易讓簽核版本失效」這條路（設計方案 §16「SignoffParticipantHook」）。
 */

let owner: IsolatedDatabase
let app: Pool
let root: string
let storage: FsFileStorage
let adminId: string
const businessClock = { now: async () => new Date('2026-09-20T02:00:00Z') }

let groups: PgGroupCommand
let importer: PgGroupImportCommand
const signoffCalls: { groupId: string; cause: string }[] = []
const signoffHook: SignoffParticipantHook<PoolClient> = {
  async supersedeForParticipantChange(_tx, input) {
    signoffCalls.push({ groupId: input.groupId, cause: input.cause })
    return { supersededVersionIds: [] }
  },
  async voidForDissolution() {
    return { voidedVersionIds: [] }
  },
}

type Student = { id: string; studentNo: string; cohortId: string }

function actor(userId: string, roles: ('admin' | 'student')[], cohortId?: string): ResolvedActor {
  return {
    kind: 'authenticated',
    userId,
    roles,
    status: 'active',
    mustChangePassword: false,
    cohortMemberships: cohortId ? [{ cohortId, role: 'student' }] : [],
  }
}
const adminActor = () => actor(adminId, ['admin'])
const studentActor = (s: Student) => actor(s.id, ['student'], s.cohortId)

let seq = 0
async function newCohort(): Promise<string> {
  seq += 1
  const row = await owner.sql(
    `insert into cohorts (id, code, name, status, year_end_date, group_size_min, group_size_max, proposal_default_days, created_by_kind)
     values (gen_random_uuid(), $1, $1, 'active', '2027-06-30', 2, 5, 7, 'system') returning id`,
    [`IMP-${seq}`],
  )
  const cohortId = String(row.rows[0]!.id)
  for (const [i, [name, date]] of [
    ['成組期', '2026-09-15'],
    ['期中', '2026-11-01'],
    ['期末', '2027-01-10'],
    ['成果', '2027-03-01'],
  ].entries()) {
    await owner.sql(
      `insert into cohort_stages (id, cohort_id, seq, name, start_date, created_by_kind) values (gen_random_uuid(), $1, $2, $3, $4, 'system')`,
      [cohortId, i + 1, name, date],
    )
  }
  return cohortId
}

async function newUser(name: string): Promise<string> {
  seq += 1
  const row = await owner.sql(
    `insert into users (id, name, email, email_verified, updated_at, status)
     values (gen_random_uuid(), $1, $2, true, now(), 'active') returning id`,
    [name, `imp-${seq}@example.com`],
  )
  return String(row.rows[0]!.id)
}

async function newStudent(cohortId: string): Promise<Student> {
  seq += 1
  const studentNo = `41500${String(seq).padStart(4, '0')}`
  const id = await newUser(`匯入${seq}`)
  await owner.sql(
    `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at) values (gen_random_uuid(), $1, 'student', $2, now())`,
    [id, adminId],
  )
  await owner.sql(
    `insert into user_profiles (user_id, display_name, name_normalized, student_no, cohort_id, phone, contact_email)
     values ($1, $2, $2, $3, $4, '0912345678', $5)`,
    [id, `匯入${seq}`, studentNo, cohortId, `c-${seq}@example.com`],
  )
  await owner.sql(`insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)`, [cohortId, studentNo, id])
  return { id, studentNo, cohortId }
}

async function students(cohortId: string, n: number): Promise<Student[]> {
  const list: Student[] = []
  for (let i = 0; i < n; i += 1) list.push(await newStudent(cohortId))
  return list
}

async function propose(proposer: Student, others: Student[]): Promise<string> {
  const r = await groups.propose(studentActor(proposer), { groupType: 'general', memberStudentNos: others.map((s) => s.studentNo) }, randomUUID())
  if (!r.ok) throw new Error(`${r.code} ${r.message}`)
  return r.receipt.proposalId
}

/** 走一次真的提案＋全員確認成立一組。 */
async function establish(members: Student[]): Promise<{ id: string; code: string }> {
  const proposalId = await propose(members[0]!, members.slice(1))
  for (const m of members) {
    const r = await groups.confirm(studentActor(m), proposalId, randomUUID())
    if (!r.ok) throw new Error(`${r.code} ${r.message}`)
  }
  const row = await owner.sql(`select g.id, g.code from group_proposals p join groups g on g.id = p.established_group_id where p.id = $1`, [proposalId])
  return { id: String(row.rows[0]!.id), code: String(row.rows[0]!.code) }
}

async function upload(text: string, name = 'groups.csv'): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  const ticket = await importer.startUpload(adminActor(), { fileName: name, declaredMime: 'text/csv', declaredSize: bytes.length })
  if (!ticket.ok) throw new Error(ticket.message)
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes)
      c.close()
    },
  })
  const uploaded = await storage.upload(adminId, ticket.receipt.ticket, body, bytes.length)
  if (!uploaded.ok) throw new Error(uploaded.message)
  return uploaded.receipt.fileId
}

async function groupByCode(cohortId: string, code: string) {
  const rows = await owner.sql(
    `select id, group_type, created_by_kind, created_by_user_id from groups where cohort_id = $1 and code = $2`,
    [cohortId, code],
  )
  return rows.rows[0] as { id: string; group_type: string; created_by_kind: string; created_by_user_id: string } | undefined
}

async function memberIds(groupId: string): Promise<string[]> {
  const rows = await owner.sql('select user_id from group_memberships where group_id = $1 and valid_to is null order by user_id', [groupId])
  return rows.rows.map((r) => String(r.user_id))
}

async function eventsOf(type: string, groupId: string) {
  const rows = await owner.sql(`select recipients from domain_events where type = $1 and source_id = $2`, [type, groupId])
  return rows.rows.map((r) => [...(r.recipients as string[])].sort())
}

beforeAll(async () => {
  await assertTestDatabaseReachable()
  owner = await createIsolatedDatabase({ label: 'group_import', setup: migratedSchema })
  app = await poolAsRole(owner, 'fju_app')
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'fju-group-import-'))
  storage = new FsFileStorage({
    root: () => root,
    environmentMaxBytes: () => 100 * 1024 * 1024,
    ticketSecret: () => 'integration-secret-integration-secret',
    policies: {},
    db: () => app,
  })
  adminId = await newUser('A1')
  const ledger = new PgOperationLedger(() => app)
  groups = new PgGroupCommand({
    audit: new PgAuditWriter(),
    ledger,
    events: new PgEventPublisher(),
    dueWork: new PgDueWorkScheduler({ testKindsEnabled: false }),
    businessClock,
    signoff: signoffHook,
    pool: () => app,
  })
  importer = new PgGroupImportCommand({
    audit: new PgAuditWriter(),
    ledger,
    events: new PgEventPublisher(),
    files: storage,
    businessClock,
    groups,
    pool: () => app,
  })
})

afterAll(async () => {
  await app?.end()
  await owner?.close()
  if (root) await fs.rm(root, { recursive: true, force: true })
})

describe('匯入分組', () => {
  it('只有系辦能上傳、預覽、執行', async () => {
    const cohortId = await newCohort()
    const [s] = await students(cohortId, 1)
    const ticket = await importer.startUpload(studentActor(s!), { fileName: 'x.csv', declaredMime: 'text/csv', declaredSize: 10 })
    expect(ticket).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    const fileId = await upload(`學號,組別代碼\n${s!.studentNo},G07`)
    expect(await importer.preview(studentActor(s!), { fileId, cohortId })).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(await importer.execute(studentActor(s!), { fileId, cohortId }, randomUUID())).toMatchObject({ ok: false, code: 'FORBIDDEN' })
  })

  it('AC-C3-21：新代碼建組（第一個學號是組長、管理員直接成組）、既有代碼走 addMember（簽核 hook 被呼叫）；重送同 requestId 不重複', async () => {
    const cohortId = await newCohort()
    const g01 = await establish(await students(cohortId, 3))
    expect(g01.code).toBe('G01')
    const [a, b, c, d] = await students(cohortId, 4)
    const fileId = await upload(`學號,組別代碼,類型\n${a!.studentNo},G07,一般\n${b!.studentNo},G07\n${c!.studentNo},G01\n${d!.studentNo},G09,產學`)

    const preview = await importer.preview(adminActor(), { fileId, cohortId })
    if (!preview.ok) throw new Error(preview.message)
    expect(preview.receipt.rows.map((r) => [r.studentNo, r.kind, r.groupCode, r.leader])).toEqual([
      [a!.studentNo, 'create', 'G07', true],
      [b!.studentNo, 'create', 'G07', false],
      [c!.studentNo, 'add', 'G01', false],
      [d!.studentNo, 'create', 'G09', true],
    ])
    // 預覽不寫資料。
    expect(await groupByCode(cohortId, 'G07')).toBeUndefined()

    const requestId = randomUUID()
    signoffCalls.length = 0
    const done = await importer.execute(adminActor(), { fileId, cohortId }, requestId)
    if (!done.ok) throw new Error(done.message)
    expect(describeGroupImportReceipt(done.receipt)).toBe('已匯入：新組 2、加入 1。')
    expect(done.receipt.results.map((r) => [r.line, r.outcome])).toEqual([
      [2, 'created'],
      [3, 'created'],
      [4, 'added'],
      [5, 'created'],
    ])

    const g07 = (await groupByCode(cohortId, 'G07'))!
    expect(g07).toMatchObject({ group_type: 'general', created_by_kind: 'user', created_by_user_id: adminId })
    expect(await memberIds(g07.id)).toEqual([a!.id, b!.id].sort())
    const leader = await owner.sql('select user_id from group_leaders where group_id = $1 and valid_to is null', [g07.id])
    expect(leader.rows.map((r) => String(r.user_id))).toEqual([a!.id])
    expect(await eventsOf('group.established', g07.id)).toEqual([[a!.id, b!.id].sort()])
    // 不經建立流程、不發邀請。
    expect(Number((await owner.sql('select count(*) as n from proposal_invitations where user_id = any($1::uuid[])', [[a!.id, b!.id]])).rows[0]!.n)).toBe(0)

    const g09 = (await groupByCode(cohortId, 'G09'))!
    expect(g09.group_type).toBe('industry')

    expect(await memberIds(g01.id)).toContain(c!.id)
    const membership = await owner.sql('select removal_reason from group_memberships where group_id = $1 and user_id = $2', [g01.id, c!.id])
    expect(membership.rows[0]!.removal_reason).toBeNull()
    expect(await eventsOf('group.members_changed', g01.id)).toHaveLength(1)
    expect(signoffCalls).toEqual([{ groupId: g01.id, cause: 'member_change' }])
    const audit = await owner.sql(`select reason from audit_events where action = 'group.member.add' and target_id = $1`, [g01.id])
    expect(audit.rows.map((r) => r.reason)).toEqual(['名單匯入'])

    // 重送同一個請求編號：回第一次的結果，不多建、不多加、不多發通知。
    const again = await importer.execute(adminActor(), { fileId, cohortId }, requestId)
    if (!again.ok) throw new Error(again.message)
    expect(again.receipt.results).toEqual(done.receipt.results)
    expect(again.receipt.createdGroups).toBe(2)
    expect(Number((await owner.sql('select count(*) as n from groups where cohort_id = $1', [cohortId])).rows[0]!.n)).toBe(3)
    expect(await eventsOf('group.members_changed', g01.id)).toHaveLength(1)
    expect(await eventsOf('group.established', g07.id)).toHaveLength(1)
    expect(signoffCalls).toHaveLength(1)
    expect(Number((await owner.sql(`select count(*) as n from audit_events where action = 'group.import' and target_id = $1`, [cohortId])).rows[0]!.n)).toBe(1)

    // 用新的請求編號再跑同一份檔：全部「已在這組」，什麼都不做。
    const third = await importer.execute(adminActor(), { fileId, cohortId }, randomUUID())
    if (!third.ok) throw new Error(third.message)
    expect(third.receipt).toMatchObject({ createdGroups: 0, added: 0, skipped: 4 })
  })

  it('AC-C3-22：建立中、在別組、不在本屆、代碼格式錯、超過人數上限都跳過並寫原因；執行仍可按、只做可做的列', async () => {
    const cohortId = await newCohort()
    const other = await newCohort()
    const [e, partner] = await students(cohortId, 2)
    await propose(e!, [partner!])
    const g = await establish(await students(cohortId, 2)) // G01
    const g02Members = await students(cohortId, 2)
    const g02 = await establish(g02Members)
    expect([g.code, g02.code]).toEqual(['G01', 'G02'])
    const f = g02Members[0]!
    const [outsider] = await students(other, 1)
    const [h] = await students(cohortId, 1)
    const six = await students(cohortId, 6)
    const [ok1] = await students(cohortId, 1)
    const csv = [
      '學號,組別代碼',
      `${e!.studentNo},G08`,
      `${f.studentNo},G08`,
      `${outsider!.studentNo},G08`,
      `${h!.studentNo},G1`,
      ...six.map((s) => `${s.studentNo},G10`),
      `${ok1!.studentNo},G11`,
    ].join('\n')
    const fileId = await upload(csv)

    const preview = await importer.preview(adminActor(), { fileId, cohortId })
    if (!preview.ok) throw new Error(preview.message)
    const rows = preview.receipt.rows
    expect(rows.slice(0, 4).map((r) => [r.kind, r.message])).toEqual([
      ['conflict_proposal', '在建立中的組別裡，請先終止'],
      ['conflict_other_group', '已在 G02'],
      ['invalid', '不在本屆名單'],
      ['invalid', '代碼格式要像 G01'],
    ])
    expect(rows.slice(4, 10).map((r) => [r.kind, r.message])).toEqual(six.map(() => ['invalid', '超過每組 5 人']))
    expect(rows[10]!.kind).toBe('create')

    const done = await importer.execute(adminActor(), { fileId, cohortId }, randomUUID())
    if (!done.ok) throw new Error(done.message)
    expect(done.receipt).toMatchObject({ createdGroups: 1, added: 0, skipped: 10, failed: 0 })
    expect(done.receipt.results.filter((r) => r.outcome === 'skipped').map((r) => r.message)).toContain('在建立中的組別裡，請先終止')
    expect(await groupByCode(cohortId, 'G08')).toBeUndefined()
    expect(await groupByCode(cohortId, 'G10')).toBeUndefined()
    expect(await groupByCode(cohortId, 'G11')).toBeDefined()
    // e 還在原本的建立中組別裡，沒被動到。
    expect(Number((await owner.sql('select count(*) as n from proposal_occupancy where user_id = $1', [e!.id])).rows[0]!.n)).toBe(1)
  })

  it('一列失敗不影響別列：預覽之後有人先把學生放進別組，那一列寫原因、同組其他人照建', async () => {
    const cohortId = await newCohort()
    const [a, b, c] = await students(cohortId, 3)
    const fileId = await upload(`學號,組別代碼\n${a!.studentNo},G05\n${b!.studentNo},G05\n${c!.studentNo},G06`)
    const preview = await importer.preview(adminActor(), { fileId, cohortId })
    expect(preview.ok && preview.receipt.counts.create).toBe(3)
    // 執行重新分析：已被放進別組的人變成 conflict_other_group，其他列照做。
    const existing = await establish([b!, ...(await students(cohortId, 1))])
    const done = await importer.execute(adminActor(), { fileId, cohortId }, randomUUID())
    if (!done.ok) throw new Error(done.message)
    expect(done.receipt.results.map((r) => [r.studentNo, r.outcome, r.message])).toEqual([
      [a!.studentNo, 'created', '已建 G05・組長'],
      [b!.studentNo, 'skipped', `已在 ${existing.code}`],
      [c!.studentNo, 'created', '已建 G06・組長'],
    ])
  })
})
