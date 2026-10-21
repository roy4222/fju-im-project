import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { assertTestDatabaseReachable, createIsolatedDatabase, poolAsRole, type IsolatedDatabase } from '../../../test/db'
import { migratedSchema } from '../../../test/migrations'
import type { ResolvedActor } from '@/application/accounts'
import type { ItemInput } from '@/application/items'
import { PgGroupCommand } from '@/infrastructure/groups/pg-groups'
import { createAttachmentPolicy } from '@/infrastructure/items/attachment-policy'
import { PgItemCommand } from '@/infrastructure/items/pg-items'
import { PgDueWorkScheduler } from '@/infrastructure/notifications/pg-due-work-scheduler'
import { PgEventPublisher } from '@/infrastructure/notifications/pg-event-publisher'
import { PgAuditWriter, sha256 } from '@/infrastructure/ops/audit-writer'
import { FsFileStorage } from '@/infrastructure/ops/file-storage'
import { PgOperationLedger } from '@/infrastructure/ops/operation-ledger'
import { PgConsentPublishHook } from '@/infrastructure/signoff/pg-consent-bridge'
import { PgSignoffCommand, PgSignoffQuery } from '@/infrastructure/signoff/pg-signoff'
import { createSubmissionFilePolicy } from '@/infrastructure/submissions/submission-file-policy'
import { PgResponsePresence } from '@/infrastructure/submissions/pg-response-presence'

/**
 * C1-03（#641）：同意書接上作業（C 階段規格① §1.2、§3.3、§6.4）。真的 `PgItemCommand` 發布／更新站內同意書作業，
 * 同一筆交易呼叫真的 `PgConsentPublishHook`。全部以正式執行角色 `fju_app` 連線。
 *
 * - AC-21：發布就建包（有主指導的組建、沒有的跳過）；組員只收「輪到你同意」、沒有「新作業」；checksum＝全文 sha256、範圍 null。
 * - AC-21b：最終文件授權缺草稿整筆拒絕；補草稿後建包、範圍凍結、附件以 item 來源綁；主指導可下載、別的老師不行。
 * - AC-23：改正文 → 每位參與者只收一則「內容已更新」、沒有 version_created；舊版 superseded／content_change、舊票留著；只改截止不建版。
 * - AC-23a：換附件 → 新版新集合；被刪的舊檔只剩舊版引用，系辦與舊版參與者仍可下載，外人不行。
 * - AC-22a／AC-25／AC-25a：不同意、作廢、重新收集、重開理由都選填；cause 固定代碼；有 item 附件的重新收集／重開成功，舊 API 的繳交檔也成功。
 * - 補建（createForGroup）、對象減組作廢、itemBoard／byItem 查詢、發布同意書 vs 同時改組員的並發。
 */

let owner: IsolatedDatabase
let app: Pool
let root: string
let storage: FsFileStorage
let items: PgItemCommand
let signoff: PgSignoffCommand
let hook: PgConsentPublishHook
let query: PgSignoffQuery
let groups: PgGroupCommand
let adminId: string
const businessClock = { now: async () => new Date('2027-01-05T02:00:00Z') }
const realClock = { now: () => new Date() }

type Role = 'admin' | 'teacher' | 'student'
function actor(userId: string, roles: Role[]): ResolvedActor {
  return { kind: 'authenticated', userId, roles, status: 'active', mustChangePassword: false, cohortMemberships: [], loginMethod: 'password' }
}
const admin = () => actor(adminId, ['admin'])

let seq = 0
async function newUser(name: string, role: Role, cohortId?: string) {
  seq += 1
  const email = `cb${seq}-${randomUUID().slice(0, 8)}@example.com`
  const row = await owner.sql(
    `insert into users (id, name, email, email_verified, updated_at, status) values (gen_random_uuid(), $1, $2, true, now(), 'active') returning id`,
    [name, email],
  )
  const id = String(row.rows[0]!.id)
  await owner.sql(
    `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at) values (gen_random_uuid(), $1, $2, $1, now())`,
    [id, role],
  )
  const studentNo = role === 'student' ? `4130${String(seq).padStart(5, '0')}` : null
  await owner.sql(
    `insert into user_profiles (user_id, display_name, name_normalized, student_no, cohort_id, contact_email) values ($1, $2, $2, $3, $4, $5)`,
    [id, name, studentNo, cohortId ?? null, `c-${email}`],
  )
  if (studentNo && cohortId) {
    await owner.sql(`insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)`, [cohortId, studentNo, id])
  }
  return { id, name, studentNo }
}
type Person = Awaited<ReturnType<typeof newUser>>

async function newCohort(): Promise<string> {
  seq += 1
  const cohort = await owner.sql(
    `insert into cohorts (id, code, name, status, year_end_date, group_size_min, group_size_max, created_by_kind)
     values (gen_random_uuid(), $1, $1, 'active', '2027-06-30', 1, 5, 'system') returning id`,
    [`CB-${seq}`],
  )
  return String(cohort.rows[0]!.id)
}

/** 一組：`size` 位組員；`advisor: false` 就不指派主指導。 */
async function newGroup(cohortId: string, code: string, options: { size?: number; advisor?: boolean } = {}) {
  const members: Person[] = []
  for (let i = 0; i < (options.size ?? 2); i += 1) members.push(await newUser(`學生${code}-${i + 1}`, 'student', cohortId))
  const group = await owner.sql(
    `insert into groups (id, cohort_id, code, group_type, established_real_at, established_business_at, created_by_kind)
     values (gen_random_uuid(), $1, $2, 'general', now(), now(), 'system') returning id`,
    [cohortId, code],
  )
  const groupId = String(group.rows[0]!.id)
  for (const m of members) {
    await owner.sql(
      `insert into group_memberships (id, group_id, cohort_id, user_id, valid_from, added_by_kind) values (gen_random_uuid(), $1, $2, $3, now() - interval '1 day', 'system')`,
      [groupId, cohortId, m.id],
    )
  }
  if (members[0]) {
    await owner.sql(
      `insert into group_leaders (id, group_id, user_id, valid_from, changed_by_user_id) values (gen_random_uuid(), $1, $2, now() - interval '1 day', $3)`,
      [groupId, members[0].id, adminId],
    )
  }
  let teacher: Person | null = null
  if (options.advisor !== false) {
    teacher = await newUser(`老師${code}`, 'teacher')
    await assignAdvisor(groupId, teacher.id)
  }
  return { groupId, code, members, teacher }
}
type Group = Awaited<ReturnType<typeof newGroup>>

async function assignAdvisor(groupId: string, teacherUserId: string) {
  await owner.sql(
    `insert into advisor_assignments (id, group_id, teacher_user_id, source, valid_from, assigned_by_user_id, reason)
     values (gen_random_uuid(), $1, $2, 'admin', now() - interval '1 day', $3, '指派')`,
    [groupId, teacherUserId, adminId],
  )
}

/** 這一組的成果展示草稿（題目、摘要都有，才凍得住）。 */
async function showcaseDraft(cohortId: string, groupId: string, title = '智慧校園導覽') {
  const entry = await owner.sql(
    `insert into showcase_entries (id, cohort_id, group_id, created_by_user_id) values (gen_random_uuid(), $1, $2, $3) returning id`,
    [cohortId, groupId, adminId],
  )
  await owner.sql(
    `insert into showcase_drafts (entry_id, title, summary, summary_checksum) values ($1, $2, '用室內定位帶新生認識校園。', encode(sha256('用室內定位帶新生認識校園。'::bytea), 'hex'))`,
    [entry.rows[0]!.id, title],
  )
  return String(entry.rows[0]!.id)
}

const PDF = new TextEncoder().encode('%PDF-1.4\n% 同意書附件\n')

/** 系辦上傳一個作業附件（用途 attachment）。 */
async function uploadAttachment(cohortId: string, fileName = '說明.pdf'): Promise<string> {
  const issued = await storage.issueUploadTicket(
    adminId,
    { fileName, declaredMime: 'application/pdf', declaredSize: PDF.length },
    { purpose: 'attachment', allowedTypes: ['pdf'], maxBytes: 1024 * 1024, scope: { kind: 'cohort', cohortId } },
  )
  if (!issued.ok) throw new Error(issued.message)
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(PDF)
      controller.close()
    },
  })
  const stored = await storage.upload(adminId, issued.receipt.ticket, stream, PDF.length)
  if (!stored.ok) throw new Error(stored.message)
  return stored.receipt.fileId
}

function consentInput(cohortId: string, patch: Partial<ItemInput> = {}): ItemInput {
  return {
    cohortId,
    placement: 'submission',
    title: '期中結果確認同意書',
    summary: '',
    body: '<p>本組同意期中結果。</p>',
    category: '',
    coverFileId: null,
    attachmentFileIds: [],
    audienceKind: 'cohort_students',
    groupIds: [],
    receiverUnit: 'group',
    stageId: null,
    opensAt: '',
    dueAt: '',
    fields: [],
    consentMode: 'form',
    consentPurpose: 'result_confirmation',
    ...patch,
  }
}

async function createItem(cohortId: string, patch: Partial<ItemInput> = {}) {
  const created = await items.create(admin(), consentInput(cohortId, patch), randomUUID())
  if (!created.ok) throw new Error(`${created.code} ${created.message}`)
  return created.receipt
}

async function publish(itemId: string, revision: number) {
  return items.publish(admin(), itemId, revision, { notify: true }, randomUUID())
}

async function mustPublish(itemId: string, revision: number) {
  const r = await publish(itemId, revision)
  if (!r.ok) throw new Error(`${r.code} ${r.message}`)
  return r.receipt
}

async function update(itemId: string, revision: number, input: ItemInput) {
  return items.updatePublished(admin(), itemId, revision, input, { notify: true }, randomUUID())
}

async function mustUpdate(itemId: string, revision: number, input: ItemInput) {
  const r = await update(itemId, revision, input)
  if (!r.ok) throw new Error(`${r.code} ${r.message}`)
  return r.receipt
}

async function count(sql: string, values: unknown[] = []): Promise<number> {
  return Number((await owner.sql(sql, values)).rows[0]!.n)
}

type Pkg = { id: string; version_id: string; version_no: number; state: string; cause: string | null; content_checksum: string; authorization_scope: unknown; attachment_file_versions: { fileId: string; source?: unknown }[]; supersede_cause: string | null; participants: { students: { userId: string }[]; advisor: { userId: string } } }
/** 這一組連到這份作業的包、目前版本。 */
async function packageOf(itemId: string, groupId: string): Promise<Pkg | null> {
  const row = (
    await owner.sql(
      `select p.id, v.id as version_id, v.version_no, s.state, s.cause, v.content_checksum, v.authorization_scope, v.attachment_file_versions, v.supersede_cause, v.participants
         from signoff_packages p
         join signoff_package_versions v on v.id = p.current_version_id
         join signoff_version_status s on s.version_id = v.id
        where p.item_id = $1 and p.group_id = $2`,
      [itemId, groupId],
    )
  ).rows[0]
  return (row as Pkg | undefined) ?? null
}

async function statusOf(versionId: string) {
  return (await owner.sql('select state, cause from signoff_version_status where version_id = $1', [versionId])).rows[0]!
}

async function recipientsOf(type: string, sourceId: string): Promise<string[]> {
  const rows = await owner.sql(`select recipients from domain_events where type = $1 and source_id = $2 order by occurred_real_at`, [type, sourceId])
  return rows.rows.flatMap((r) => (r.recipients as string[]).map(String)).sort()
}

async function eventsOfType(type: string, sourceId: string): Promise<number> {
  return count('select count(*) as n from domain_events where type = $1 and source_id = $2', [type, sourceId])
}

/** 這個人對這份作業相關的某一種事件總共收到幾則（跨版本）。 */
async function receivedBy(userId: string, type: string, since: Date): Promise<number> {
  return count(`select count(*) as n from domain_events where type = $1 and $2 = any(recipients) and occurred_real_at >= $3`, [type, userId, since])
}

async function refs(fileId: string, refType: string): Promise<string[]> {
  const rows = await owner.sql(`select ref_id from file_references where file_id = $1 and ref_type = $2 and released_at is null order by ref_id`, [fileId, refType])
  return rows.rows.map((r) => String(r.ref_id))
}

/** 下載授權（政策＋檔案能力）；通過就把串流取消掉。 */
async function canDownload(who: ResolvedActor, fileId: string): Promise<boolean> {
  const r = await storage.authorizeDownload(who, fileId)
  if (r.ok) await r.receipt.body.cancel()
  return r.ok
}

async function checksumOf(versionId: string): Promise<string> {
  return String((await owner.sql('select content_checksum from signoff_package_versions where id = $1', [versionId])).rows[0]!.content_checksum)
}

async function vote(who: ResolvedActor, versionId: string, decision: 'agree' | 'reject' = 'agree', reason: string | null = null) {
  return signoff.respond(who, { versionId, contentChecksum: await checksumOf(versionId), decision, reason }, randomUUID())
}

async function revisionOf(groupId: string): Promise<number> {
  return Number((await owner.sql('select revision from groups where id = $1', [groupId])).rows[0]!.revision)
}

const student = (p: Person) => actor(p.id, ['student'])
const teacher = (p: Person) => actor(p.id, ['teacher'])

beforeAll(async () => {
  await assertTestDatabaseReachable()
  owner = await createIsolatedDatabase({ label: 'consent_bridge', setup: migratedSchema })
  app = await poolAsRole(owner, 'fju_app')
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'fju-consent-bridge-'))
  const a = await owner.sql(
    `insert into users (id, name, email, email_verified, updated_at, status) values (gen_random_uuid(), '系辦甲', 'cb-admin@example.com', true, now(), 'active') returning id`,
  )
  adminId = String(a.rows[0]!.id)
  await owner.sql(
    `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at) values (gen_random_uuid(), $1, 'admin', $1, now())`,
    [adminId],
  )
  storage = new FsFileStorage({
    root: () => root,
    environmentMaxBytes: () => 100 * 1024 * 1024,
    ticketSecret: () => 'consent-bridge-secret-consent-bridge-secret',
    policies: { attachment: createAttachmentPolicy(() => app), submission: createSubmissionFilePolicy(() => app) },
    db: () => app,
  })
  const common = { audit: new PgAuditWriter(), ledger: new PgOperationLedger(() => app), businessClock, pool: () => app }
  signoff = new PgSignoffCommand({ ...common, events: new PgEventPublisher(), files: storage, realClock })
  hook = new PgConsentPublishHook({ signoff, ledger: common.ledger, businessClock, pool: () => app, realClock })
  query = new PgSignoffQuery({ pool: () => app })
  items = new PgItemCommand({
    ...common,
    events: new PgEventPublisher(),
    dueWork: new PgDueWorkScheduler({ testKindsEnabled: false }),
    files: storage,
    responses: new PgResponsePresence(),
    consent: hook,
  })
  groups = new PgGroupCommand({ ...common, events: new PgEventPublisher(), dueWork: new PgDueWorkScheduler({ testKindsEnabled: false }), signoff })
})

afterAll(async () => {
  await app?.end()
  await owner?.close()
  await fs.rm(root, { recursive: true, force: true })
})

describe('發布就建包（AC-21）', () => {
  it('有主指導的組建包＋第 1 版、沒有的跳過；組員只收「輪到你同意」、沒有「新作業」；checksum＝全文 sha256、範圍 null；看板一列一組', async () => {
    const cohortId = await newCohort()
    const g1 = await newGroup(cohortId, 'G01')
    const g2 = await newGroup(cohortId, 'G02')
    const g3 = await newGroup(cohortId, 'G03', { advisor: false })
    const since = new Date()
    const item = await createItem(cohortId)
    const published = await mustPublish(item.itemId, item.revision)
    expect(published.consent).toEqual({ created: 2, skipped: [{ groupId: g3.groupId, reason: 'no_advisor' }] })
    expect(published.rosterCount).toBe(3)

    for (const g of [g1, g2]) {
      const pkg = await packageOf(item.itemId, g.groupId)
      expect(pkg).toMatchObject({ version_no: 1, state: 'collecting', authorization_scope: null, supersede_cause: null })
      expect(pkg!.content_checksum).toBe(sha256('<p>本組同意期中結果。</p>'))
      expect(await recipientsOf('signoff.version_created', pkg!.version_id)).toEqual(g.members.map((m) => m.id).sort())
    }
    expect(await packageOf(item.itemId, g3.groupId)).toBeNull()
    expect(await count(`select count(*) as n from signoff_packages where item_id = $1 and purpose = 'result_confirmation'`, [item.itemId])).toBe(2)
    expect(await count(`select count(*) as n from domain_events where type = 'item.published' and source_id = $1`, [item.itemId])).toBe(0)
    expect((await owner.sql('select consent_purpose, status from managed_items where id = $1', [item.itemId])).rows[0]).toEqual({
      consent_purpose: 'result_confirmation',
      status: 'published',
    })
    for (const m of g1.members) expect(await receivedBy(m.id, 'signoff.version_created', since)).toBe(1)

    const board = await query.itemBoard(admin(), item.itemId)
    if (!board.ok) throw new Error(board.message)
    expect(board.receipt).toMatchObject({ itemId: item.itemId, itemTitle: '期中結果確認同意書', purpose: 'result_confirmation' })
    expect(board.receipt.rows.map((r) => [r.groupCode, r.state, r.skipped])).toEqual([
      ['G01', 'collecting', null],
      ['G02', 'collecting', null],
      ['G03', null, 'no_advisor'],
    ])
    expect(board.receipt.rows[0]!.students.map((s) => s.result)).toEqual([null, null])
    expect(board.receipt.rows[0]!.advisor?.userId).toBe(g1.teacher!.id)
    expect(await query.itemBoard(teacher(g1.teacher!), item.itemId)).toMatchObject({ ok: false, code: 'FORBIDDEN' })

    // 學生與老師依作業查：只拿到連到這份作業的包。
    const mine = await query.studentViewByItem(student(g1.members[0]!), item.itemId)
    expect(mine.groupCode).toBe('G01')
    expect(mine.versions.map((v) => [v.itemId, v.itemTitle, v.versionNo])).toEqual([[item.itemId, '期中結果確認同意書', 1]])
    expect((await query.studentViewByItem(student(g3.members[0]!), item.itemId)).versions).toEqual([])
    const cards = await query.teacherViewByItem(teacher(g1.teacher!), item.itemId)
    expect(cards.map((c) => [c.groupCode, c.itemId, c.current.state])).toEqual([['G01', item.itemId, 'collecting']])
    expect(await query.teacherViewByItem(teacher(g1.teacher!), randomUUID())).toEqual([])
  })

  it('同一筆作業的包和舊 API 的包各自獨立：同組同用途可以同時有舊包與作業包', async () => {
    const cohortId = await newCohort()
    const g1 = await newGroup(cohortId, 'G01')
    const legacy = await signoff.createVersion(admin(), { groupId: g1.groupId, purpose: 'result_confirmation', content: '舊 API', attachmentFileIds: [], showcaseEntryId: null }, randomUUID())
    if (!legacy.ok) throw new Error(legacy.message)
    const item = await createItem(cohortId)
    const published = await mustPublish(item.itemId, item.revision)
    expect(published.consent).toEqual({ created: 1, skipped: [] })
    expect(await count(`select count(*) as n from signoff_packages where group_id = $1`, [g1.groupId])).toBe(2)
    expect((await statusOf(legacy.receipt.versionId)).state).toBe('collecting')
  })
})

describe('最終文件授權（AC-21b）', () => {
  it('缺草稿的組 → 整筆拒絕列出組別、作業仍是草稿、無包無通知；補草稿後建包、範圍凍結、附件以 item 來源綁；主指導可下載、別的老師不行', async () => {
    const cohortId = await newCohort()
    const g1 = await newGroup(cohortId, 'G01')
    const g2 = await newGroup(cohortId, 'G02')
    const g4 = await newGroup(cohortId, 'G04')
    await showcaseDraft(cohortId, g2.groupId)
    const fileId = await uploadAttachment(cohortId)
    const item = await createItem(cohortId, { title: '最終文件授權書', consentPurpose: 'final_document', attachmentFileIds: [fileId] })

    const refused = await publish(item.itemId, item.revision)
    expect(refused).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    expect(refused.ok || refused.message).toContain('這些組還沒有成果展示草稿：G01、G04')
    expect((await owner.sql('select status from managed_items where id = $1', [item.itemId])).rows[0]!.status).toBe('draft')
    expect(await count('select count(*) as n from signoff_packages where item_id = $1', [item.itemId])).toBe(0)
    expect(await count(`select count(*) as n from domain_events where source_id = $1 or payload ->> 'itemId' = $1::text`, [item.itemId])).toBe(0)

    await showcaseDraft(cohortId, g1.groupId, '題目一')
    await showcaseDraft(cohortId, g4.groupId, '題目四')
    const published = await mustPublish(item.itemId, item.revision)
    expect(published.consent).toEqual({ created: 3, skipped: [] })
    const pkg = (await packageOf(item.itemId, g2.groupId))!
    expect(pkg.authorization_scope).toMatchObject({ title: '智慧校園導覽', summary: '用室內定位帶新生認識校園。', usages: ['public_showcase'] })
    expect(pkg.attachment_file_versions.map((a) => a.fileId)).toEqual([fileId])
    expect(pkg.attachment_file_versions[0]!.source).toMatchObject({ itemTitle: '最終文件授權書', kind: 'item_attachment' })
    // 同一個檔同時有 item_attachment 引用與三個版本的 signoff_version 引用。
    expect(await refs(fileId, 'item_attachment')).toEqual([item.itemId])
    expect(await refs(fileId, 'signoff_version')).toHaveLength(3)
    expect(await count(`select count(*) as n from signoff_packages where item_id = $1 and purpose = 'final_document'`, [item.itemId])).toBe(3)

    // 主指導下載：200（經該版簽核讀權驗證的 signoff_version 引用）；別屆老師只依 item 對象判斷（整組收件的附件不給他）。
    expect(await canDownload(teacher(g2.teacher!), fileId)).toBe(true)
    expect(await canDownload(student(g2.members[0]!), fileId)).toBe(true)
    const outsider = await newUser('外系老師', 'teacher')
    expect(await canDownload(teacher(outsider), fileId)).toBe(false)
    expect(await canDownload(admin(), fileId)).toBe(true)
  })
})

describe('內容改版只發「內容已更新」（AC-23、AC-23a）', () => {
  it('改正文：每位參與者（含已同意的）只收一則 content_changed、沒有 version_created；舊版 superseded／content_change、舊票留著；只改截止不建版不通知', async () => {
    const cohortId = await newCohort()
    const g1 = await newGroup(cohortId, 'G01')
    const g2 = await newGroup(cohortId, 'G02')
    const item = await createItem(cohortId)
    const published = await mustPublish(item.itemId, item.revision)
    const v1 = (await packageOf(item.itemId, g1.groupId))!
    expect((await vote(student(g1.members[0]!), v1.version_id)).ok).toBe(true)
    const since = new Date()

    const updated = await mustUpdate(item.itemId, published.revision, consentInput(cohortId, { body: '<p>改過的內容。</p>' }))
    const v2 = (await packageOf(item.itemId, g1.groupId))!
    expect(v2.version_no).toBe(2)
    expect(v2).toMatchObject({ state: 'collecting', supersede_cause: 'content_change' })
    expect(v2.content_checksum).toBe(sha256('<p>改過的內容。</p>'))
    expect(await statusOf(v1.version_id)).toEqual({ state: 'superseded', cause: 'content_change' })
    expect(await count('select count(*) as n from approvals where version_id = $1', [v1.version_id])).toBe(1)
    expect(await count('select count(*) as n from approvals where version_id = $1', [v2.version_id])).toBe(0)
    // 每位參與者（甲已同意、乙未表態、主指導）各一則 content_changed；沒有 version_created；系辦沒收到。
    expect(await recipientsOf('signoff.content_changed', v2.version_id)).toEqual([...g1.members.map((m) => m.id), g1.teacher!.id].sort())
    expect(await eventsOfType('signoff.version_created', v2.version_id)).toBe(0)
    for (const u of [...g1.members, g1.teacher!]) {
      expect(await receivedBy(u.id, 'signoff.content_changed', since)).toBe(1)
      expect(await receivedBy(u.id, 'signoff.version_created', since)).toBe(0)
    }
    expect(await receivedBy(adminId, 'signoff.content_changed', since)).toBe(0)
    expect(await recipientsOf('signoff.superseded', v1.version_id)).toEqual([])
    expect(await eventsOfType('signoff.superseded', v1.version_id)).toBe(1)
    const v2b = (await packageOf(item.itemId, g2.groupId))!
    expect(v2b.version_no).toBe(2)
    // 新版可以再同意。
    expect((await vote(student(g1.members[0]!), v2.version_id)).ok).toBe(true)

    // 只改截止：不建版、不通知。
    const before = await count('select count(*) as n from domain_events where occurred_real_at >= $1', [since])
    await mustUpdate(item.itemId, updated.revision, consentInput(cohortId, { body: '<p>改過的內容。</p>', dueAt: '2027-03-01T23:59' }))
    expect((await packageOf(item.itemId, g1.groupId))!.version_id).toBe(v2.version_id)
    expect(await count('select count(*) as n from domain_events where occurred_real_at >= $1', [since])).toBe(before)
  })

  it('換附件：每組再建一版、新版綁新集合（signoff_version）；被刪的舊檔只剩舊版引用，系辦與舊版參與者仍可下載、外人不行；只發 content_changed', async () => {
    const cohortId = await newCohort()
    const g1 = await newGroup(cohortId, 'G01')
    const oldFile = await uploadAttachment(cohortId, '舊附件.pdf')
    const newFile = await uploadAttachment(cohortId, '新附件.pdf')
    const item = await createItem(cohortId, { attachmentFileIds: [oldFile] })
    const published = await mustPublish(item.itemId, item.revision)
    const v1 = (await packageOf(item.itemId, g1.groupId))!
    expect(v1.attachment_file_versions.map((a) => a.fileId)).toEqual([oldFile])

    await mustUpdate(item.itemId, published.revision, consentInput(cohortId, { attachmentFileIds: [newFile] }))
    const v2 = (await packageOf(item.itemId, g1.groupId))!
    expect(v2).toMatchObject({ version_no: 2, supersede_cause: 'content_change' })
    expect(v2.attachment_file_versions.map((a) => a.fileId)).toEqual([newFile])
    expect(await refs(newFile, 'signoff_version')).toEqual([v2.version_id])
    expect(await refs(oldFile, 'item_attachment')).toEqual([])
    expect(await refs(oldFile, 'signoff_version')).toEqual([v1.version_id])
    expect(await recipientsOf('signoff.content_changed', v2.version_id)).toEqual([...g1.members.map((m) => m.id), g1.teacher!.id].sort())
    expect(await eventsOfType('signoff.version_created', v2.version_id)).toBe(0)
    expect(await recipientsOf('signoff.superseded', v1.version_id)).toEqual([])

    // 換檔後舊版下載：系辦與該舊版參與者 200；沒有可讀簽核版本的人仍被拒。
    expect(await canDownload(admin(), oldFile)).toBe(true)
    expect(await canDownload(student(g1.members[1]!), oldFile)).toBe(true)
    expect(await canDownload(teacher(g1.teacher!), oldFile)).toBe(true)
    const stranger = await newUser('路人', 'student', cohortId)
    expect(await canDownload(student(stranger), oldFile)).toBe(false)
    const outsider = await newUser('別的老師', 'teacher')
    expect(await canDownload(teacher(outsider), oldFile)).toBe(false)
  })

  it('撤回 → 改正文 → 重新發布（Review r1）：每組建第 2 版、cause content_change、參與者各收一則 content_changed、沒有 version_created；撤回 → 沒改 → 發布：不建新版、不發通知', async () => {
    const cohortId = await newCohort()
    const g1 = await newGroup(cohortId, 'G01')
    const g2 = await newGroup(cohortId, 'G02')
    const item = await createItem(cohortId)
    const published = await mustPublish(item.itemId, item.revision)
    const v1 = (await packageOf(item.itemId, g1.groupId))!
    expect((await vote(student(g1.members[0]!), v1.version_id)).ok).toBe(true)

    // 撤回 → 沒改 → 重新發布：同一份內容不再建版、不再通知。
    const withdrawn = await items.changeStatus(admin(), item.itemId, published.revision, 'withdraw', randomUUID())
    if (!withdrawn.ok) throw new Error(`${withdrawn.code} ${withdrawn.message}`)
    const quiet = new Date()
    const republished = await mustPublish(item.itemId, withdrawn.receipt.revision)
    expect(republished.consent).toEqual({ created: 0, skipped: [] })
    expect((await packageOf(item.itemId, g1.groupId))!.version_id).toBe(v1.version_id)
    expect(await count(`select count(*) as n from domain_events where type like 'signoff.%' and occurred_real_at >= $1`, [quiet])).toBe(0)

    // 撤回 → 改正文 → 重新發布：內容變＝全員重新同意（§6.4）。
    const withdrawn2 = await items.changeStatus(admin(), item.itemId, republished.revision, 'withdraw', randomUUID())
    if (!withdrawn2.ok) throw new Error(`${withdrawn2.code} ${withdrawn2.message}`)
    const saved = await items.saveDraft(admin(), item.itemId, withdrawn2.receipt.revision, consentInput(cohortId, { body: '<p>撤回後改過的內容。</p>' }), randomUUID())
    if (!saved.ok) throw new Error(`${saved.code} ${saved.message}`)
    const since = new Date()
    const again = await mustPublish(item.itemId, saved.receipt.revision)
    expect(again.consent).toEqual({ created: 2, skipped: [] })
    for (const g of [g1, g2]) {
      const v2 = (await packageOf(item.itemId, g.groupId))!
      expect(v2).toMatchObject({ version_no: 2, state: 'collecting', supersede_cause: 'content_change' })
      expect(v2.content_checksum).toBe(sha256('<p>撤回後改過的內容。</p>'))
      expect(await recipientsOf('signoff.content_changed', v2.version_id)).toEqual([...g.members.map((m) => m.id), g.teacher!.id].sort())
      expect(await eventsOfType('signoff.version_created', v2.version_id)).toBe(0)
    }
    expect(await statusOf(v1.version_id)).toEqual({ state: 'superseded', cause: 'content_change' })
    expect(await count('select count(*) as n from approvals where version_id = $1', [v1.version_id])).toBe(1)
    for (const u of [...g1.members, g1.teacher!]) expect(await receivedBy(u.id, 'signoff.content_changed', since)).toBe(1)
  })

  it('重新發布時最終文件授權已凍結範圍的組不因此刻缺草稿被擋：內容沒變不建版；內容有變沿用舊範圍建新版、只發 content_changed（Review r1 選用 3）', async () => {
    const cohortId = await newCohort()
    const g1 = await newGroup(cohortId, 'G01')
    const g2 = await newGroup(cohortId, 'G02')
    await showcaseDraft(cohortId, g1.groupId, '題目一')
    const entry2 = await showcaseDraft(cohortId, g2.groupId, '題目二')
    const item = await createItem(cohortId, { consentPurpose: 'final_document' })
    await mustPublish(item.itemId, item.revision)
    const v1 = (await packageOf(item.itemId, g2.groupId))!
    // G02 的草稿之後沒了（此刻查不到可凍結的草稿）。作業模組自己的發布前檢查 `consent_drafts`（pg-items.ts，不在本票範圍）
    // 會先擋住整筆重新發布，所以這裡直接驅動 hook 驗它的規則。
    await owner.sql('delete from showcase_drafts where entry_id = $1', [entry2])
    const run = async (bodyHtml: string) => {
      const client = await app.connect()
      try {
        await client.query('begin')
        const r = await hook.onPublished(
          client,
          { id: item.itemId, cohortId, groupIds: [g1.groupId, g2.groupId], bodyHtml, attachmentFileIds: [], purpose: 'final_document', dueAt: null },
          adminId,
          randomUUID(),
        )
        await client.query(r.ok ? 'commit' : 'rollback')
        return r
      } finally {
        client.release()
      }
    }
    // 內容沒變：兩組都有一版在跑，不查草稿、不建版、不通知。
    const quiet = new Date()
    expect(await run('<p>本組同意期中結果。</p>')).toMatchObject({ ok: true, receipt: { created: 0, skipped: [] } })
    expect((await packageOf(item.itemId, g2.groupId))!.version_id).toBe(v1.version_id)
    expect(await count(`select count(*) as n from domain_events where type like 'signoff.%' and occurred_real_at >= $1`, [quiet])).toBe(0)
    // 內容有變：沿用舊版凍結的範圍建新版，不因 G02 缺草稿被擋。
    expect(await run('<p>改過。</p>')).toMatchObject({ ok: true, receipt: { created: 2, skipped: [] } })
    const v2 = (await packageOf(item.itemId, g2.groupId))!
    expect(v2).toMatchObject({ version_no: 2, supersede_cause: 'content_change' })
    expect(v2.content_checksum).toBe(sha256('<p>改過。</p>'))
    expect(v2.authorization_scope).toMatchObject({ title: '題目二' })
    expect(await statusOf(v1.version_id)).toEqual({ state: 'superseded', cause: 'content_change' })
    expect(await recipientsOf('signoff.content_changed', v2.version_id)).toEqual([...g2.members.map((m) => m.id), g2.teacher!.id].sort())
    expect(await eventsOfType('signoff.version_created', v2.version_id)).toBe(0)
  })

  it('退回修正中的包改內容也建新版；已失效（組員變更）的不動', async () => {
    const cohortId = await newCohort()
    const g1 = await newGroup(cohortId, 'G01')
    const g2 = await newGroup(cohortId, 'G02')
    const item = await createItem(cohortId)
    const published = await mustPublish(item.itemId, item.revision)
    const v1 = (await packageOf(item.itemId, g1.groupId))!
    expect((await vote(student(g1.members[0]!), v1.version_id, 'reject', '錯字')).ok).toBe(true)
    expect((await statusOf(v1.version_id)).state).toBe('revision')
    const w1 = (await packageOf(item.itemId, g2.groupId))!
    const newcomer = await newUser('新組員', 'student', cohortId)
    const added = await groups.addMember(admin(), { groupId: g2.groupId, revision: await revisionOf(g2.groupId), studentNo: newcomer.studentNo!, reason: '加入' }, randomUUID())
    if (!added.ok) throw new Error(added.message)
    expect(await statusOf(w1.version_id)).toEqual({ state: 'superseded', cause: 'member_change' })

    await mustUpdate(item.itemId, published.revision, consentInput(cohortId, { body: '<p>修正後。</p>' }))
    expect((await packageOf(item.itemId, g1.groupId))!.version_no).toBe(2)
    expect(await statusOf(v1.version_id)).toEqual({ state: 'superseded', cause: 'content_change' })
    expect((await packageOf(item.itemId, g2.groupId))!.version_id).toBe(w1.version_id)
  })
})

describe('理由選填與固定代碼（AC-22a、AC-25、AC-25a）', () => {
  it('學生不同意、老師退回理由留空都成功：approvals.reason null、cause 固定代碼 disagree／return；作廢理由留空：cause=void、稽核理由 null', async () => {
    const cohortId = await newCohort()
    const g1 = await newGroup(cohortId, 'G01', { size: 2 })
    const g2 = await newGroup(cohortId, 'G02', { size: 1 })
    const item = await createItem(cohortId)
    await mustPublish(item.itemId, item.revision)
    const v1 = (await packageOf(item.itemId, g1.groupId))!
    const r = await vote(student(g1.members[1]!), v1.version_id, 'reject', '  ')
    expect(r).toMatchObject({ ok: true, receipt: { state: 'revision', result: 'disagree' } })
    expect((await owner.sql('select reason from approvals where version_id = $1 and user_id = $2', [v1.version_id, g1.members[1]!.id])).rows[0]!.reason).toBeNull()
    expect(await statusOf(v1.version_id)).toEqual({ state: 'revision', cause: 'disagree' })

    const w1 = (await packageOf(item.itemId, g2.groupId))!
    expect((await vote(student(g2.members[0]!), w1.version_id)).ok).toBe(true)
    expect(await vote(teacher(g2.teacher!), w1.version_id, 'reject', null)).toMatchObject({ ok: true, receipt: { state: 'revision', result: 'return' } })
    expect(await statusOf(w1.version_id)).toEqual({ state: 'revision', cause: 'return' })
    expect((await owner.sql('select reason from approvals where version_id = $1 and user_id = $2', [w1.version_id, g2.teacher!.id])).rows[0]!.reason).toBeNull()

    // 作廢理由留空。
    const voided = await signoff.voidVersion(admin(), { versionId: w1.version_id, reason: '' }, randomUUID())
    expect(voided.ok).toBe(true)
    expect(await statusOf(w1.version_id)).toEqual({ state: 'void', cause: 'void' })
    const audit = (await owner.sql(`select reason, payload from audit_events where action = 'signoff.version_void' and target_id = $1`, [w1.version_id])).rows[0]!
    expect(audit.reason).toBeNull()
    expect(audit.payload).toMatchObject({ cause: 'void', reason: null })
    // 有填理由：cause 仍是固定代碼，理由進稽核與事件 payload。
    const v2 = await signoff.reopen(admin(), { versionId: v1.version_id }, randomUUID())
    if (!v2.ok) throw new Error(v2.message)
    expect(await signoff.voidVersion(admin(), { versionId: v2.receipt.versionId, reason: '這組改期' }, randomUUID())).toMatchObject({ ok: true })
    expect(await statusOf(v2.receipt.versionId)).toEqual({ state: 'void', cause: 'void' })
    expect((await owner.sql(`select reason from audit_events where action = 'signoff.version_void' and target_id = $1`, [v2.receipt.versionId])).rows[0]!.reason).toBe('這組改期')
    expect((await owner.sql(`select payload from domain_events where type = 'signoff.voided' and source_id = $1`, [v2.receipt.versionId])).rows[0]!.payload).toMatchObject({ reason: '這組改期', cause: 'void' })
    // 太長仍被擋。
    expect(await signoff.voidVersion(admin(), { versionId: v2.receipt.versionId, reason: 'x'.repeat(501) }, randomUUID())).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
  })

  it('有 item 附件的同意書：重新收集、重開理由留空都成功，附件依實際用途（attachment）重綁、組員收到輪到你同意、稽核 payload reason null；舊 API 的繳交檔包重新收集也成功', async () => {
    const cohortId = await newCohort()
    const g1 = await newGroup(cohortId, 'G01', { size: 2 })
    const fileId = await uploadAttachment(cohortId)
    const item = await createItem(cohortId, { attachmentFileIds: [fileId] })
    await mustPublish(item.itemId, item.revision)
    const v1 = (await packageOf(item.itemId, g1.groupId))!

    const reset = await signoff.reset(admin(), { versionId: v1.version_id, reason: ' ' }, randomUUID())
    if (!reset.ok) throw new Error(`${reset.code} ${reset.message}`)
    expect(reset.receipt).toMatchObject({ kind: 'reset', versionNo: 2, supersededVersionNo: 1 })
    expect(await statusOf(v1.version_id)).toEqual({ state: 'superseded', cause: 'reset' })
    expect(await refs(fileId, 'signoff_version')).toEqual([v1.version_id, reset.receipt.versionId].sort())
    expect(await recipientsOf('signoff.version_created', reset.receipt.versionId)).toEqual(g1.members.map((m) => m.id).sort())
    const resetAudit = (await owner.sql(`select reason, payload from audit_events where action = 'signoff.version_reset' and target_id = $1`, [v1.version_id])).rows[0]!
    expect(resetAudit.reason).toBeNull()
    expect(resetAudit.payload).toMatchObject({ reason: null })
    expect((await owner.sql(`select payload from domain_events where type = 'signoff.restarted' and source_id = $1`, [v1.version_id])).rows[0]!.payload).toMatchObject({ reason: null })

    // 退回後重開，理由留空。
    expect((await vote(student(g1.members[0]!), reset.receipt.versionId, 'reject')).ok).toBe(true)
    const reopened = await signoff.reopen(admin(), { versionId: reset.receipt.versionId, reason: null }, randomUUID())
    if (!reopened.ok) throw new Error(`${reopened.code} ${reopened.message}`)
    expect(reopened.receipt).toMatchObject({ kind: 'reopen', versionNo: 3 })
    expect(await statusOf(reset.receipt.versionId)).toEqual({ state: 'superseded', cause: 'reset' })
    expect(await refs(fileId, 'signoff_version')).toHaveLength(3)
    expect((await owner.sql(`select reason from audit_events where action = 'signoff.version_reopen' and target_id = $1`, [reset.receipt.versionId])).rows[0]!.reason).toBeNull()
    expect(await canDownload(student(g1.members[1]!), fileId)).toBe(true)

    // 舊 API：繳交檔來源的包重新收集，仍以 submission 用途重綁。
    const g2 = await newGroup(cohortId, 'G02', { size: 1 })
    const legacyFile = await submittedFile(cohortId, g2)
    const legacy = await signoff.createVersion(admin(), { groupId: g2.groupId, purpose: 'result_confirmation', content: '舊 API', attachmentFileIds: [legacyFile], showcaseEntryId: null }, randomUUID())
    if (!legacy.ok) throw new Error(legacy.message)
    const legacyReset = await signoff.reset(admin(), { versionId: legacy.receipt.versionId }, randomUUID())
    if (!legacyReset.ok) throw new Error(`${legacyReset.code} ${legacyReset.message}`)
    expect(await refs(legacyFile, 'signoff_version')).toEqual([legacy.receipt.versionId, legacyReset.receipt.versionId].sort())
  })
})

/** 這一組正式送出過一個 PDF（舊 API 附件來源用）。 */
async function submittedFile(cohortId: string, g: Group): Promise<string> {
  const item = await owner.sql(
    `insert into managed_items (id, cohort_id, placement, audience_kind, title, created_by_kind) values (gen_random_uuid(), $1, 'news', 'public', '期末報告繳交', 'system') returning id`,
    [cohortId],
  )
  const schema = await owner.sql(
    `insert into form_schema_versions (id, item_id, version_no, schema, created_by_user_id) values (gen_random_uuid(), $1, 1, '{"fields":[]}'::jsonb, $2) returning id`,
    [item.rows[0]!.id, adminId],
  )
  const version = await owner.sql(
    `insert into submission_versions
       (id, item_id, receiver_kind, receiver_id, version_no, schema_version_id, answers, submitted_by_user_id,
        received_real_at, received_business_at, request_id, membership_snapshot, deadline_version_at_submit)
     values (gen_random_uuid(), $1, 'group', $2, 1, $3, '{}'::jsonb, $4, now(), now(), gen_random_uuid(), $5::jsonb, 1) returning id`,
    [item.rows[0]!.id, g.groupId, schema.rows[0]!.id, g.members[0]!.id, JSON.stringify(g.members.map((m) => m.id))],
  )
  const bytes = Buffer.from('%PDF-1.7\n報告\n')
  const checksum = sha256(bytes.toString())
  const key = `files/2027/01/${randomUUID()}`
  await fs.mkdir(path.dirname(path.join(root, key)), { recursive: true })
  await fs.writeFile(path.join(root, key), bytes)
  const file = await owner.sql(
    `insert into stored_files (id, owner_user_id, scope, cohort_id, purpose, original_name, size_bytes, mime_declared, mime_detected,
                               extension, checksum, status, storage_key, uploaded_real_at, finalized_at)
     values (gen_random_uuid(), $1, 'cohort', $2, 'submission', '期末報告.pdf', $3, 'application/pdf', 'application/pdf', 'pdf', $4,
             'stored', $5, now(), now()) returning id`,
    [g.members[0]!.id, cohortId, bytes.length, checksum, key],
  )
  const fileId = String(file.rows[0]!.id)
  await owner.sql(`insert into submission_files (submission_version_id, file_id, field_key, checksum) values ($1, $2, 'report', $3)`, [version.rows[0]!.id, fileId, checksum])
  await owner.sql(`insert into file_references (id, file_id, ref_type, ref_id) values (gen_random_uuid(), $1, 'submission_version', $2)`, [fileId, version.rows[0]!.id])
  return fileId
}

describe('補建、對象減組、並發', () => {
  it('補建（AC-25）：指派老師後系辦按「建立」→ 收集中、組員收到通知；沒指派不能建；已有包再按 CONFLICT；同請求編號回同一張回執', async () => {
    const cohortId = await newCohort()
    const g1 = await newGroup(cohortId, 'G01', { advisor: false })
    const g2 = await newGroup(cohortId, 'G02')
    const item = await createItem(cohortId)
    const published = await mustPublish(item.itemId, item.revision)
    expect(published.consent).toEqual({ created: 1, skipped: [{ groupId: g1.groupId, reason: 'no_advisor' }] })

    const refused = await hook.createForGroup(admin(), { itemId: item.itemId, groupId: g1.groupId }, randomUUID())
    expect(refused).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    expect(refused.ok || refused.message).toContain('沒有指導老師')
    const t = await newUser('新老師', 'teacher')
    await assignAdvisor(g1.groupId, t.id)
    expect(await hook.createForGroup(teacher(t), { itemId: item.itemId, groupId: g1.groupId }, randomUUID())).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    const requestId = randomUUID()
    const built = await hook.createForGroup(admin(), { itemId: item.itemId, groupId: g1.groupId }, requestId)
    if (!built.ok) throw new Error(`${built.code} ${built.message}`)
    const replay = await hook.createForGroup(admin(), { itemId: item.itemId, groupId: g1.groupId }, requestId)
    expect(replay.ok && replay.receipt.versionId).toBe(built.receipt.versionId)
    const pkg = (await packageOf(item.itemId, g1.groupId))!
    expect(pkg).toMatchObject({ id: built.receipt.packageId, version_id: built.receipt.versionId, version_no: 1, state: 'collecting' })
    expect(pkg.participants.advisor.userId).toBe(t.id)
    expect(await recipientsOf('signoff.version_created', built.receipt.versionId)).toEqual(g1.members.map((m) => m.id).sort())
    expect(await hook.createForGroup(admin(), { itemId: item.itemId, groupId: g1.groupId }, randomUUID())).toMatchObject({ ok: false, code: 'CONFLICT' })
    expect(await hook.createForGroup(admin(), { itemId: item.itemId, groupId: g2.groupId }, randomUUID())).toMatchObject({ ok: false, code: 'CONFLICT' })
    // 不在對象裡的組、不是同意書的作業。
    const g3 = await newGroup(await newCohort(), 'G03')
    expect(await hook.createForGroup(admin(), { itemId: item.itemId, groupId: g3.groupId }, randomUUID())).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    const board = await query.itemBoard(admin(), item.itemId)
    expect(board.ok && board.receipt.rows.map((r) => [r.groupCode, r.state])).toEqual([
      ['G01', 'collecting'],
      ['G02', 'collecting'],
    ])
  })

  it('補建封存後重播（AC-55、AC-56c）：封存前成功過的同一請求編號，封存後重送回 COHORT_ARCHIVED，帳本與包不變', async () => {
    const cohortId = await newCohort()
    const g1 = await newGroup(cohortId, 'G01', { advisor: false })
    await newGroup(cohortId, 'G02')
    const item = await createItem(cohortId)
    await mustPublish(item.itemId, item.revision)
    await assignAdvisor(g1.groupId, (await newUser('補建老師', 'teacher')).id)
    const requestId = randomUUID()
    const built = await hook.createForGroup(admin(), { itemId: item.itemId, groupId: g1.groupId }, requestId)
    if (!built.ok) throw new Error(`${built.code} ${built.message}`)

    await owner.sql(`update cohorts set status = 'archived' where id = $1`, [cohortId])
    const ledger = async () => (await owner.sql('select * from operation_records where request_id = $1', [requestId])).rows
    const before = { ledger: await ledger(), pkg: await packageOf(item.itemId, g1.groupId) }
    const replay = await hook.createForGroup(admin(), { itemId: item.itemId, groupId: g1.groupId }, requestId)
    expect(replay).toMatchObject({ ok: false, code: 'COHORT_ARCHIVED' })
    expect({ ledger: await ledger(), pkg: await packageOf(item.itemId, g1.groupId) }).toEqual(before)
  })

  it('對象減組：移出的組目前版本作廢，cause=void、理由「系辦移出對象」；對象加組：新組建包', async () => {
    const cohortId = await newCohort()
    const g1 = await newGroup(cohortId, 'G01')
    const g2 = await newGroup(cohortId, 'G02')
    const g3 = await newGroup(cohortId, 'G03')
    const base = { audienceKind: 'groups' as const, groupIds: [g1.groupId, g2.groupId] }
    const item = await createItem(cohortId, base)
    const published = await mustPublish(item.itemId, item.revision)
    const v2 = (await packageOf(item.itemId, g2.groupId))!

    const narrowed = await mustUpdate(item.itemId, published.revision, consentInput(cohortId, { ...base, groupIds: [g1.groupId] }))
    expect(await statusOf(v2.version_id)).toEqual({ state: 'void', cause: 'void' })
    const audit = (await owner.sql(`select reason, payload from audit_events where action = 'signoff.version_void' and target_id = $1`, [v2.version_id])).rows[0]!
    expect(audit.reason).toBe('系辦移出對象')
    expect(audit.payload).toMatchObject({ cause: 'void', reason: '系辦移出對象' })
    expect((await packageOf(item.itemId, g1.groupId))!.version_no).toBe(1)

    // 加組：對象多了 G03 → 不會自動建包（名單重算不等於發布），系辦補建。
    await mustUpdate(item.itemId, narrowed.revision, consentInput(cohortId, { ...base, groupIds: [g1.groupId, g3.groupId] }))
    expect(await packageOf(item.itemId, g3.groupId)).toBeNull()
    const built = await hook.createForGroup(admin(), { itemId: item.itemId, groupId: g3.groupId }, randomUUID())
    expect(built.ok).toBe(true)
    expect((await packageOf(item.itemId, g3.groupId))!.state).toBe('collecting')
  })

  it('並發：發布同意書 vs 同時加組員，只會一先一後——新版快照含新組員，或剛建的版本被標失效（member_change）', async () => {
    const cohortId = await newCohort()
    const g1 = await newGroup(cohortId, 'G01', { size: 2 })
    const newcomer = await newUser('新組員', 'student', cohortId)
    const item = await createItem(cohortId)
    const revision = await revisionOf(g1.groupId)
    const [published, added] = await Promise.all([
      publish(item.itemId, item.revision),
      groups.addMember(admin(), { groupId: g1.groupId, revision, studentNo: newcomer.studentNo!, reason: '並發' }, randomUUID()),
    ])
    if (!published.ok) throw new Error(`${published.code} ${published.message}`)
    if (!added.ok) throw new Error(`${added.code} ${added.message}`)
    const pkg = (await packageOf(item.itemId, g1.groupId))!
    const ids = pkg.participants.students.map((s) => s.userId)
    if (ids.includes(newcomer.id)) {
      expect(ids).toHaveLength(3)
      expect(pkg.state).toBe('collecting')
    } else {
      expect(ids).toHaveLength(2)
      expect(await statusOf(pkg.version_id)).toEqual({ state: 'superseded', cause: 'member_change' })
    }
  })
})
