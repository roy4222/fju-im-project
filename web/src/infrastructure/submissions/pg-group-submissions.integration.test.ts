import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { assertTestDatabaseReachable, createIsolatedDatabase, poolAsRole, type IsolatedDatabase } from '../../../test/db'
import { migratedSchema } from '../../../test/migrations'
import type { ResolvedActor } from '@/application/accounts'
import type { ItemInput } from '@/application/items'
import { completionOf } from '@/application/submissions'
import { PgItemCommand } from '@/infrastructure/items/pg-items'
import { PgDueWorkScheduler } from '@/infrastructure/notifications/pg-due-work-scheduler'
import { PgEventPublisher } from '@/infrastructure/notifications/pg-event-publisher'
import { PgAuditWriter } from '@/infrastructure/ops/audit-writer'
import { FsFileStorage, reclaimableFiles } from '@/infrastructure/ops/file-storage'
import { PgOperationLedger } from '@/infrastructure/ops/operation-ledger'
import { PgResponsePresence } from '@/infrastructure/submissions/pg-response-presence'
import { PgRosterQuery } from '@/infrastructure/submissions/pg-roster'
import { PgSubmissionCommand, PgSubmissionQuery } from '@/infrastructure/submissions/pg-submissions'
import { createSubmissionFilePolicy } from '@/infrastructure/submissions/submission-file-policy'

/**
 * 票 21：組別共用草稿、上傳與正式送出（模組實作設計 05 §2、§3、§6；產品模組 05 SUB-05–09、15、17；
 * 模組 10 §2、§3、§11.2、FIL-03；契約 03 §1）。
 *
 * 全部以正式執行角色 `fju_app` 連線、真的檔案系統（每次一個暫存根目錄）、真的業務用例：
 * 項目用票 15 的用例建立與發布（名單就是發布時展開的那一份），組別與主指導直接寫表（它們的用例在票 13／14／19 測過）。
 * 重點在「做完的樣子」四條與四種高風險：並發草稿、上傳安全、下載授權、冪等送出。
 */

let owner: IsolatedDatabase
let app: Pool
let root: string
let storage: FsFileStorage
let adminId: string
let t1: string
let t3: string
let businessNow = new Date('2026-10-01T02:00:00Z')
const businessClock = { now: async () => new Date(businessNow.getTime()) }

let items: PgItemCommand
let submissions: PgSubmissionCommand
let query: PgSubmissionQuery
let rosterQuery: PgRosterQuery

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
    [name, `g21-${seq}@example.com`],
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
    [`G21-${seq}`],
  )
  const cohortId = String(cohort.rows[0]!.id)
  const stage = await owner.sql(
    `insert into cohort_stages (id, cohort_id, seq, name, start_date, created_by_kind)
     values (gen_random_uuid(), $1, 1, '成組期', '2026-09-15', 'system') returning id`,
    [cohortId],
  )
  return { cohortId, stageId: String(stage.rows[0]!.id) }
}

async function newStudent(cohortId: string, name: string): Promise<Person> {
  const id = await newUser(name, 'student')
  const studentNo = `41721${String(seq).padStart(4, '0')}`
  await owner.sql(
    `insert into user_profiles (user_id, display_name, name_normalized, student_no, cohort_id, contact_email)
     values ($1, $2, $2, $3, $4, $5)`,
    [id, name, studentNo, cohortId, `g21-${seq}@contact.example.com`],
  )
  await owner.sql('insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)', [cohortId, studentNo, id])
  return { id, name, cohortId }
}

/** 一個已成立的組（第一位是組長），可以再指派主指導。 */
async function newGroup(cohortId: string, code: string, members: Person[], advisor?: string): Promise<string> {
  const group = await owner.sql(
    `insert into groups (id, cohort_id, code, group_type, established_real_at, established_business_at, created_by_kind)
     values (gen_random_uuid(), $1, $2, 'general', now(), now(), 'system') returning id`,
    [cohortId, code],
  )
  const groupId = String(group.rows[0]!.id)
  for (const m of members) {
    await owner.sql(
      `insert into group_memberships (id, group_id, cohort_id, user_id, valid_from, added_by_kind)
       values (gen_random_uuid(), $1, $2, $3, now(), 'system')`,
      [groupId, cohortId, m.id],
    )
  }
  await owner.sql(
    `insert into group_leaders (id, group_id, user_id, valid_from, changed_by_user_id) values (gen_random_uuid(), $1, $2, now(), $2)`,
    [groupId, members[0]!.id],
  )
  if (advisor) await assignAdvisor(groupId, advisor)
  return groupId
}

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

const FIELDS = [
  { key: 'topic', type: 'text', label: '題目', required: true },
  { key: 'report', type: 'file', label: '期中報告', required: true, fileRules: { allowedTypes: ['pdf'], maxMiB: 1 } },
  { key: 'photo', type: 'file', label: '團隊照片', required: false, fileRules: { allowedTypes: ['png', 'jpg'], maxMiB: 1 } },
]

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
    fields: FIELDS,
    ...patch,
  }
}

async function published(cohortId: string, stageId: string, patch: Partial<ItemInput> = {}): Promise<string> {
  const created = await items.create(adminActor(), input(cohortId, stageId, patch), randomUUID())
  if (!created.ok) throw new Error(`${created.code} ${created.message}`)
  const done = await items.publish(adminActor(), created.receipt.itemId, created.receipt.revision, { notify: false }, randomUUID())
  if (!done.ok) throw new Error(`${done.code} ${done.message}`)
  return created.receipt.itemId
}

/** 一屆、G1（S1 組長、S2，主指導 T1）、G2（S6）、一位沒有組的 S9，以及一份已發布的整組收件。 */
async function scenario() {
  const { cohortId, stageId } = await newCohort()
  const s1 = await newStudent(cohortId, '組長小明')
  const s2 = await newStudent(cohortId, '組員小華')
  const s6 = await newStudent(cohortId, '別組小美')
  const s9 = await newStudent(cohortId, '還沒分組')
  seq += 1
  const g1 = await newGroup(cohortId, `G1-${seq}`, [s1, s2], t1)
  const g2 = await newGroup(cohortId, `G2-${seq}`, [s6])
  const itemId = await published(cohortId, stageId)
  return { cohortId, stageId, s1, s2, s6, s9, g1, g2, itemId }
}

const PDF = new TextEncoder().encode('%PDF-1.7\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n')
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
const EXE = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00])

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

/** 送到一半就斷線的串流。 */
function brokenStream(first: Uint8Array): ReadableStream<Uint8Array> {
  let sent = false
  return new ReadableStream({
    pull(controller) {
      if (!sent) {
        sent = true
        controller.enqueue(first)
      } else {
        controller.error(new Error('connection reset'))
      }
    },
  })
}

/** 走完整的上傳：用例發 ticket（欄位規則）→ 共用檔案能力收位元組。回檔案 ID。 */
async function upload(s: Person, itemId: string, fieldKey: string, name: string, bytes: Uint8Array, mime = 'application/pdf') {
  const ticket = await submissions.requestUpload(studentActor(s), itemId, fieldKey, { fileName: name, declaredMime: mime, declaredSize: bytes.length })
  if (!ticket.ok) return ticket
  return storage.upload(s.id, ticket.receipt.ticket, streamOf(bytes), bytes.length)
}

async function mustUpload(s: Person, itemId: string, fieldKey: string, name: string, bytes: Uint8Array, mime?: string): Promise<string> {
  const result = await upload(s, itemId, fieldKey, name, bytes, mime)
  if (!result.ok) throw new Error(`${result.code} ${result.message}`)
  return (result.receipt as { fileId: string }).fileId
}

async function mustSave(s: Person, itemId: string, revision: number, answers: Record<string, string>) {
  const saved = await submissions.saveDraft(studentActor(s), itemId, revision, answers, randomUUID())
  if (!saved.ok) throw new Error(`${saved.code} ${saved.message}`)
  return saved.receipt
}

async function download(actor: ResolvedActor, fileId: string) {
  const result = await storage.authorizeDownload(actor, fileId)
  if (result.ok) await result.receipt.body.cancel()
  return result.ok ? 'ok' : result.code
}

async function versionRows(itemId: string) {
  return (
    await owner.sql(
      `select id, version_no, receiver_kind, receiver_id, submitted_by_user_id, membership_snapshot, advisor_snapshot
         from submission_versions where item_id = $1 order by version_no`,
      [itemId],
    )
  ).rows
}

beforeAll(async () => {
  await assertTestDatabaseReachable()
  owner = await createIsolatedDatabase({ label: 'group-submissions', setup: migratedSchema })
  app = await poolAsRole(owner, 'fju_app')
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'fju-group-files-'))
  adminId = await newUser('系辦', 'admin')
  t1 = await newUser('王老師', 'teacher')
  t3 = await newUser('李老師', 'teacher')

  storage = new FsFileStorage({
    root: () => root,
    environmentMaxBytes: () => 100 * 1024 * 1024,
    ticketSecret: () => 'group-submissions-secret-group-submissions',
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
})

afterEach(() => {
  businessNow = new Date('2026-10-01T02:00:00Z')
})

afterAll(async () => {
  await app?.end()
  await owner?.close()
  await fs.rm(root, { recursive: true, force: true })
})

describe('1. 共用草稿：同組任一人存，其他人看到同一份；同時改要求重新載入', () => {
  it('S1 存、S2 打開看到同一份（同一個版本號、最後由誰存）；S2 接著改也是同一份', async () => {
    const { s1, s2, g1, itemId } = await scenario()
    const first = await mustSave(s1, itemId, 0, { topic: '智慧校園' })

    const seen = await query.myItem(s2.id, itemId)
    expect(seen).toMatchObject({ receiverUnit: 'group', group: { groupId: g1 } })
    expect(seen!.group!.members.map((m) => [m.name, m.isLeader])).toEqual([
      ['組長小明', true],
      ['組員小華', false],
    ])
    expect(seen!.group!.advisorName).toBe('王老師')
    expect(seen!.draft).toMatchObject({ revision: first.revision, answers: { topic: '智慧校園' }, updatedByName: '組長小明' })

    await mustSave(s2, itemId, first.revision, { topic: '智慧校園 2.0' })
    const drafts = await owner.sql('select receiver_kind, receiver_id, revision, answers from submission_drafts where item_id = $1', [itemId])
    expect(drafts.rows).toEqual([{ receiver_kind: 'group', receiver_id: g1, revision: 2, answers: { topic: '智慧校園 2.0' } }])
    expect((await query.myItem(s1.id, itemId))!.draft).toMatchObject({ revision: 2, updatedByName: '組員小華' })
  })

  it('兩位組員讀同一版、同時存：只有一位成功，另一位 CONFLICT；留下的是成功那一位的內容', async () => {
    const { s1, s2, itemId } = await scenario()
    const base = await mustSave(s1, itemId, 0, { topic: '起點' })
    const [a, b] = await Promise.all([
      submissions.saveDraft(studentActor(s1), itemId, base.revision, { topic: '小明的版本' }, randomUUID()),
      submissions.saveDraft(studentActor(s2), itemId, base.revision, { topic: '小華的版本' }, randomUUID()),
    ])
    expect([a.ok, b.ok].sort()).toEqual([false, true])
    const loser = a.ok ? b : a
    expect(loser).toMatchObject({ ok: false, code: 'CONFLICT' })
    expect(!loser.ok && loser.message).toContain('組員')
    const winner = a.ok ? '小明的版本' : '小華的版本'
    const draft = await owner.sql('select answers, revision from submission_drafts where item_id = $1', [itemId])
    expect(draft.rows[0]).toEqual({ answers: { topic: winner }, revision: 2 })
  })

  it('別組只看得到、只寫得到自己組的那一份（猜不到別組的草稿）；老師不能填', async () => {
    const { s1, s6, g1, g2, itemId } = await scenario()
    await mustSave(s1, itemId, 0, { topic: 'G1 的內容' })
    const other = await mustSave(s6, itemId, 0, { topic: 'G2 的內容' })
    expect(other.revision).toBe(1)
    const drafts = await owner.sql('select receiver_id, answers from submission_drafts where item_id = $1 order by receiver_id', [itemId])
    expect(Object.fromEntries(drafts.rows.map((r) => [r.receiver_id, r.answers]))).toEqual({
      [g1]: { topic: 'G1 的內容' },
      [g2]: { topic: 'G2 的內容' },
    })
    expect((await query.myItem(s6.id, itemId))!.draft!.answers).toEqual({ topic: 'G2 的內容' })
    expect(await submissions.saveDraft(teacherActor(t1), itemId, 0, { topic: 'x' }, randomUUID())).toMatchObject({ code: 'FORBIDDEN' })
  })
})

describe('未成組不能送出', () => {
  it('沒有組別的學生：存草稿、要上傳憑證、送出都回 NOT_MEMBER；作業區不列、內容頁 404', async () => {
    const { s9, itemId } = await scenario()
    expect(await submissions.saveDraft(studentActor(s9), itemId, 0, { topic: 'x' }, randomUUID())).toMatchObject({ code: 'NOT_MEMBER' })
    expect(await submissions.submit(studentActor(s9), itemId, 1, randomUUID())).toMatchObject({ code: 'NOT_MEMBER' })
    expect(
      await submissions.requestUpload(studentActor(s9), itemId, 'report', { fileName: 'a.pdf', declaredMime: 'application/pdf', declaredSize: 10 }),
    ).toMatchObject({ code: 'NOT_MEMBER' })
    expect((await query.myItems(s9.id)).map((r) => r.itemId)).not.toContain(itemId)
    expect(await query.myItem(s9.id, itemId)).toBeNull()
    expect(Number((await owner.sql('select count(*) as n from submission_drafts where item_id = $1', [itemId])).rows[0]!.n)).toBe(0)
  })

  it('被移出組別的人立刻失去這份共用草稿（不能存、看不到）', async () => {
    const { s1, s2, g1, itemId } = await scenario()
    await mustSave(s1, itemId, 0, { topic: 'x' })
    await owner.sql(
      `update group_memberships set valid_to = now(), removal_reason = '轉組' where group_id = $1 and user_id = $2`,
      [g1, s2.id],
    )
    expect(await submissions.saveDraft(studentActor(s2), itemId, 1, { topic: 'y' }, randomUUID())).toMatchObject({ code: 'NOT_MEMBER' })
    expect(await query.myItem(s2.id, itemId)).toBeNull()
  })
})

describe('2. 上傳並附到草稿：合法收、偽裝與超限擋、中斷殘留進回收索引', () => {
  it('合法 PDF：欄位規則發 ticket → 串流驗過變 stored → 存草稿才附上（有草稿引用）；組員上傳的檔另一位組員也能附', async () => {
    const { s1, s2, itemId } = await scenario()
    const fileId = await mustUpload(s2, itemId, 'report', '期中報告.pdf', PDF)
    expect((await owner.sql('select status, purpose, scope from stored_files where id = $1', [fileId])).rows[0]).toEqual({
      status: 'stored',
      purpose: 'submission',
      scope: 'cohort',
    })
    // 還沒存進草稿：沒有任何引用，誰都下載不到。
    expect(await download(studentActor(s2), fileId)).toBe('FORBIDDEN')

    // 同組另一位（不是上傳者）把它存進共用草稿。
    const saved = await mustSave(s1, itemId, 0, { topic: '題目', report: fileId })
    const refs = await owner.sql(`select ref_type from file_references where file_id = $1 and released_at is null`, [fileId])
    expect(refs.rows).toEqual([{ ref_type: 'draft' }])
    expect((await owner.sql('select file_ids from submission_drafts where item_id = $1', [itemId])).rows[0]!.file_ids).toEqual([fileId])
    expect((await query.myItem(s1.id, itemId))!.draft!.files).toEqual([
      expect.objectContaining({ fieldKey: 'report', fileId, name: '期中報告.pdf', sizeBytes: PDF.length }),
    ])

    // 拿掉：釋放引用（再附回來會插一筆新的有效引用，不撞唯一鍵）。
    const removed = await mustSave(s1, itemId, saved.revision, { topic: '題目' })
    expect((await owner.sql('select count(*) as n from file_references where file_id = $1 and released_at is null', [fileId])).rows[0]!.n).toBe('0')
    await mustSave(s1, itemId, removed.revision, { topic: '題目', report: fileId })
    expect((await owner.sql('select count(*) as n from file_references where file_id = $1', [fileId])).rows[0]!.n).toBe('2')
  })

  it('偽裝副檔名（EXE 改名 .pdf）被內容檢查擋下、暫存刪掉；列留在 uploading 給回收', async () => {
    const { s1, itemId } = await scenario()
    const ticket = await submissions.requestUpload(studentActor(s1), itemId, 'report', {
      fileName: '報告.pdf',
      declaredMime: 'application/pdf',
      declaredSize: EXE.length,
    })
    expect(ticket.ok).toBe(true)
    const result = await storage.upload(s1.id, ticket.ok ? ticket.receipt.ticket : '', streamOf(EXE), EXE.length)
    expect(result).toMatchObject({ ok: false, code: 'FILE_TYPE_REJECTED' })
    expect(await fs.readdir(path.join(root, 'tmp')).catch(() => [])).not.toContain(ticket.ok ? ticket.receipt.fileId : '')
    expect((await owner.sql('select status from stored_files where id = $1', [ticket.ok ? ticket.receipt.fileId : ''])).rows[0]!.status).toBe(
      'uploading',
    )
    // 就算硬把那個檔案 ID 塞進草稿，也附不上（不是 stored）。
    expect(await submissions.saveDraft(studentActor(s1), itemId, 0, { report: ticket.ok ? ticket.receipt.fileId : '' }, randomUUID())).toMatchObject({
      code: 'FILE_NOT_READY',
    })
  })

  it('不在欄位白名單的副檔名、超過欄位上限：發 ticket 時就擋；實際位元組超量在串流中途擋', async () => {
    const { s1, itemId } = await scenario()
    expect(
      await submissions.requestUpload(studentActor(s1), itemId, 'report', { fileName: 'virus.exe', declaredMime: 'application/octet-stream', declaredSize: 10 }),
    ).toMatchObject({ code: 'FILE_TYPE_REJECTED' })
    expect(
      await submissions.requestUpload(studentActor(s1), itemId, 'report', { fileName: 'big.pdf', declaredMime: 'application/pdf', declaredSize: 2 * 1024 * 1024 }),
    ).toMatchObject({ code: 'FILE_TOO_LARGE' })
    // 謊報大小：ticket 的上限（欄位 1 MiB）照樣卡住。
    const ticket = await submissions.requestUpload(studentActor(s1), itemId, 'report', {
      fileName: 'big.pdf',
      declaredMime: 'application/pdf',
      declaredSize: 10,
    })
    const big = new Uint8Array(1024 * 1024 + 1)
    big.set(PDF.subarray(0, 5))
    expect(await storage.upload(s1.id, ticket.ok ? ticket.receipt.ticket : '', streamOf(big), big.length)).toMatchObject({ code: 'FILE_TOO_LARGE' })
    // 不是檔案欄位、不存在的欄位也拿不到 ticket。
    expect(
      await submissions.requestUpload(studentActor(s1), itemId, 'topic', { fileName: 'a.pdf', declaredMime: 'application/pdf', declaredSize: 10 }),
    ).toMatchObject({ code: 'VALIDATION_FAILED' })
  })

  it('替 A 欄位傳的檔放到規則不同的 B 欄位、別組的檔、同一個檔放兩欄：存草稿時擋下', async () => {
    const { s1, s6, itemId } = await scenario()
    const photo = await mustUpload(s1, itemId, 'photo', 'team.png', PNG, 'image/png')
    expect(await submissions.saveDraft(studentActor(s1), itemId, 0, { report: photo }, randomUUID())).toMatchObject({
      code: 'FILE_TYPE_REJECTED',
      details: { field: 'report' },
    })
    const theirs = await mustUpload(s6, itemId, 'report', 'g2.pdf', PDF)
    expect(await submissions.saveDraft(studentActor(s1), itemId, 0, { report: theirs }, randomUUID())).toMatchObject({ code: 'FILE_NOT_OWNED' })
    const mine = await mustUpload(s1, itemId, 'report', 'r.pdf', PDF)
    expect(await submissions.saveDraft(studentActor(s1), itemId, 0, { report: mine, photo: mine }, randomUUID())).toMatchObject({
      code: 'VALIDATION_FAILED',
    })
    // 全部被擋：沒有留下草稿，也沒有留下引用。
    expect(Number((await owner.sql('select count(*) as n from submission_drafts where item_id = $1', [itemId])).rows[0]!.n)).toBe(0)
    expect(Number((await owner.sql(`select count(*) as n from file_references where ref_type = 'draft' and file_id = any($1::uuid[])`, [[photo, theirs, mine]])).rows[0]!.n)).toBe(0)
  })

  it('傳到一半斷線：回「上傳中斷」、暫存刪掉；殘留列 24 小時後出現在回收候選（回收索引見 s07 migration 測試），之前不會', async () => {
    const { s1, itemId } = await scenario()
    const ticket = await submissions.requestUpload(studentActor(s1), itemId, 'report', {
      fileName: 'half.pdf',
      declaredMime: 'application/pdf',
      declaredSize: 4096,
    })
    const fileId = ticket.ok ? ticket.receipt.fileId : ''
    const result = await storage.upload(s1.id, ticket.ok ? ticket.receipt.ticket : '', brokenStream(PDF), 4096)
    expect(result).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    expect(await fs.readdir(path.join(root, 'tmp')).catch(() => [])).not.toContain(fileId)

    const now = new Date()
    expect((await reclaimableFiles(app, now)).map((c) => c.id)).not.toContain(fileId)
    const later = await reclaimableFiles(app, new Date(now.getTime() + 25 * 3600_000))
    expect(later).toContainEqual({ id: fileId, status: 'uploading', ownerUserId: s1.id })
  })
})

describe('3. 任一組員代表全組送出：收件章回執、其他有效組員收到通知', () => {
  it('S2 送出：一個版本、快照記下當時組員與主指導、附件 checksum 抄進 submission_files；S1 收到通知，S2 與老師不收', async () => {
    const { s1, s2, g1, itemId } = await scenario()
    const fileId = await mustUpload(s1, itemId, 'report', '期中報告.pdf', PDF)
    const saved = await mustSave(s1, itemId, 0, { topic: '智慧校園', report: fileId })

    const requestId = randomUUID()
    const sent = await submissions.submit(studentActor(s2), itemId, saved.revision, requestId)
    expect(sent).toMatchObject({
      ok: true,
      receipt: { versionNo: 1, submittedByName: '組員小華', groupCode: expect.stringMatching(/^G1-/), requestId },
    })
    const checksum = (await owner.sql('select checksum from stored_files where id = $1', [fileId])).rows[0]!.checksum as string
    expect(sent.ok && sent.receipt.files).toEqual([{ fieldKey: 'report', name: '期中報告.pdf', checksum }])

    const [version] = await versionRows(itemId)
    expect(version).toMatchObject({ version_no: 1, receiver_kind: 'group', receiver_id: g1, submitted_by_user_id: s2.id })
    expect([...(version!.membership_snapshot as string[])].sort()).toEqual([s1.id, s2.id].sort())
    expect(version!.advisor_snapshot).toMatchObject({ teacherUserId: t1 })
    expect((await owner.sql('select field_key, file_id, checksum from submission_files where submission_version_id = $1', [version!.id])).rows).toEqual([
      { field_key: 'report', file_id: fileId, checksum },
    ])
    expect(
      (await owner.sql(`select ref_type from file_references where file_id = $1 and released_at is null order by ref_type`, [fileId])).rows.map(
        (r) => r.ref_type,
      ),
    ).toEqual(['draft', 'submission_version'])

    const events = await owner.sql(`select recipients, payload from domain_events where type = 'submission.submitted' and source_id = $1`, [itemId])
    expect(events.rows).toHaveLength(1)
    expect(events.rows[0]!.recipients).toEqual([s1.id])
    expect(JSON.stringify(events.rows[0]!.payload)).not.toContain('智慧校園')

    // 全組同步打勾：兩個人的作業區都是已繳 v1。
    for (const s of [s1, s2]) {
      expect((await query.myItems(s.id)).find((r) => r.itemId === itemId)).toMatchObject({ latestVersionNo: 1, receiverUnit: 'group' })
    }
  })

  it('連點只算一次：同一個請求編號同時送兩次，只有一個版本、一則通知、回執一樣', async () => {
    const { s1, itemId } = await scenario()
    const fileId = await mustUpload(s1, itemId, 'report', 'r.pdf', PDF)
    const saved = await mustSave(s1, itemId, 0, { topic: '題目', report: fileId })
    const requestId = randomUUID()
    const [a, b] = await Promise.all([
      submissions.submit(studentActor(s1), itemId, saved.revision, requestId),
      submissions.submit(studentActor(s1), itemId, saved.revision, requestId),
    ])
    const again = await submissions.submit(studentActor(s1), itemId, saved.revision, requestId)
    expect(a.ok && b.ok).toBe(true)
    expect(b).toEqual(a)
    expect(again).toEqual(a)
    expect(again).toMatchObject({ ok: true, receipt: { versionNo: 1, requestId } })
    expect(await versionRows(itemId)).toHaveLength(1)
    expect(Number((await owner.sql(`select count(*) as n from submission_files sf join submission_versions v on v.id = sf.submission_version_id where v.item_id = $1`, [itemId])).rows[0]!.n)).toBe(1)
    expect(Number((await owner.sql(`select count(*) as n from domain_events where type = 'submission.submitted' and source_id = $1`, [itemId])).rows[0]!.n)).toBe(1)
  })

  it('兩位組員同一刻各按一次送出（不同請求編號、同一版草稿）：兩個版本號不重複', async () => {
    const { s1, s2, itemId } = await scenario()
    const fileId = await mustUpload(s1, itemId, 'report', 'r.pdf', PDF)
    const saved = await mustSave(s1, itemId, 0, { topic: '題目', report: fileId })
    const [a, b] = await Promise.all([
      submissions.submit(studentActor(s1), itemId, saved.revision, randomUUID()),
      submissions.submit(studentActor(s2), itemId, saved.revision, randomUUID()),
    ])
    expect(a.ok && b.ok).toBe(true)
    expect((await versionRows(itemId)).map((v) => v.version_no)).toEqual([1, 2])
  })

  it('必填的檔案沒附：VALIDATION_FAILED 指到那一欄，不產生版本', async () => {
    const { s1, itemId } = await scenario()
    const saved = await mustSave(s1, itemId, 0, { topic: '只有題目' })
    expect(await submissions.submit(studentActor(s1), itemId, saved.revision, randomUUID())).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { field: 'report' },
    })
    expect(await versionRows(itemId)).toHaveLength(0)
  })

  it('上傳者後來被移出組別：留在草稿上的檔照樣送得出去（證明是草稿引用著，不看上傳者）', async () => {
    const { s1, s2, g1, itemId } = await scenario()
    const fileId = await mustUpload(s2, itemId, 'report', 'r.pdf', PDF)
    const saved = await mustSave(s2, itemId, 0, { topic: '題目', report: fileId })
    await owner.sql(`update group_memberships set valid_to = now(), removal_reason = '轉組' where group_id = $1 and user_id = $2`, [g1, s2.id])
    const sent = await submissions.submit(studentActor(s1), itemId, saved.revision, randomUUID())
    expect(sent).toMatchObject({ ok: true, receipt: { versionNo: 1 } })
    const [version] = await versionRows(itemId)
    expect(version!.membership_snapshot).toEqual([s1.id])
    // 被移出的人不再收到這一組的通知（收件人＝送出當下的有效組員扣掉送出者）。
    expect(Number((await owner.sql(`select count(*) as n from domain_events where type = 'submission.submitted' and source_id = $1`, [itemId])).rows[0]!.n)).toBe(0)
  })
})

describe('4. 截止前重送新版本，第 1 版不動', () => {
  it('換檔重送：第 2 版採計；第 1 版的附件、checksum、檔案本體都不變、還下載得到；截止後再送被拒', async () => {
    const { s1, s2, itemId } = await scenario()
    const first = await mustUpload(s1, itemId, 'report', 'v1.pdf', PDF)
    const r1 = await mustSave(s1, itemId, 0, { topic: '第一版', report: first })
    expect((await submissions.submit(studentActor(s1), itemId, r1.revision, randomUUID())).ok).toBe(true)
    const v1Files = (await owner.sql(`select file_id, checksum from submission_files order by file_id`)).rows.filter((r) => r.file_id === first)

    const secondBytes = new TextEncoder().encode('%PDF-1.7\n% 第二版\n%%EOF\n')
    const second = await mustUpload(s2, itemId, 'report', 'v2.pdf', secondBytes)
    const r2 = await mustSave(s2, itemId, r1.revision, { topic: '第二版', report: second })
    const sent = await submissions.submit(studentActor(s2), itemId, r2.revision, randomUUID())
    expect(sent).toMatchObject({ ok: true, receipt: { versionNo: 2 } })

    const [v1, v2] = await versionRows(itemId)
    expect((await owner.sql('select file_id, checksum from submission_files where submission_version_id = $1', [v1!.id])).rows).toEqual(v1Files)
    expect((await owner.sql('select file_id from submission_files where submission_version_id = $1', [v2!.id])).rows).toEqual([{ file_id: second }])
    // 第 1 版的檔已經從草稿拿掉，但正式版本還引用著：組員照樣下載得到，內容與當時的 checksum 一致。
    expect(await download(studentActor(s1), first)).toBe('ok')
    expect((await query.myVersion(s1.id, itemId, 1))!.files).toEqual([expect.objectContaining({ fileId: first, name: 'v1.pdf', checksum: v1Files[0]!.checksum })])
    expect((await query.myVersion(s2.id, itemId, 2))!.isLatest).toBe(true)

    businessNow = new Date('2026-11-16T00:00:00Z')
    expect(await submissions.submit(studentActor(s1), itemId, r2.revision, randomUUID())).toMatchObject({ code: 'DEADLINE_PASSED' })
    expect(await versionRows(itemId)).toHaveLength(2)
  })
})

describe('下載授權：本組有效組員、目前主指導、管理員；其他人 403', () => {
  it('草稿上的檔：組員、管理員可以；別組、主指導、其他老師不行', async () => {
    const { s1, s2, s6, itemId } = await scenario()
    const fileId = await mustUpload(s1, itemId, 'report', 'r.pdf', PDF)
    await mustSave(s1, itemId, 0, { report: fileId })
    expect(await download(studentActor(s1), fileId)).toBe('ok')
    expect(await download(studentActor(s2), fileId)).toBe('ok')
    expect(await download(adminActor(), fileId)).toBe('ok')
    expect(await download(studentActor(s6), fileId)).toBe('FORBIDDEN')
    expect(await download(teacherActor(t1), fileId)).toBe('FORBIDDEN')
    expect(await download(teacherActor(t3), fileId)).toBe('FORBIDDEN')
    expect(await download({ kind: 'anonymous' } as ResolvedActor, fileId)).toBe('UNAUTHENTICATED')
  })

  it('正式版本的檔：目前主指導可以；改派之後舊老師被拒、新老師可以；被移出的組員只拿得到送出當下自己在組裡的那一版', async () => {
    const { s1, s2, s6, g1, itemId } = await scenario()
    const fileId = await mustUpload(s1, itemId, 'report', 'r.pdf', PDF)
    const saved = await mustSave(s1, itemId, 0, { topic: 't', report: fileId })
    expect((await submissions.submit(studentActor(s1), itemId, saved.revision, randomUUID())).ok).toBe(true)

    expect(await download(teacherActor(t1), fileId)).toBe('ok')
    expect(await download(teacherActor(t3), fileId)).toBe('FORBIDDEN')
    expect(await download(studentActor(s6), fileId)).toBe('FORBIDDEN')

    await assignAdvisor(g1, t3)
    expect(await download(teacherActor(t1), fileId)).toBe('FORBIDDEN')
    expect(await download(teacherActor(t3), fileId)).toBe('ok')

    await owner.sql(`update group_memberships set valid_to = now(), removal_reason = '轉組' where group_id = $1 and user_id = $2`, [g1, s2.id])
    // 票 22：S2 送出當下在組裡（`membership_snapshot`），被移出後仍可唯讀這一版與它的附件（契約 03 §1「被移出後」）；
    // 移出之後才送的版本拿不到——在 `pg-history-matrix.integration.test.ts` 驗。
    expect(await download(studentActor(s2), fileId)).toBe('ok')
    expect(await download(studentActor(s1), fileId)).toBe('ok')
    // 只剩草稿引用的新檔：被移出的人拿不到（共用草稿只給此刻的組員）。
    const next = await mustUpload(s1, itemId, 'report', 'r2.pdf', PDF)
    await mustSave(s1, itemId, saved.revision, { topic: 't', report: next })
    expect(await download(studentActor(s2), next)).toBe('FORBIDDEN')
    expect(await download(studentActor(s1), next)).toBe('ok')
  })

  it('個人回答的附件：主指導只在項目開放閱覽、而且這一版在生效欄位版本以後才拿得到（舊回答不擴權）', async () => {
    const { cohortId, stageId, s1, s6 } = await scenario()
    const itemId = await published(cohortId, stageId, { title: '個人作品集', receiverUnit: 'individual' })
    const fileId = await mustUpload(s1, itemId, 'report', 'me.pdf', PDF)
    const saved = await mustSave(s1, itemId, 0, { topic: 't', report: fileId })
    expect((await submissions.submit(studentActor(s1), itemId, saved.revision, randomUUID())).ok).toBe(true)
    // 個人收件的版本不記組員快照（整組一份才記）。
    expect((await versionRows(itemId))[0]).toMatchObject({ receiver_kind: 'user', membership_snapshot: null, advisor_snapshot: null })

    expect(await download(studentActor(s1), fileId)).toBe('ok')
    expect(await download(studentActor(s6), fileId)).toBe('FORBIDDEN')
    expect(await download(teacherActor(t1), fileId)).toBe('FORBIDDEN')

    const setVisibility = (effective: number) =>
      owner.sql(
        `insert into advisor_visibility_settings (id, item_id, enabled, effective_from_version_no, set_by_user_id, set_at)
         values (gen_random_uuid(), $1, true, $2, $3, clock_timestamp())`,
        [itemId, effective, adminId],
      )
    await setVisibility(2)
    expect(await download(teacherActor(t1), fileId)).toBe('FORBIDDEN')
    expect((await query.myItem(s1.id, itemId))!.advisorCanView).toBe(false)
    await setVisibility(1)
    expect(await download(teacherActor(t1), fileId)).toBe('ok')
    expect((await query.myItem(s1.id, itemId))!.advisorCanView).toBe(true)
    expect(await download(teacherActor(t3), fileId)).toBe('FORBIDDEN')
  })
})

describe('名單頁的組別完成率（票 18 遺留）', () => {
  it('整組一份：同組兩人各送一次也只算這一組一份；分母是組數', async () => {
    const { s1, s2, itemId } = await scenario()
    const fileId = await mustUpload(s1, itemId, 'report', 'r.pdf', PDF)
    const saved = await mustSave(s1, itemId, 0, { topic: 't', report: fileId })
    expect((await submissions.submit(studentActor(s1), itemId, saved.revision, randomUUID())).ok).toBe(true)
    expect((await submissions.submit(studentActor(s2), itemId, saved.revision, randomUUID())).ok).toBe(true)

    const roster = await rosterQuery.roster(adminActor(), itemId)
    expect(roster!.entries.every((e) => e.receiverKind === 'group')).toBe(true)
    expect(completionOf(roster!.item, roster!.entries, businessNow)).toMatchObject({ required: 2, done: 1, pending: 1 })
    const g1Entry = roster!.entries.find((e) => e.latestVersionNo !== null)!
    expect(g1Entry).toMatchObject({ latestVersionNo: 2, latestSubmittedByName: '組員小華' })
    const detail = await rosterQuery.receiverVersion(adminActor(), itemId, g1Entry.receiverId, 1)
    expect(detail!.files).toEqual([expect.objectContaining({ fileId, fieldKey: 'report' })])
  })
})
