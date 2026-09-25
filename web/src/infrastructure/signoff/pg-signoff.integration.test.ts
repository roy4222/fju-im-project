import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { assertTestDatabaseReachable, createIsolatedDatabase, poolAsRole, type IsolatedDatabase } from '../../../test/db'
import { migratedSchema } from '../../../test/migrations'
import type { ResolvedActor } from '@/application/accounts'
import type { CreateVersionInput } from '@/application/signoff'
import { PgGroupCommand } from '@/infrastructure/groups/pg-groups'
import { PgDueWorkScheduler } from '@/infrastructure/notifications/pg-due-work-scheduler'
import { PgEventPublisher } from '@/infrastructure/notifications/pg-event-publisher'
import { PgAuditWriter, sha256 } from '@/infrastructure/ops/audit-writer'
import { FsFileStorage } from '@/infrastructure/ops/file-storage'
import { PgOperationLedger } from '@/infrastructure/ops/operation-ledger'
import { PgShowcaseCommand } from '@/infrastructure/showcase/pg-showcase'
import { createPosterPolicy } from '@/infrastructure/showcase/poster-policy'
import { PgSignoffCommand, PgSignoffQuery } from '@/infrastructure/signoff/pg-signoff'

/**
 * 票 25／S11-04：管理員建簽核版本（貼全文、選附件、快照參與者；最終文件授權從精選草稿凍結範圍），
 * 以及成員集合改變時同交易讓目前版本失效（票 14 的 `group.members_changed` 掛點）。
 *
 * 全部以正式執行角色 `fju_app` 連線。驗：
 * - 建版寫入簽核包、版本內容、狀態列與 `file_references`；參與者＝實際有效成員（三人組就三人）＋主指導（含 assignmentId）。
 * - 全文必填、清洗後存、checksum＝sha256(清洗後全文)；附件只能是這一組正式送出的檔案。
 * - 最終文件授權：沒選草稿拒、選別組的草稿拒、期中選了草稿拒；凍結的範圍等於草稿當下，之後改草稿版本內容不變。
 * - 同組同用途再建一版：舊版 superseded（content_change）、目前版本換過去、兩列版本都在。
 * - 同請求編號重送只建一版；非管理員 FORBIDDEN；沒有主指導 VALIDATION_FAILED；解散 GROUP_DISSOLVED。
 * - 事件「輪到你同意」的收件人＝參與學生（不含老師、管理員）。
 * - 加入／移出組員：目前版本同交易 superseded（member_change）、版本列數不變（不自動建新版）、只換組長不動。
 * - 讀取邊界：管理員、參與者、此刻組員與主指導讀得到；別組學生、別的老師 FORBIDDEN。
 */

let owner: IsolatedDatabase
let app: Pool
let root: string
let storage: FsFileStorage
let signoff: PgSignoffCommand
let query: PgSignoffQuery
let showcase: PgShowcaseCommand
let groups: PgGroupCommand
let adminId: string
const businessClock = { now: async () => new Date('2027-01-05T02:00:00Z') }

function actor(userId: string, roles: ('admin' | 'teacher' | 'student')[]): ResolvedActor {
  return { kind: 'authenticated', userId, roles, status: 'active', mustChangePassword: false, cohortMemberships: [] }
}
const admin = () => actor(adminId, ['admin'])

let seq = 0
async function newUser(name: string, role: 'admin' | 'teacher' | 'student', cohortId?: string) {
  seq += 1
  const email = `so${seq}-${randomUUID().slice(0, 8)}@example.com`
  const row = await owner.sql(
    `insert into users (id, name, email, email_verified, updated_at, status) values (gen_random_uuid(), $1, $2, true, now(), 'active') returning id`,
    [name, email],
  )
  const id = String(row.rows[0]!.id)
  await owner.sql(
    `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at) values (gen_random_uuid(), $1, $2, $1, now())`,
    [id, role],
  )
  const studentNo = role === 'student' ? `4110${String(seq).padStart(5, '0')}` : null
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

async function scenario(options: { size?: number; advisor?: boolean } = {}) {
  seq += 1
  const cohort = await owner.sql(
    `insert into cohorts (id, code, name, status, year_end_date, group_size_min, group_size_max, created_by_kind)
     values (gen_random_uuid(), $1, $1, 'active', '2027-06-30', 3, 5, 'system') returning id`,
    [`SO-${seq}`],
  )
  const cohortId = String(cohort.rows[0]!.id)
  const members: Person[] = []
  for (let i = 0; i < (options.size ?? 5); i += 1) members.push(await newUser(`學生${seq}-${i + 1}`, 'student', cohortId))
  const teacher = await newUser(`老師${seq}`, 'teacher')
  const group = await owner.sql(
    `insert into groups (id, cohort_id, code, group_type, established_real_at, established_business_at, created_by_kind)
     values (gen_random_uuid(), $1, 'G01', 'general', now(), now(), 'system') returning id`,
    [cohortId],
  )
  const groupId = String(group.rows[0]!.id)
  for (const m of members) {
    await owner.sql(
      `insert into group_memberships (id, group_id, cohort_id, user_id, valid_from, added_by_kind) values (gen_random_uuid(), $1, $2, $3, now() - interval '1 day', 'system')`,
      [groupId, cohortId, m.id],
    )
  }
  await owner.sql(
    `insert into group_leaders (id, group_id, user_id, valid_from, changed_by_user_id) values (gen_random_uuid(), $1, $2, now() - interval '1 day', $3)`,
    [groupId, members[0]!.id, adminId],
  )
  let assignmentId: string | null = null
  if (options.advisor ?? true) {
    const a = await owner.sql(
      `insert into advisor_assignments (id, group_id, teacher_user_id, source, valid_from, assigned_by_user_id, reason)
       values (gen_random_uuid(), $1, $2, 'admin', now(), $3, '指派') returning id`,
      [groupId, teacher.id, adminId],
    )
    assignmentId = String(a.rows[0]!.id)
  }
  return { cohortId, groupId, members, teacher, assignmentId }
}

type Scenario = Awaited<ReturnType<typeof scenario>>

/** 這一組正式送出過一個 PDF（模擬票 21 的結果：送出版本、附件、版本持有的檔案引用）。 */
async function submittedFile(s: Scenario, name = '期末報告.pdf'): Promise<string> {
  const item = await owner.sql(
    `insert into managed_items (id, cohort_id, placement, audience_kind, title, created_by_kind)
     values (gen_random_uuid(), $1, 'news', 'public', '期末報告繳交', 'system') returning id`,
    [s.cohortId],
  )
  const itemId = String(item.rows[0]!.id)
  const schema = await owner.sql(
    `insert into form_schema_versions (id, item_id, version_no, schema, created_by_user_id)
     values (gen_random_uuid(), $1, 1, '{"fields":[]}'::jsonb, $2) returning id`,
    [itemId, adminId],
  )
  const version = await owner.sql(
    `insert into submission_versions
       (id, item_id, receiver_kind, receiver_id, version_no, schema_version_id, answers, submitted_by_user_id,
        received_real_at, received_business_at, request_id, membership_snapshot, deadline_version_at_submit)
     values (gen_random_uuid(), $1, 'group', $2, 1, $3, '{}'::jsonb, $4, now(), now(), gen_random_uuid(), '[]'::jsonb, 1) returning id`,
    [itemId, s.groupId, String(schema.rows[0]!.id), s.members[0]!.id],
  )
  const versionId = String(version.rows[0]!.id)
  const checksum = sha256(`${name}-${randomUUID()}`)
  const file = await owner.sql(
    `insert into stored_files (id, owner_user_id, scope, cohort_id, purpose, original_name, size_bytes, mime_declared, mime_detected,
                               extension, checksum, status, storage_key, uploaded_real_at, finalized_at)
     values (gen_random_uuid(), $1, 'cohort', $2, 'submission', $3, 100, 'application/pdf', 'application/pdf', 'pdf', $4,
             'stored', $5, now(), now()) returning id`,
    [s.members[0]!.id, s.cohortId, name, checksum, `k-${randomUUID()}`],
  )
  const fileId = String(file.rows[0]!.id)
  await owner.sql(`insert into submission_files (submission_version_id, file_id, field_key, checksum) values ($1, $2, 'report', $3)`, [
    versionId,
    fileId,
    checksum,
  ])
  await owner.sql(`insert into file_references (id, file_id, ref_type, ref_id) values (gen_random_uuid(), $1, 'submission_version', $2)`, [
    fileId,
    versionId,
  ])
  return fileId
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

/** 這一組的精選草稿：題目、摘要、影片、PNG 海報。 */
async function showcaseDraft(s: Scenario, fields: { title?: string; summary?: string } = {}) {
  const created = await showcase.createDraft(admin(), { groupId: s.groupId }, randomUUID())
  if (!created.ok) throw new Error(created.message)
  const entryId = created.receipt.entryId
  const ticket = await showcase.requestPosterUpload(admin(), { entryId, fileName: 'poster.png', declaredMime: 'image/png', declaredSize: PNG.length })
  if (!ticket.ok) throw new Error(ticket.message)
  const uploaded = await storage.upload(adminId, ticket.receipt.ticket, streamOf(PNG), PNG.length)
  if (!uploaded.ok) throw new Error(uploaded.message)
  const saved = await showcase.updateDraft(
    admin(),
    {
      entryId,
      revision: 1,
      title: fields.title ?? '智慧校園導覽',
      summary: fields.summary ?? '用室內定位帶新生認識校園。',
      videoUrl: 'https://youtu.be/demo',
      posterFileId: uploaded.receipt.fileId,
    },
    randomUUID(),
  )
  if (!saved.ok) throw new Error(saved.message)
  return { entryId, posterFileId: uploaded.receipt.fileId, posterChecksum: uploaded.receipt.checksum, revision: saved.receipt.revision }
}

function input(s: Scenario, overrides: Partial<CreateVersionInput> = {}): CreateVersionInput {
  return {
    groupId: s.groupId,
    purpose: 'result_confirmation',
    content: '本組確認期中結果如下。\n\n第二段。',
    attachmentFileIds: [],
    showcaseEntryId: null,
    ...overrides,
  }
}

async function mustCreate(s: Scenario, overrides: Partial<CreateVersionInput> = {}) {
  const r = await signoff.createVersion(admin(), input(s, overrides), randomUUID())
  if (!r.ok) throw new Error(`${r.code} ${r.message}`)
  return r.receipt
}

async function statusOf(versionId: string) {
  return (await owner.sql('select state, cause from signoff_version_status where version_id = $1', [versionId])).rows[0]
}

async function count(sql: string, values: unknown[] = []): Promise<number> {
  return Number((await owner.sql(sql, values)).rows[0]!.n)
}

beforeAll(async () => {
  await assertTestDatabaseReachable()
  owner = await createIsolatedDatabase({ label: 'signoff', setup: migratedSchema })
  app = await poolAsRole(owner, 'fju_app')
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'fju-signoff-files-'))
  const a = await owner.sql(
    `insert into users (id, name, email, email_verified, updated_at, status) values (gen_random_uuid(), '系辦', 'so-admin@example.com', true, now(), 'active') returning id`,
  )
  adminId = String(a.rows[0]!.id)
  storage = new FsFileStorage({
    root: () => root,
    environmentMaxBytes: () => 100 * 1024 * 1024,
    ticketSecret: () => 'signoff-secret-signoff-secret-signoff-secret',
    policies: { poster: createPosterPolicy(() => app) },
    db: () => app,
  })
  const common = { audit: new PgAuditWriter(), ledger: new PgOperationLedger(() => app), businessClock, pool: () => app }
  signoff = new PgSignoffCommand({ ...common, events: new PgEventPublisher(), files: storage })
  query = new PgSignoffQuery({ pool: () => app })
  showcase = new PgShowcaseCommand({ ...common, files: storage })
  groups = new PgGroupCommand({
    ...common,
    events: new PgEventPublisher(),
    dueWork: new PgDueWorkScheduler({ testKindsEnabled: false }),
    signoff,
  })
})

afterAll(async () => {
  await app?.end()
  await owner?.close()
  await fs.rm(root, { recursive: true, force: true })
})

describe('建版（SGN-01）', () => {
  it('期中結果確認：寫簽核包、版本內容、狀態列；參與者＝五位有效組員＋主指導；全文清洗後存、checksum 是清洗後的 sha256', async () => {
    const s = await scenario()
    const fileId = await submittedFile(s)
    const receipt = await mustCreate(s, { content: '<p>內容<script>alert(1)</script></p><p onclick="x()">第二段</p>', attachmentFileIds: [fileId] })
    expect(receipt).toMatchObject({ versionNo: 1, studentCount: 5, advisorName: s.teacher.name, supersededVersionNo: null })

    const version = (
      await owner.sql(
        `select v.content_text, v.content_checksum, v.participants, v.attachment_file_versions, v.supersede_cause, v.authorization_scope,
                p.current_version_id, p.purpose
           from signoff_package_versions v join signoff_packages p on p.id = v.package_id where v.id = $1`,
        [receipt.versionId],
      )
    ).rows[0]!
    expect(version.content_text).toBe('<p>內容</p><p>第二段</p>')
    expect(version.content_checksum).toBe(sha256('<p>內容</p><p>第二段</p>'))
    expect(version.current_version_id).toBe(receipt.versionId)
    expect(version.supersede_cause).toBeNull()
    expect(version.authorization_scope).toBeNull()
    const participants = version.participants as { students: { userId: string }[]; advisor: unknown }
    expect(participants.students.map((p) => p.userId).sort()).toEqual(s.members.map((m) => m.id).sort())
    expect(participants.students[0]).toMatchObject({ studentNo: s.members[0]!.studentNo, displayName: s.members[0]!.name })
    expect(participants.advisor).toEqual({ userId: s.teacher.id, displayName: s.teacher.name, assignmentId: s.assignmentId })
    expect(version.attachment_file_versions).toEqual([
      expect.objectContaining({ fileId, name: '期末報告.pdf', source: { itemTitle: '期末報告繳交', versionNo: 1 } }),
    ])
    expect(await statusOf(receipt.versionId)).toEqual({ state: 'collecting', cause: null })
    expect(
      await count(`select count(*) as n from file_references where ref_type = 'signoff_version' and ref_id = $1 and released_at is null`, [
        receipt.versionId,
      ]),
    ).toBe(1)
  })

  it('三人組按實際三人快照（SGN-07）；每位參與學生收到「輪到你同意」，老師、管理員沒有', async () => {
    const s = await scenario({ size: 3 })
    const receipt = await mustCreate(s)
    expect(receipt.studentCount).toBe(3)
    const events = await owner.sql(
      `select recipients, payload from domain_events where type = 'signoff.version_created' and source_id = $1`,
      [receipt.versionId],
    )
    expect(events.rows).toHaveLength(1)
    expect([...(events.rows[0]!.recipients as string[])].sort()).toEqual(s.members.map((m) => m.id).sort())
    expect(events.rows[0]!.recipients).not.toContain(s.teacher.id)
    expect(events.rows[0]!.recipients).not.toContain(adminId)
    expect(JSON.stringify(events.rows[0]!.payload)).not.toContain('確認期中結果')
  })

  it('拒絕：全文空、附件不是這組正式送出的、沒有主指導、非管理員、組別解散；都沒寫任何版本', async () => {
    const s = await scenario()
    const other = await scenario()
    const otherFile = await submittedFile(other)
    expect(await signoff.createVersion(admin(), input(s, { content: '<p> </p>' }), randomUUID())).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
      details: { field: 'content' },
    })
    expect(await signoff.createVersion(admin(), input(s, { attachmentFileIds: [otherFile] }), randomUUID())).toMatchObject({
      ok: false,
      code: 'FILE_NOT_OWNED',
    })
    expect(await signoff.createVersion(actor(s.members[0]!.id, ['student']), input(s), randomUUID())).toMatchObject({
      ok: false,
      code: 'FORBIDDEN',
    })
    expect(await signoff.createVersion(actor(s.teacher.id, ['teacher']), input(s), randomUUID())).toMatchObject({
      ok: false,
      code: 'FORBIDDEN',
    })
    const noAdvisor = await scenario({ advisor: false })
    expect(await signoff.createVersion(admin(), input(noAdvisor), randomUUID())).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    await owner.sql(`update groups set status = 'dissolved', dissolved_real_at = now(), dissolve_reason = '測試' where id = $1`, [s.groupId])
    expect(await signoff.createVersion(admin(), input(s), randomUUID())).toMatchObject({ ok: false, code: 'GROUP_DISSOLVED' })
    expect(
      await count(
        `select count(*) as n from signoff_package_versions v join signoff_packages p on p.id = v.package_id where p.group_id = any($1::uuid[])`,
        [[s.groupId, noAdvisor.groupId]],
      ),
    ).toBe(0)
  })

  it('同一個請求編號重送回原回執、只有一版', async () => {
    const s = await scenario()
    const requestId = randomUUID()
    const first = await signoff.createVersion(admin(), input(s), requestId)
    const again = await signoff.createVersion(admin(), input(s), requestId)
    expect(first.ok && again.ok && again.receipt.versionId === first.receipt.versionId).toBe(true)
    expect(
      await count(`select count(*) as n from signoff_package_versions v join signoff_packages p on p.id = v.package_id where p.group_id = $1`, [
        s.groupId,
      ]),
    ).toBe(1)
  })

  it('同組同用途再建一版（SGN-06）：舊版 superseded（內容變更）、目前版本換過去、兩列都在；另一個用途不受影響', async () => {
    const s = await scenario()
    const v1 = await mustCreate(s)
    const draft = await showcaseDraft(s)
    const other = await mustCreate(s, { purpose: 'final_document', showcaseEntryId: draft.entryId })
    const v2 = await mustCreate(s, { content: '修正後的內容' })
    expect(v2).toMatchObject({ versionNo: 2, supersededVersionNo: 1 })
    expect(await statusOf(v1.versionId)).toEqual({ state: 'superseded', cause: 'content_change' })
    expect(await statusOf(v2.versionId)).toEqual({ state: 'collecting', cause: null })
    expect(await statusOf(other.versionId)).toEqual({ state: 'collecting', cause: null })
    const pkg = await owner.sql(`select current_version_id from signoff_packages where group_id = $1 and purpose = 'result_confirmation'`, [
      s.groupId,
    ])
    expect(pkg.rows[0]!.current_version_id).toBe(v2.versionId)
    const v2Row = await owner.sql('select supersede_cause from signoff_package_versions where id = $1', [v2.versionId])
    expect(v2Row.rows[0]!.supersede_cause).toBe('content_change')
    expect(
      await count(`select count(*) as n from domain_events where type = 'signoff.superseded' and source_id = $1`, [v1.versionId]),
    ).toBe(1)
  })
})

describe('最終文件授權：從精選草稿凍結授權範圍', () => {
  it('沒選草稿、期中卻選了草稿、選到別組的草稿、草稿沒有題目都被拒', async () => {
    const s = await scenario()
    const other = await scenario()
    const otherDraft = await showcaseDraft(other)
    expect(await signoff.createVersion(admin(), input(s, { purpose: 'final_document' }), randomUUID())).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
      details: { field: 'showcaseEntryId' },
    })
    const mine = await showcaseDraft(s, { title: '', summary: '' })
    expect(
      await signoff.createVersion(admin(), input(s, { purpose: 'result_confirmation', showcaseEntryId: mine.entryId }), randomUUID()),
    ).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    expect(
      await signoff.createVersion(admin(), input(s, { purpose: 'final_document', showcaseEntryId: otherDraft.entryId }), randomUUID()),
    ).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    const empty = await signoff.createVersion(admin(), input(s, { purpose: 'final_document', showcaseEntryId: mine.entryId }), randomUUID())
    expect(empty).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    expect(empty.ok ? '' : empty.message).toMatch(/題目或摘要/)
  })

  it('凍結的範圍＝草稿當下（題目、摘要、摘要 checksum、海報檔與 checksum、影片、來源）；之後改草稿，版本內容不變；海報綁到版本上', async () => {
    const s = await scenario()
    const draft = await showcaseDraft(s)
    const receipt = await mustCreate(s, { purpose: 'final_document', showcaseEntryId: draft.entryId, content: '同意公開以下內容。' })
    const scopeOf = async () =>
      (await owner.sql('select authorization_scope from signoff_package_versions where id = $1', [receipt.versionId])).rows[0]!
        .authorization_scope
    const frozen = await scopeOf()
    const draftRow = (await owner.sql('select summary_checksum from showcase_drafts where entry_id = $1', [draft.entryId])).rows[0]!
    expect(frozen).toEqual({
      usages: ['public_showcase'],
      title: '智慧校園導覽',
      summary: '用室內定位帶新生認識校園。',
      summaryChecksum: draftRow.summary_checksum,
      assets: [{ fileId: draft.posterFileId, checksum: draft.posterChecksum, kind: 'poster', name: 'poster.png' }],
      videoUrl: 'https://youtu.be/demo',
      validUntil: null,
      scopeSource: { entryId: draft.entryId, draftRevision: draft.revision, contentHash: expect.stringMatching(/^[0-9a-f]{64}$/) },
    })

    const changed = await showcase.updateDraft(
      admin(),
      { entryId: draft.entryId, revision: draft.revision, title: '改過的題目', summary: '改過的摘要', videoUrl: '', posterFileId: null },
      randomUUID(),
    )
    expect(changed.ok).toBe(true)
    expect(await scopeOf()).toEqual(frozen)
    // 草稿拿掉了海報，但版本還綁著那一張（不會被回收）。
    expect(
      await count(
        `select count(*) as n from file_references where file_id = $1 and ref_type = 'signoff_version' and ref_id = $2 and released_at is null`,
        [draft.posterFileId, receipt.versionId],
      ),
    ).toBe(1)
    // 參與學生讀得到凍結的海報；別組學生不行。
    const participantDownload = await storage.authorizeDownload(actor(s.members[1]!.id, ['student']), draft.posterFileId)
    expect(participantDownload.ok).toBe(true)
    if (participantDownload.ok) await participantDownload.receipt.body.cancel()
    const outsider = await scenario()
    expect((await storage.authorizeDownload(actor(outsider.members[0]!.id, ['student']), draft.posterFileId)).ok).toBe(false)
  })
})

describe('成員集合改變 → 目前版本同交易失效（票 14 掛點）', () => {
  it('加入組員：兩個用途的目前版本都 superseded（member_change）；版本列數不變、目前版本仍指舊版（不自動建新版）', async () => {
    const s = await scenario({ size: 4 })
    const mid = await mustCreate(s)
    const draft = await showcaseDraft(s)
    const fin = await mustCreate(s, { purpose: 'final_document', showcaseEntryId: draft.entryId })
    const before = await count(
      `select count(*) as n from signoff_package_versions v join signoff_packages p on p.id = v.package_id where p.group_id = $1`,
      [s.groupId],
    )
    const newcomer = await newUser('轉學生', 'student', s.cohortId)
    const revision = Number((await owner.sql('select revision from groups where id = $1', [s.groupId])).rows[0]!.revision)
    const added = await groups.addMember(admin(), { groupId: s.groupId, revision, studentNo: newcomer.studentNo!, reason: '轉學生加入' }, randomUUID())
    expect(added.ok).toBe(true)

    expect(await statusOf(mid.versionId)).toEqual({ state: 'superseded', cause: 'member_change' })
    expect(await statusOf(fin.versionId)).toEqual({ state: 'superseded', cause: 'member_change' })
    expect(
      await count(`select count(*) as n from signoff_package_versions v join signoff_packages p on p.id = v.package_id where p.group_id = $1`, [
        s.groupId,
      ]),
    ).toBe(before)
    const pkgs = await owner.sql('select current_version_id from signoff_packages where group_id = $1 order by purpose', [s.groupId])
    expect(pkgs.rows.map((r) => r.current_version_id).sort()).toEqual([mid.versionId, fin.versionId].sort())
    const audit = await owner.sql(`select payload from audit_events where action = 'group.member.add' and target_id = $1`, [s.groupId])
    expect([...((audit.rows[0]!.payload as { supersededSignoffVersionIds: string[] }).supersededSignoffVersionIds)].sort()).toEqual([mid.versionId, fin.versionId].sort())

    // 系辦建下一版：參與者依新集合重算（五人），建版原因沿用「組員變更」。
    const v2 = await mustCreate(s)
    expect(v2).toMatchObject({ versionNo: 2, studentCount: 5, supersededVersionNo: null })
    expect((await owner.sql('select supersede_cause from signoff_package_versions where id = $1', [v2.versionId])).rows[0]!.supersede_cause).toBe(
      'member_change',
    )
  })

  it('移出組員也失效；已經失效的版本不再動；成員異動失敗（回滾）時版本不變', async () => {
    const s = await scenario()
    const v1 = await mustCreate(s)
    const revision = Number((await owner.sql('select revision from groups where id = $1', [s.groupId])).rows[0]!.revision)
    // 版本號過期 → 成員異動整筆回滾，簽核也不動。
    const stale = await groups.removeMember(admin(), { groupId: s.groupId, revision: revision - 1, userId: s.members[4]!.id, successorLeaderUserId: null, reason: '退選' }, randomUUID())
    expect(stale.ok).toBe(false)
    expect(await statusOf(v1.versionId)).toEqual({ state: 'collecting', cause: null })

    const removed = await groups.removeMember(admin(), { groupId: s.groupId, revision, userId: s.members[4]!.id, successorLeaderUserId: null, reason: '退選' }, randomUUID())
    expect(removed.ok).toBe(true)
    expect(await statusOf(v1.versionId)).toEqual({ state: 'superseded', cause: 'member_change' })
    const events = await count(`select count(*) as n from domain_events where type = 'signoff.superseded' and source_id = $1`, [v1.versionId])
    expect(events).toBe(1)

    const again = Number((await owner.sql('select revision from groups where id = $1', [s.groupId])).rows[0]!.revision)
    const newcomer = await newUser('再加一位', 'student', s.cohortId)
    await groups.addMember(admin(), { groupId: s.groupId, revision: again, studentNo: newcomer.studentNo!, reason: '加入' }, randomUUID())
    expect(await count(`select count(*) as n from domain_events where type = 'signoff.superseded' and source_id = $1`, [v1.versionId])).toBe(1)
  })

  it('並發：建版與加入組員同時送出，結果一定一致——新成員在快照裡，不然那一版就已失效', async () => {
    for (let round = 0; round < 3; round += 1) {
      const s = await scenario({ size: 4 })
      const newcomer = await newUser('並發加入', 'student', s.cohortId)
      const revision = Number((await owner.sql('select revision from groups where id = $1', [s.groupId])).rows[0]!.revision)
      const [created, added] = await Promise.all([
        signoff.createVersion(admin(), input(s), randomUUID()),
        groups.addMember(admin(), { groupId: s.groupId, revision, studentNo: newcomer.studentNo!, reason: '並發' }, randomUUID()),
      ])
      expect(created.ok && added.ok).toBe(true)
      if (!created.ok) return
      const row = (
        await owner.sql(
          `select v.participants, s.state from signoff_package_versions v join signoff_version_status s on s.version_id = v.id where v.id = $1`,
          [created.receipt.versionId],
        )
      ).rows[0]!
      const ids = (row.participants as { students: { userId: string }[] }).students.map((p) => p.userId)
      if (ids.includes(newcomer.id)) expect(row.state).toBe('collecting')
      else expect(row.state).toBe('superseded')
    }
  })

  it('並發：兩位管理員同時對同組同用途建版，版本號不撞、只有一版是目前、另一版失效', async () => {
    const s = await scenario()
    const [a, b] = await Promise.all([
      signoff.createVersion(admin(), input(s, { content: 'A 的內容' }), randomUUID()),
      signoff.createVersion(admin(), input(s, { content: 'B 的內容' }), randomUUID()),
    ])
    expect(a.ok && b.ok).toBe(true)
    const rows = await owner.sql(
      `select v.version_no, s.state, (p.current_version_id = v.id) as is_current
         from signoff_package_versions v join signoff_version_status s on s.version_id = v.id join signoff_packages p on p.id = v.package_id
        where p.group_id = $1 order by v.version_no`,
      [s.groupId],
    )
    expect(rows.rows).toEqual([
      { version_no: 1, state: 'superseded', is_current: false },
      { version_no: 2, state: 'collecting', is_current: true },
    ])
  })

  it('只換組長：成員集合沒變，版本不動', async () => {
    const s = await scenario()
    const v1 = await mustCreate(s)
    const revision = Number((await owner.sql('select revision from groups where id = $1', [s.groupId])).rows[0]!.revision)
    const changed = await groups.changeLeader(admin(), { groupId: s.groupId, revision, newLeaderUserId: s.members[1]!.id, reason: '換人' }, randomUUID())
    expect(changed.ok).toBe(true)
    expect(await statusOf(v1.versionId)).toEqual({ state: 'collecting', cause: null })
  })
})

describe('讀取邊界（SGN-10 入口）', () => {
  it('版本頁：管理員、參與學生、主指導讀得到；別組學生、別的老師 FORBIDDEN；被移出的參與者仍讀得到自己參與過的那一版', async () => {
    const s = await scenario()
    const other = await scenario()
    const v1 = await mustCreate(s)
    for (const who of [admin(), actor(s.members[0]!.id, ['student']), actor(s.teacher.id, ['teacher'])]) {
      const r = await query.versionDetail(who, v1.versionId)
      expect(r.ok).toBe(true)
    }
    for (const who of [actor(other.members[0]!.id, ['student']), actor(other.teacher.id, ['teacher'])]) {
      expect(await query.versionDetail(who, v1.versionId)).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    }
    expect(await query.versionDetail(admin(), randomUUID())).toMatchObject({ ok: false, code: 'FORBIDDEN' })

    const revision = Number((await owner.sql('select revision from groups where id = $1', [s.groupId])).rows[0]!.revision)
    await groups.removeMember(admin(), { groupId: s.groupId, revision, userId: s.members[4]!.id, successorLeaderUserId: null, reason: '退選' }, randomUUID())
    const removed = await query.versionDetail(actor(s.members[4]!.id, ['student']), v1.versionId)
    expect(removed).toMatchObject({ ok: true, receipt: { state: 'superseded', cause: 'member_change', isCurrent: true } })
  })

  it('學生頁只看自己此刻組別的目前版本；老師頁只列此刻指導的組；管理員頁列每組兩個用途與影響人數', async () => {
    const s = await scenario({ size: 3 })
    const other = await scenario()
    const fileId = await submittedFile(s)
    const v1 = await mustCreate(s, { content: '<p>期中確認</p>' })
    await mustCreate(other)

    const student = await query.studentView(actor(s.members[0]!.id, ['student']))
    expect(student.groupCode).toBe('G01')
    expect(student.versions.map((v) => v.versionId)).toEqual([v1.versionId])
    expect(student.versions[0]!.contentHtml).toBe('<p>期中確認</p>')
    expect(await query.studentView(actor(s.teacher.id, ['teacher']))).toEqual({ groupCode: null, versions: [] })

    const teacher = await query.teacherView(actor(s.teacher.id, ['teacher']))
    expect(teacher.map((c) => c.current.versionId)).toEqual([v1.versionId])
    expect(await query.teacherView(actor(s.members[0]!.id, ['student']))).toEqual([])

    const board = await query.adminBoard(admin(), s.cohortId)
    expect(board.ok).toBe(true)
    if (!board.ok) return
    const row = board.receipt.groups[0]!
    expect(row.members).toHaveLength(3)
    expect(row.advisorName).toBe(s.teacher.name)
    expect(row.submissionFiles).toEqual([{ fileId, name: '期末報告.pdf', itemTitle: '期末報告繳交', versionNo: 1 }])
    expect(row.packages.result_confirmation).toMatchObject({ versionId: v1.versionId, state: 'collecting', studentCount: 3 })
    expect(row.packages.final_document).toBeNull()
    expect(await query.adminBoard(actor(s.teacher.id, ['teacher']), s.cohortId)).toMatchObject({ ok: false, code: 'FORBIDDEN' })
  })
})
