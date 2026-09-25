import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assertTestDatabaseReachable, createIsolatedDatabase, poolAsRole, type IsolatedDatabase } from '../../../test/db'
import { migratedSchema } from '../../../test/migrations'
import type { ResolvedActor } from '@/application/accounts'
import type { ItemInput } from '@/application/items'
import { completionOf } from '@/application/submissions'
import { PgItemCommand } from '@/infrastructure/items/pg-items'
import { PgDueWorkScheduler } from '@/infrastructure/notifications/pg-due-work-scheduler'
import { PgEventPublisher } from '@/infrastructure/notifications/pg-event-publisher'
import { PgAuditWriter } from '@/infrastructure/ops/audit-writer'
import { FsFileStorage } from '@/infrastructure/ops/file-storage'
import { PgOperationLedger } from '@/infrastructure/ops/operation-ledger'
import { PgAdvisorSubmissionQuery } from '@/infrastructure/submissions/pg-advisor-submissions'
import { PgResponsePresence } from '@/infrastructure/submissions/pg-response-presence'
import { PgRosterQuery } from '@/infrastructure/submissions/pg-roster'
import { PgSubmissionCommand, PgSubmissionQuery } from '@/infrastructure/submissions/pg-submissions'
import { createSubmissionFilePolicy } from '@/infrastructure/submissions/submission-file-policy'

/**
 * 票 22（#233）：繳交歷史、老師繳交矩陣與下載授權。「做完的樣子」四條：
 *
 * 1. 全組、目前主指導、系辦看到同一份版本歷史；名單頁組別完成率（同組算一份）。
 * 2. 附件只有本組有效組員、目前主指導、系辦能下載；別組、換掉的老師、被移出的人（移出後的版本）被拒。
 * 3. 老師矩陣只列自己**目前**指導的組別 × 收件項目狀態。
 * 4. 被移出的人只看得到自己還在組裡時的版本（`membership_snapshot`）；個人回答老師預設看不到，
 *    管理員開了主指導閱覽（SUB-24）才看得到正式版本。
 *
 * 全部以正式執行角色 `fju_app` 連線、真的檔案系統、真的業務用例（項目用票 15 的用例發布、繳交用票 17／21 的用例送出）；
 * 組別、成員異動、主指導直接寫表（它們的用例在票 13／14／19 測過）。
 */

let owner: IsolatedDatabase
let app: Pool
let root: string
let storage: FsFileStorage
let adminId: string
let t1: string
let t3: string
const businessClock = { now: async () => new Date('2026-10-01T02:00:00Z') }

let items: PgItemCommand
let submissions: PgSubmissionCommand
let query: PgSubmissionQuery
let rosterQuery: PgRosterQuery
let advisor: PgAdvisorSubmissionQuery

type Person = { id: string; name: string; cohortId: string }

function actorOf(userId: string, roles: ('admin' | 'teacher' | 'student')[]): ResolvedActor {
  return { kind: 'authenticated', userId, roles, status: 'active', mustChangePassword: false, cohortMemberships: [] }
}
const adminActor = () => actorOf(adminId, ['admin'])
const studentActor = (s: Person) => actorOf(s.id, ['student'])
const teacherActor = (id: string) => actorOf(id, ['teacher'])

let seq = 0
async function newUser(name: string, role: 'student' | 'teacher' | 'admin'): Promise<string> {
  seq += 1
  const user = await owner.sql(
    `insert into users (id, name, email, email_verified, updated_at, status)
     values (gen_random_uuid(), $1, $2, true, now(), 'active') returning id`,
    [name, `g22-${seq}@example.com`],
  )
  const id = String(user.rows[0]!.id)
  await owner.sql(
    `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at)
     values (gen_random_uuid(), $1, $2, $1, now())`,
    [id, role],
  )
  return id
}

async function newCohort(): Promise<{ cohortId: string; stageId: string }> {
  seq += 1
  const cohort = await owner.sql(
    `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
     values (gen_random_uuid(), $1, $1, 'active', '2027-06-30', 'system') returning id`,
    [`G22-${seq}`],
  )
  const cohortId = String(cohort.rows[0]!.id)
  const stage = await owner.sql(
    `insert into cohort_stages (id, cohort_id, seq, name, start_date, created_by_kind)
     values (gen_random_uuid(), $1, 1, '期中', '2026-09-15', 'system') returning id`,
    [cohortId],
  )
  return { cohortId, stageId: String(stage.rows[0]!.id) }
}

async function newStudent(cohortId: string, name: string): Promise<Person> {
  const id = await newUser(name, 'student')
  const studentNo = `41722${String(seq).padStart(4, '0')}`
  await owner.sql(
    `insert into user_profiles (user_id, display_name, name_normalized, student_no, cohort_id, contact_email)
     values ($1, $2, $2, $3, $4, $5)`,
    [id, name, studentNo, cohortId, `g22-${seq}@contact.example.com`],
  )
  await owner.sql('insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)', [cohortId, studentNo, id])
  return { id, name, cohortId }
}

async function newGroup(cohortId: string, code: string, members: Person[], advisorId?: string): Promise<string> {
  const group = await owner.sql(
    `insert into groups (id, cohort_id, code, group_type, established_real_at, established_business_at, created_by_kind)
     values (gen_random_uuid(), $1, $2, 'general', now(), now(), 'system') returning id`,
    [cohortId, code],
  )
  const groupId = String(group.rows[0]!.id)
  for (const m of members) await addMember(groupId, m)
  await owner.sql(
    `insert into group_leaders (id, group_id, user_id, valid_from, changed_by_user_id) values (gen_random_uuid(), $1, $2, now(), $2)`,
    [groupId, members[0]!.id],
  )
  if (advisorId) await assignAdvisor(groupId, advisorId)
  return groupId
}

async function addMember(groupId: string, m: Person) {
  await owner.sql(
    `insert into group_memberships (id, group_id, cohort_id, user_id, valid_from, added_by_kind)
     values (gen_random_uuid(), $1, $2, $3, now(), 'system')`,
    [groupId, m.cohortId, m.id],
  )
}

async function removeMember(groupId: string, m: Person) {
  await owner.sql(
    `update group_memberships set valid_to = now(), removal_reason = '轉組' where group_id = $1 and user_id = $2 and valid_to is null`,
    [groupId, m.id],
  )
}

/** 指派或重派主指導（重派＝結束舊列＋插新列，跟 `pg-advisors` 同一個形狀）。 */
async function assignAdvisor(groupId: string, teacherId: string) {
  await owner.sql(
    `update advisor_assignments set valid_to = now(), ended_real_at = now(), ended_by_user_id = $2, end_reason = '重派'
      where group_id = $1 and valid_to is null`,
    [groupId, adminId],
  )
  await owner.sql(
    `insert into advisor_assignments (id, group_id, teacher_user_id, source, valid_from, assigned_by_user_id, reason)
     values (gen_random_uuid(), $1, $2, 'admin', now(), $3, '指派')`,
    [groupId, teacherId, adminId],
  )
}

const GROUP_FIELDS = [
  { key: 'topic', type: 'text', label: '題目', required: true },
  { key: 'report', type: 'file', label: '期中報告', required: true, fileRules: { allowedTypes: ['pdf'], maxMiB: 1 } },
]
const PERSONAL_FIELDS = [{ key: 'wish', type: 'textarea', label: '想請老師注意的事', required: true }]

function input(cohortId: string, stageId: string, patch: Partial<ItemInput> = {}): ItemInput {
  return {
    cohortId,
    placement: 'submission',
    title: '期中報告繳交',
    summary: '',
    body: '請上傳期中報告。',
    category: '',
    coverFileId: null,
    attachmentFileIds: [],
    audienceKind: 'cohort_students',
    groupIds: [],
    receiverUnit: 'group',
    stageId,
    opensAt: '',
    dueAt: '2026-11-15T23:59',
    fields: GROUP_FIELDS,
    ...patch,
  }
}

async function created(cohortId: string, stageId: string, patch: Partial<ItemInput> = {}) {
  const made = await items.create(adminActor(), input(cohortId, stageId, patch), randomUUID())
  if (!made.ok) throw new Error(`${made.code} ${made.message}`)
  return made.receipt
}

async function publish(itemId: string, revision: number) {
  const done = await items.publish(adminActor(), itemId, revision, { notify: false }, randomUUID())
  if (!done.ok) throw new Error(`${done.code} ${done.message}`)
}

async function published(cohortId: string, stageId: string, patch: Partial<ItemInput> = {}): Promise<string> {
  const made = await created(cohortId, stageId, patch)
  await publish(made.itemId, made.revision)
  return made.itemId
}

const PDF = new TextEncoder().encode('%PDF-1.7\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n')

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

async function mustUpload(s: Person, itemId: string, name: string, bytes: Uint8Array): Promise<string> {
  const ticket = await submissions.requestUpload(studentActor(s), itemId, 'report', { fileName: name, declaredMime: 'application/pdf', declaredSize: bytes.length })
  if (!ticket.ok) throw new Error(`${ticket.code} ${ticket.message}`)
  const result = await storage.upload(s.id, ticket.receipt.ticket, streamOf(bytes), bytes.length)
  if (!result.ok) throw new Error(`${result.code} ${result.message}`)
  return (result.receipt as { fileId: string }).fileId
}

/** 存草稿（照資料庫裡的版本號）再正式送出。回送出的版本號。 */
async function saveAndSubmit(s: Person, itemId: string, answers: Record<string, string>): Promise<number> {
  const current = (await query.myItem(s.id, itemId))?.draft?.revision ?? 0
  const saved = await submissions.saveDraft(studentActor(s), itemId, current, answers, randomUUID())
  if (!saved.ok) throw new Error(`${saved.code} ${saved.message}`)
  const sent = await submissions.submit(studentActor(s), itemId, saved.receipt.revision, randomUUID())
  if (!sent.ok) throw new Error(`${sent.code} ${sent.message}`)
  return sent.receipt.versionNo
}

async function download(actor: ResolvedActor, fileId: string) {
  const result = await storage.authorizeDownload(actor, fileId)
  if (result.ok) await result.receipt.body.cancel()
  return result.ok ? 'ok' : result.code
}

async function versionFile(itemId: string, receiverId: string, versionNo: number): Promise<string> {
  const found = await owner.sql(
    `select sf.file_id from submission_files sf join submission_versions v on v.id = sf.submission_version_id
      where v.item_id = $1 and v.receiver_id = $2 and v.version_no = $3`,
    [itemId, receiverId, versionNo],
  )
  return String(found.rows[0]!.file_id)
}

/**
 * 一屆：G1（S1 組長、S2，主指導 T1）、G2（S6，主指導 T3）；一份整組收件。
 * G1 送兩版（S1 送 v1、S2 換檔送 v2）；G2 送一版。
 */
async function groupScenario() {
  const { cohortId, stageId } = await newCohort()
  const s1 = await newStudent(cohortId, '組長小明')
  const s2 = await newStudent(cohortId, '組員小華')
  const s6 = await newStudent(cohortId, '別組小美')
  seq += 1
  const g1 = await newGroup(cohortId, `G1-${seq}`, [s1, s2], t1)
  const g2 = await newGroup(cohortId, `G2-${seq}`, [s6], t3)
  const itemId = await published(cohortId, stageId)
  const f1 = await mustUpload(s1, itemId, 'v1.pdf', PDF)
  await saveAndSubmit(s1, itemId, { topic: '智慧校園', report: f1 })
  const f2 = await mustUpload(s2, itemId, 'v2.pdf', PDF)
  await saveAndSubmit(s2, itemId, { topic: '智慧校園 2.0', report: f2 })
  const f6 = await mustUpload(s6, itemId, 'g2.pdf', PDF)
  await saveAndSubmit(s6, itemId, { topic: '別組題目', report: f6 })
  return { cohortId, stageId, s1, s2, s6, g1, g2, itemId, f1, f2, f6 }
}

beforeAll(async () => {
  await assertTestDatabaseReachable()
  owner = await createIsolatedDatabase({ label: 'history-matrix', setup: migratedSchema })
  app = await poolAsRole(owner, 'fju_app')
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'fju-history-files-'))
  adminId = await newUser('系辦', 'admin')
  t1 = await newUser('王老師', 'teacher')
  t3 = await newUser('李老師', 'teacher')

  storage = new FsFileStorage({
    root: () => root,
    environmentMaxBytes: () => 100 * 1024 * 1024,
    ticketSecret: () => 'history-matrix-secret-history-matrix-secret',
    policies: { submission: createSubmissionFilePolicy(() => app) },
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
  query = new PgSubmissionQuery(() => app)
  rosterQuery = new PgRosterQuery(() => app)
  advisor = new PgAdvisorSubmissionQuery(() => app)
})

afterAll(async () => {
  await app?.end()
  await owner?.close()
  await fs.rm(root, { recursive: true, force: true })
})

describe('1. 全組、目前主指導、系辦看到同一份版本歷史；組別完成率同組算一份', () => {
  it('組員、主指導、系辦拿到的版本列表與每一版的內容完全相同', async () => {
    const { s1, s2, g1, itemId } = await groupScenario()
    const byStudent = (await query.myItem(s2.id, itemId))!.versions
    const byAdmin = (await rosterQuery.receiver(adminActor(), itemId, g1))!.versions
    const byTeacher = (await advisor.receiver(teacherActor(t1), itemId, g1))!.versions
    expect(byStudent.map((v) => v.versionNo)).toEqual([2, 1])
    expect(byTeacher).toEqual(byStudent)
    expect(byAdmin).toEqual(byStudent)
    expect(byStudent.map((v) => v.submittedByName)).toEqual(['組員小華', '組長小明'])

    for (const no of [1, 2]) {
      const student = await query.myVersion(s1.id, itemId, no)
      expect(await advisor.receiverVersion(teacherActor(t1), itemId, g1, no)).toEqual(student)
      expect(await rosterQuery.receiverVersion(adminActor(), itemId, g1, no)).toEqual(student)
      expect(student!.files).toHaveLength(1)
    }
  })

  it('名單頁完成率以組為單位：G1 送兩版、G2 送一版＝2／2；老師看自己的組也同一個口徑', async () => {
    const { itemId } = await groupScenario()
    const roster = (await rosterQuery.roster(adminActor(), itemId))!
    expect(roster.entries).toHaveLength(2)
    expect(completionOf(roster.item, roster.entries, await businessClock.now())).toMatchObject({ required: 2, done: 2, percent: 100 })
    const mine = (await advisor.item(teacherActor(t1), itemId))!
    expect(mine.entries).toHaveLength(1)
    expect(completionOf(mine.item, mine.entries, await businessClock.now())).toMatchObject({ required: 1, done: 1 })
  })
})

describe('2. 附件下載授權（逐角色）', () => {
  it('本組組員、目前主指導、系辦可以；別組學生、別組老師不行', async () => {
    const { s1, s2, s6, f1, f2, f6 } = await groupScenario()
    for (const fileId of [f1, f2]) {
      expect(await download(studentActor(s1), fileId)).toBe('ok')
      expect(await download(studentActor(s2), fileId)).toBe('ok')
      expect(await download(teacherActor(t1), fileId)).toBe('ok')
      expect(await download(adminActor(), fileId)).toBe('ok')
      expect(await download(studentActor(s6), fileId)).toBe('FORBIDDEN')
      expect(await download(teacherActor(t3), fileId)).toBe('FORBIDDEN')
    }
    expect(await download(teacherActor(t3), f6)).toBe('ok')
    expect(await download(teacherActor(t1), f6)).toBe('FORBIDDEN')
  })

  it('換老師：舊老師立刻看不到版本、下載 403、矩陣裡沒有這組；新老師接手看得到', async () => {
    const { g1, itemId, f1 } = await groupScenario()
    await assignAdvisor(g1, t3)
    expect(await download(teacherActor(t1), f1)).toBe('FORBIDDEN')
    expect(await advisor.receiver(teacherActor(t1), itemId, g1)).toBeNull()
    expect(await advisor.receiverVersion(teacherActor(t1), itemId, g1, 1)).toBeNull()
    expect((await advisor.matrix(teacherActor(t1)))!.groups.map((g) => g.groupId)).not.toContain(g1)

    expect(await download(teacherActor(t3), f1)).toBe('ok')
    expect((await advisor.receiver(teacherActor(t3), itemId, g1))!.versions.map((v) => v.versionNo)).toEqual([2, 1])
    expect((await advisor.matrix(teacherActor(t3)))!.groups.map((g) => g.groupId)).toContain(g1)
  })

  it('老師列得出來的版本＝下載得到附件的版本（列表與下載同一個規則）', async () => {
    const { g1, g2, itemId } = await groupScenario()
    for (const teacher of [t1, t3]) {
      for (const group of [g1, g2]) {
        const listed = new Set((await advisor.receiver(teacherActor(teacher), itemId, group))?.versions.map((v) => v.versionNo) ?? [])
        const all = await owner.sql('select version_no from submission_versions where item_id = $1 and receiver_id = $2', [itemId, group])
        for (const { version_no } of all.rows as { version_no: number }[]) {
          const fileId = await versionFile(itemId, group, version_no)
          expect(await download(teacherActor(teacher), fileId)).toBe(listed.has(version_no) ? 'ok' : 'FORBIDDEN')
          expect((await advisor.receiverVersion(teacherActor(teacher), itemId, group, version_no)) !== null).toBe(listed.has(version_no))
        }
      }
    }
  })

  it('單一版本跟列表走同一條路：收件下架後列表拿不到，直接打版本也拿不到（不靠頁面先呼叫 receiver 擋；PR #267 審查建議）', async () => {
    const { g1, itemId } = await groupScenario()
    expect(await advisor.receiverVersion(teacherActor(t1), itemId, g1, 1)).not.toBeNull()
    const revision = Number((await owner.sql('select revision from managed_items where id = $1', [itemId])).rows[0]!.revision)
    const archived = await items.changeStatus(adminActor(), itemId, revision, 'archive', randomUUID())
    expect(archived.ok).toBe(true)
    expect(await advisor.receiver(teacherActor(t1), itemId, g1)).toBeNull()
    expect(await advisor.receiverVersion(teacherActor(t1), itemId, g1, 1)).toBeNull()
    // 系辦仍看得到（名單頁不受老師範圍影響）。
    expect(await rosterQuery.receiverVersion(adminActor(), itemId, g1, 1)).not.toBeNull()
  })

  it('整組一份與個人一份同一個規則：此刻在這一屆沒指導任何組＝null（404）；有指導組但都不在名單上＝空名單（PR #267 審查建議）', async () => {
    const { cohortId, stageId, g1, g2 } = await groupScenario()
    // 只收 G2 的整組收件：T1 在這一屆有指導 G1，但 G1 不在名單上 → 空名單，不是 404；直接打 G2 拿不到。
    const onlyG2 = await published(cohortId, stageId, { audienceKind: 'groups', groupIds: [g2], title: '只收 G2' })
    expect(await advisor.item(teacherActor(t1), onlyG2)).toMatchObject({ entries: [] })
    expect(await advisor.receiver(teacherActor(t1), onlyG2, g2)).toBeNull()
    expect(await advisor.receiver(teacherActor(t1), onlyG2, g1)).toBeNull()
    // 這一屆沒指導任何組的老師：整組一份、個人一份都是 null。
    const outsider = await newUser('別屆老師', 'teacher')
    expect(await advisor.item(teacherActor(outsider), onlyG2)).toBeNull()
    const personal = await created(cohortId, stageId, { receiverUnit: 'individual', title: '個人意向', fields: PERSONAL_FIELDS })
    expect((await submissions.setAdvisorVisibility(adminActor(), personal.itemId, true, randomUUID())).ok).toBe(true)
    await publish(personal.itemId, personal.revision)
    expect(await advisor.item(teacherActor(outsider), personal.itemId)).toBeNull()
    expect((await advisor.item(teacherActor(t1), personal.itemId))!.entries.length).toBeGreaterThan(0)
  })

  it('學生、管理員拿老師查詢一律 null（老師查詢只給老師）', async () => {
    const { s1, g1, itemId } = await groupScenario()
    expect(await advisor.matrix(studentActor(s1))).toBeNull()
    expect(await advisor.item(adminActor(), itemId)).toBeNull()
    expect(await advisor.receiver(studentActor(s1), itemId, g1)).toBeNull()
  })
})

describe('3. 老師矩陣只列自己目前指導的組別 × 收件項目', () => {
  it('T1 只看到 G1、看不到 G2；格子是那一組的最後一版；有草稿也不透露（hasDraft 一律 false）', async () => {
    const { cohortId, s1, g1, g2, itemId } = await groupScenario()
    // G1 在送出之後又存了一份草稿：老師那邊不能看出來。
    const revision = (await query.myItem(s1.id, itemId))!.draft!.revision
    const saved = await submissions.saveDraft(studentActor(s1), itemId, revision, { topic: '還在改' }, randomUUID())
    expect(saved.ok).toBe(true)

    const matrix = (await advisor.matrix(teacherActor(t1)))!
    // T1 在前面的情境也指導過別屆的組；這一屆只有 G1。
    const here = matrix.groups.filter((g) => g.cohortId === cohortId)
    expect(here.map((g) => g.groupId)).toEqual([g1])
    expect(here[0]!.memberNames).toEqual(expect.arrayContaining(['組長小明', '組員小華']))
    expect(matrix.items.map((i) => i.itemId)).toContain(itemId)
    const cells = matrix.cells.filter((c) => c.itemId === itemId)
    expect(cells).toEqual([expect.objectContaining({ groupId: g1, latestVersionNo: 2, latestSubmittedByName: '組員小華' })])
    expect(cells.some((c) => c.groupId === g2)).toBe(false)
    expect(Object.keys(cells[0]!)).not.toContain('hasDraft')

    const view = (await advisor.item(teacherActor(t1), itemId))!
    expect(view.entries.map((e) => [e.receiverId, e.hasDraft])).toEqual([[g1, false]])
    // 別的老師的組：直接打 receiver 也拿不到。
    expect(await advisor.receiver(teacherActor(t1), itemId, g2)).toBeNull()
  })

  it('沒指導任何組的老師：矩陣是空的；指導的組解散後也不再出現', async () => {
    const other = await newUser('沒組老師', 'teacher')
    expect(await advisor.matrix(teacherActor(other))).toEqual({ groups: [], items: [], cells: [], individualItems: [] })
    const { g1 } = await groupScenario()
    await owner.sql(`update groups set status = 'dissolved', dissolved_real_at = now(), dissolve_reason = '測試' where id = $1`, [g1])
    expect((await advisor.matrix(teacherActor(t1)))!.groups.map((g) => g.groupId)).not.toContain(g1)
  })
})

describe('4. 被移出的人只看得到自己還在組裡時的版本', () => {
  it('S2 被移出後：作業區沒有、內容頁 404；紀錄列 v1、v2，看不到移出後的 v3；v3 附件 403、共用草稿附件 403', async () => {
    const { s1, s2, s6, g1, itemId, f1, f2 } = await groupScenario()
    await removeMember(g1, s2)
    const f3 = await mustUpload(s1, itemId, 'v3.pdf', PDF)
    expect(await saveAndSubmit(s1, itemId, { topic: '移出之後', report: f3 })).toBe(3)
    const snapshot = await owner.sql(
      `select membership_snapshot from submission_versions where item_id = $1 and receiver_id = $2 and version_no = 3`,
      [itemId, g1],
    )
    expect(snapshot.rows[0]!.membership_snapshot).toEqual([s1.id])

    expect((await query.myItems(s2.id)).map((r) => r.itemId)).not.toContain(itemId)
    expect(await query.myItem(s2.id, itemId)).toBeNull()
    expect(await query.myVersion(s2.id, itemId, 1)).toBeNull()

    const records = await query.myRecords(s2.id)
    expect(records).toEqual([
      expect.objectContaining({ itemId, receiverKind: 'group', receiverId: g1, versionCount: 2, latestVersionNo: 2 }),
    ])
    const record = (await query.myRecord(s2.id, itemId, g1))!
    expect(record.versions.map((v) => v.versionNo)).toEqual([2, 1])
    expect((await query.myRecordVersion(s2.id, itemId, g1, 1))!.files.map((f) => f.fileId)).toEqual([f1])
    expect(await query.myRecordVersion(s2.id, itemId, g1, 3)).toBeNull()
    // 「是不是最新」只跟自己讀得到的比：v2 對 S2 是最新，不會顯示「已被後來的版本取代」而透露有 v3（PR #267 審查建議）。
    expect((await query.myRecordVersion(s2.id, itemId, g1, 2))!.isLatest).toBe(true)
    expect((await query.myRecordVersion(s2.id, itemId, g1, 1))!.isLatest).toBe(false)
    // 還在組裡的人讀得到全部，最新是 v3。
    expect((await query.myVersion(s1.id, itemId, 3))!.isLatest).toBe(true)
    expect((await query.myVersion(s1.id, itemId, 2))!.isLatest).toBe(false)

    expect(await download(studentActor(s2), f1)).toBe('ok')
    expect(await download(studentActor(s2), f2)).toBe('ok')
    expect(await download(studentActor(s2), f3)).toBe('FORBIDDEN')
    // 還在組裡的人看得到全部三版；別組的人紀錄是空的、直接打也拿不到。
    expect((await query.myItem(s1.id, itemId))!.versions.map((v) => v.versionNo)).toEqual([3, 2, 1])
    expect(await query.myRecords(s1.id)).toEqual([])
    expect(await query.myRecord(s6.id, itemId, g1)).toBeNull()
    expect(await query.myRecordVersion(s6.id, itemId, g1, 1)).toBeNull()
  })

  it('換到別組：舊組只剩快照裡有自己的版本，新組照有效組員看全部', async () => {
    const { cohortId, s2, g1, g2, itemId, f1, f6 } = await groupScenario()
    await removeMember(g1, s2)
    await addMember(g2, s2)
    expect((await query.myRecords(s2.id)).map((r) => [r.receiverId, r.versionCount])).toEqual([[g1, 2]])
    expect((await query.myItem(s2.id, itemId))!.group!.groupId).toBe(g2)
    expect(await download(studentActor(s2), f1)).toBe('ok')
    expect(await download(studentActor(s2), f6)).toBe('ok')
    expect(cohortId).toBeTruthy()
  })
})

describe('4. 個人回答：老師預設看不到；管理員開主指導閱覽（SUB-24）', () => {
  /** 一屆、G1（S1、S2，主指導 T1）；一份個人收件（還沒發布）。 */
  async function personalScenario() {
    const { cohortId, stageId } = await newCohort()
    const s1 = await newStudent(cohortId, '個人小明')
    const s2 = await newStudent(cohortId, '個人小華')
    seq += 1
    const g1 = await newGroup(cohortId, `P1-${seq}`, [s1, s2], t1)
    const draft = await created(cohortId, stageId, { receiverUnit: 'individual', title: '指導意向', fields: PERSONAL_FIELDS })
    return { cohortId, stageId, s1, s2, g1, itemId: draft.itemId, revision: draft.revision }
  }

  it('沒開：老師的矩陣沒有、直接打回 null；學生頁沒有告知', async () => {
    const { s1, itemId, revision } = await personalScenario()
    await publish(itemId, revision)
    await saveAndSubmit(s1, itemId, { wish: '請注意時程' })
    expect((await query.myItem(s1.id, itemId))!.advisorCanView).toBe(false)
    expect((await advisor.matrix(teacherActor(t1)))!.individualItems.map((i) => i.itemId)).not.toContain(itemId)
    expect(await advisor.item(teacherActor(t1), itemId)).toBeNull()
    expect(await advisor.receiverVersion(teacherActor(t1), itemId, s1.id, 1)).toBeNull()
  })

  it('發布前開好：學生看到告知；目前主指導看得到正式版本（不含草稿）；換老師後舊老師看不到；關閉後都看不到', async () => {
    const { s1, s2, g1, itemId, revision } = await personalScenario()
    const opened = await submissions.setAdvisorVisibility(adminActor(), itemId, true, randomUUID())
    expect(opened).toMatchObject({ ok: true, receipt: { enabled: true, effectiveFromVersionNo: 1 } })
    const audit = await owner.sql(`select action, payload from audit_events where target_id = $1 and action like 'submission.advisor_visibility.%'`, [itemId])
    expect(audit.rows).toEqual([expect.objectContaining({ action: 'submission.advisor_visibility.enable' })])
    await publish(itemId, revision)

    expect((await query.myItem(s1.id, itemId))!.advisorCanView).toBe(true)
    await saveAndSubmit(s1, itemId, { wish: '請注意時程' })
    // S2 只存草稿：老師那邊看起來是還沒交，也看不到草稿內容。
    const saved = await submissions.saveDraft(studentActor(s2), itemId, 0, { wish: '草稿' }, randomUUID())
    expect(saved.ok).toBe(true)

    const listed = (await advisor.matrix(teacherActor(t1)))!.individualItems.find((i) => i.itemId === itemId)
    expect(listed).toMatchObject({ effectiveFromVersionNo: 1, required: 2, submitted: 1 })
    const view = (await advisor.item(teacherActor(t1), itemId))!
    expect(view.entries.map((e) => [e.name, e.latestVersionNo, e.hasDraft])).toEqual(
      expect.arrayContaining([
        ['個人小明', 1, false],
        ['個人小華', null, false],
      ]),
    )
    expect((await advisor.receiverVersion(teacherActor(t1), itemId, s1.id, 1))!.answers).toEqual({ wish: '請注意時程' })
    expect(await advisor.receiverVersion(teacherActor(t3), itemId, s1.id, 1)).toBeNull()

    await assignAdvisor(g1, t3)
    expect(await advisor.receiverVersion(teacherActor(t1), itemId, s1.id, 1)).toBeNull()
    // T1 在這一屆已經沒有指導的組：跟整組一份一樣是 null（404），不是空名單。
    expect(await advisor.item(teacherActor(t1), itemId)).toBeNull()
    expect((await advisor.receiverVersion(teacherActor(t3), itemId, s1.id, 1))!.answers).toEqual({ wish: '請注意時程' })

    const closed = await submissions.setAdvisorVisibility(adminActor(), itemId, false, randomUUID())
    expect(closed).toMatchObject({ ok: true, receipt: { enabled: false } })
    expect(await advisor.receiverVersion(teacherActor(t3), itemId, s1.id, 1)).toBeNull()
    expect(await advisor.item(teacherActor(t3), itemId)).toBeNull()
    expect((await query.myItem(s2.id, itemId))!.advisorCanView).toBe(false)
  })

  it('已經有人作答就不能開（舊回答不擴權），也不插列；關掉的狀態不能再關；同一個請求重送只算一次', async () => {
    const { s1, itemId, revision } = await personalScenario()
    await publish(itemId, revision)
    const saved = await submissions.saveDraft(studentActor(s1), itemId, 0, { wish: '有人作答了' }, randomUUID())
    expect(saved.ok).toBe(true)
    const refused = await submissions.setAdvisorVisibility(adminActor(), itemId, true, randomUUID())
    expect(refused).toMatchObject({ ok: false, code: 'ITEM_HAS_RESPONSES' })
    expect(await submissions.setAdvisorVisibility(adminActor(), itemId, false, randomUUID())).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    expect((await owner.sql('select count(*) as n from advisor_visibility_settings where item_id = $1', [itemId])).rows[0]!.n).toBe('0')
    expect((await rosterQuery.advisorVisibility(adminActor(), itemId))).toEqual({ current: null, hasResponses: true })

    const fresh = await personalScenario()
    const requestId = randomUUID()
    const [a, b] = [
      await submissions.setAdvisorVisibility(adminActor(), fresh.itemId, true, requestId),
      await submissions.setAdvisorVisibility(adminActor(), fresh.itemId, true, requestId),
    ]
    expect(a).toMatchObject({ ok: true })
    expect(b).toMatchObject({ ok: true, receipt: a.ok ? a.receipt : {} })
    expect((await owner.sql('select count(*) as n from advisor_visibility_settings where item_id = $1', [fresh.itemId])).rows[0]!.n).toBe('1')
    expect(await rosterQuery.advisorVisibility(adminActor(), fresh.itemId)).toMatchObject({
      current: { enabled: true, effectiveFromVersionNo: 1, setByName: '系辦' },
      hasResponses: false,
    })
  })

  it('只有管理員能開；整組一份不能開（組別版本本來就給目前主指導）', async () => {
    const { s1, itemId } = await personalScenario()
    expect(await submissions.setAdvisorVisibility(teacherActor(t1), itemId, true, randomUUID())).toMatchObject({ code: 'FORBIDDEN' })
    expect(await submissions.setAdvisorVisibility(studentActor(s1), itemId, true, randomUUID())).toMatchObject({ code: 'FORBIDDEN' })
    expect(await rosterQuery.advisorVisibility(teacherActor(t1), itemId)).toBeNull()
    const { itemId: groupItem } = await groupScenario()
    expect(await submissions.setAdvisorVisibility(adminActor(), groupItem, true, randomUUID())).toMatchObject({ code: 'VALIDATION_FAILED' })
    expect(await rosterQuery.advisorVisibility(adminActor(), groupItem)).toBeNull()
  })

  it('被移出個人收件名單的人：作業區沒有，紀錄裡唯讀自己的回答', async () => {
    const { s1, itemId, revision } = await personalScenario()
    await publish(itemId, revision)
    await saveAndSubmit(s1, itemId, { wish: '我的回答' })
    await owner.sql(
      `update response_rosters set eligible_to_business_at = eligible_from_business_at + interval '1 minute', removed_reason = '休學'
        where item_id = $1 and receiver_kind = 'user' and receiver_id = $2`,
      [itemId, s1.id],
    )
    expect((await query.myItems(s1.id)).map((r) => r.itemId)).not.toContain(itemId)
    expect(await query.myRecords(s1.id)).toEqual([expect.objectContaining({ itemId, receiverKind: 'user', receiverId: s1.id, versionCount: 1 })])
    expect((await query.myRecordVersion(s1.id, itemId, s1.id, 1))!.answers).toEqual({ wish: '我的回答' })
  })
})
