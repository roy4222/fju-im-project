import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { assertTestDatabaseReachable, createIsolatedDatabase, poolAsRole, type IsolatedDatabase } from '../../../test/db'
import { enableFaultInjection, failAt } from '../../../test/fault-injection'
import { migratedSchema } from '../../../test/migrations'
import type { ResolvedActor } from '@/application/accounts'
import { competitionStatus, EMPTY_COLLECTION_MESSAGE, snapshotDueAt, type ItemInput } from '@/application/items'
import { createAttachmentPolicy } from '@/infrastructure/items/attachment-policy'
import { PgItemCommand, PgItemQuery } from '@/infrastructure/items/pg-items'
import { PgPublicItemQuery } from '@/infrastructure/items/pg-public-items'
import { PgDueWorkScheduler } from '@/infrastructure/notifications/pg-due-work-scheduler'
import { PgEventPublisher } from '@/infrastructure/notifications/pg-event-publisher'
import { PgInbox } from '@/infrastructure/notifications/pg-inbox'
import { PgNotificationProjector } from '@/infrastructure/notifications/pg-projector'
import { PgAuditWriter } from '@/infrastructure/ops/audit-writer'
import { listStoredFiles } from '@/infrastructure/ops/file-list'
import { FsFileStorage } from '@/infrastructure/ops/file-storage'
import { PgOperationLedger } from '@/infrastructure/ops/operation-ledger'
import { PgSubmissionLateFlags } from '@/infrastructure/ops/submission-late-flags'
import { PgResponsePresence, responsePresenceReader } from '@/infrastructure/submissions/pg-response-presence'
import { PgSubmissionCommand, PgSubmissionQuery } from '@/infrastructure/submissions/pg-submissions'

/**
 * 票 15：專題事務建立與發布（模組實作設計 04 §3、§6、§10；模組 05 §5 `buildRoster`；
 * 案例 PUB-01、02、04、05、06、10、13、14）。
 *
 * 全部以正式執行角色 `fju_app` 連線：欄級權限（附件只能改排序、名單只能改結束欄與免填）
 * 或不可變表（內容版本、欄位版本、發布紀錄）寫錯的話，這裡會直接紅。業務鐘是可以撥的假鐘。
 */

let owner: IsolatedDatabase
let app: Pool
let root: string
let adminId: string
let otherAdminId: string
let teacherId: string
let businessNow = new Date('2026-09-24T02:00:00Z')
const businessClock = { now: async () => new Date(businessNow.getTime()) }

let items: PgItemCommand
let lockedItems: PgItemCommand
let query: PgItemQuery
let publicQuery: PgPublicItemQuery
let storage: FsFileStorage

const PDF = new TextEncoder().encode('%PDF-1.4\n% 測試附件\n')
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

type Person = { id: string; name: string; cohortId: string; studentNo: string }

function adminActor(userId = adminId): ResolvedActor {
  return { kind: 'authenticated', userId, roles: ['admin'], status: 'active', mustChangePassword: false, cohortMemberships: [] }
}

function studentActor(s: Person): ResolvedActor {
  return {
    kind: 'authenticated',
    userId: s.id,
    roles: ['student'],
    status: 'active',
    mustChangePassword: false,
    cohortMemberships: [{ cohortId: s.cohortId, role: 'student' }],
  }
}

function teacherActor(): ResolvedActor {
  return { kind: 'authenticated', userId: teacherId, roles: ['teacher'], status: 'active', mustChangePassword: false, cohortMemberships: [] }
}

let seq = 0
async function newCohort(): Promise<{ cohortId: string; stageId: string; laterStageId: string }> {
  seq += 1
  const cohort = await owner.sql(
    `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
     values (gen_random_uuid(), $1, $1, 'active', '2027-06-30', 'system') returning id`,
    [`I15-${seq}`],
  )
  const cohortId = String(cohort.rows[0]!.id)
  const stage = await owner.sql(
    `insert into cohort_stages (id, cohort_id, seq, name, start_date, created_by_kind)
     values (gen_random_uuid(), $1, 1, '成組期', '2026-09-15', 'system'),
            (gen_random_uuid(), $1, 2, '期中', '2026-11-01', 'system')
     returning id, seq`,
    [cohortId],
  )
  const bySeq = (n: number) => String(stage.rows.find((r) => Number(r.seq) === n)!.id)
  return { cohortId, stageId: bySeq(1), laterStageId: bySeq(2) }
}

async function newStudent(cohortId: string, options: { status?: string; identity?: boolean } = {}): Promise<Person> {
  seq += 1
  const studentNo = `41500${String(seq).padStart(4, '0')}`
  const name = `學生${seq}`
  const user = await owner.sql(
    `insert into users (id, name, email, email_verified, updated_at, status)
     values (gen_random_uuid(), $1, $2, true, now(), $3) returning id`,
    [name, `s${seq}-items@example.com`, options.status ?? 'active'],
  )
  const id = String(user.rows[0]!.id)
  await owner.sql(
    `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at)
     values (gen_random_uuid(), $1, 'student', $2, now())`,
    [id, adminId],
  )
  await owner.sql(
    `insert into user_profiles (user_id, display_name, name_normalized, student_no, cohort_id, contact_email)
     values ($1, $2, $2, $3, $4, $5)`,
    [id, name, studentNo, cohortId, `s${seq}@contact.example.com`],
  )
  if (options.identity !== false) {
    await owner.sql('insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)', [
      cohortId,
      studentNo,
      id,
    ])
  }
  return { id, name, cohortId, studentNo }
}

async function newGroup(cohortId: string, members: Person[], code: string, status = 'active'): Promise<string> {
  const group = await owner.sql(
    `insert into groups (id, cohort_id, code, group_type, status, established_real_at, established_business_at,
                         dissolved_real_at, dissolve_reason, created_by_kind)
     values (gen_random_uuid(), $1, $2, 'general', $3, now(), now(),
             case when $3 = 'dissolved' then now() end, case when $3 = 'dissolved' then '測試' end, 'system')
     returning id`,
    [cohortId, code, status],
  )
  const groupId = String(group.rows[0]!.id)
  for (const m of members) {
    await owner.sql(
      `insert into group_memberships (id, group_id, cohort_id, user_id, valid_from, added_by_kind)
       values (gen_random_uuid(), $1, $2, $3, now(), 'system')`,
      [groupId, cohortId, m.id],
    )
  }
  return groupId
}

function input(cohortId: string, patch: Partial<ItemInput> = {}): ItemInput {
  return {
    cohortId,
    placement: 'submission',
    title: '期中報告',
    summary: '期中報告與簡報',
    body: '請上傳 PDF。',
    category: '',
    coverFileId: null,
    attachmentFileIds: [],
    audienceKind: 'cohort_students',
    groupIds: [],
    receiverUnit: 'individual',
    stageId: null,
    opensAt: '',
    dueAt: '2026-11-15T23:59',
    fields: [{ key: 'report', type: 'file', label: '報告 PDF', required: true }],
    ...patch,
  }
}

async function mustCreate(cohortId: string, patch: Partial<ItemInput> = {}) {
  const created = await items.create(adminActor(), input(cohortId, patch), randomUUID())
  if (!created.ok) throw new Error(`${created.code} ${created.message}`)
  return created.receipt
}

async function mustPublish(itemId: string, revision: number, notify = true) {
  const published = await items.publish(adminActor(), itemId, revision, { notify }, randomUUID())
  if (!published.ok) throw new Error(`${published.code} ${published.message}`)
  return published.receipt
}

async function uploadPdf(ownerUserId = adminId, cohortId?: string, kind: 'pdf' | 'png' = 'pdf'): Promise<string> {
  const bytes = kind === 'png' ? PNG : PDF
  const issued = await storage.issueUploadTicket(
    ownerUserId,
    kind === 'png'
      ? { fileName: '封面.png', declaredMime: 'image/png', declaredSize: bytes.length }
      : { fileName: '說明.pdf', declaredMime: 'application/pdf', declaredSize: bytes.length },
    {
      purpose: 'attachment',
      allowedTypes: [kind],
      maxBytes: 1024 * 1024,
      scope: cohortId ? { kind: 'cohort', cohortId } : { kind: 'global' },
    },
  )
  if (!issued.ok) throw new Error(issued.message)
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
  const stored = await storage.upload(ownerUserId, issued.receipt.ticket, stream, bytes.length)
  if (!stored.ok) throw new Error(stored.message)
  return stored.receipt.fileId
}

async function count(sql: string, values: unknown[] = []): Promise<number> {
  return Number((await owner.sql(sql, values)).rows[0]!.n)
}

async function itemRow(itemId: string) {
  return (await owner.sql('select * from managed_items where id = $1', [itemId])).rows[0]!
}

async function rosterRows(itemId: string) {
  return (
    await owner.sql(
      `select receiver_kind, receiver_id, eligible_to_business_at, removed_reason, source
         from response_rosters where item_id = $1 order by receiver_kind, receiver_id`,
      [itemId],
    )
  ).rows
}

async function currentRoster(itemId: string): Promise<string[]> {
  return (await rosterRows(itemId)).filter((r) => r.eligible_to_business_at === null).map((r) => String(r.receiver_id)).sort()
}

async function events(itemId: string, type: string) {
  return (
    await owner.sql(
      `select id, recipients, payload from domain_events where source_type = 'item' and source_id = $1 and type = $2
        order by occurred_real_at`,
      [itemId, type],
    )
  ).rows
}

beforeAll(async () => {
  await assertTestDatabaseReachable()
  owner = await createIsolatedDatabase({ label: 'items', setup: migratedSchema })
  app = await poolAsRole(owner, 'fju_app')
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'fju-items-'))

  const staff = await owner.sql(
    `insert into users (id, name, email, email_verified, updated_at, status)
     values (gen_random_uuid(), 'A1', 'a1-items@example.com', true, now(), 'active'),
            (gen_random_uuid(), 'A2', 'a2-items@example.com', true, now(), 'active'),
            (gen_random_uuid(), 'T1', 't1-items@example.com', true, now(), 'active')
     returning id, name`,
  )
  adminId = String(staff.rows.find((r) => r.name === 'A1')!.id)
  otherAdminId = String(staff.rows.find((r) => r.name === 'A2')!.id)
  teacherId = String(staff.rows.find((r) => r.name === 'T1')!.id)
  await owner.sql(
    `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at)
     values (gen_random_uuid(), $1, 'admin', $1, now()), (gen_random_uuid(), $2, 'admin', $1, now()),
            (gen_random_uuid(), $3, 'teacher', $1, now())`,
    [adminId, otherAdminId, teacherId],
  )

  storage = new FsFileStorage({
    root: () => root,
    environmentMaxBytes: () => 100 * 1024 * 1024,
    ticketSecret: () => 'items-integration-secret-items-integration',
    policies: { attachment: createAttachmentPolicy(() => app) },
    db: () => app,
  })
  const deps = {
    audit: new PgAuditWriter(),
    ledger: new PgOperationLedger(() => app),
    events: new PgEventPublisher(),
    dueWork: new PgDueWorkScheduler({ testKindsEnabled: false }),
    files: storage,
    responses: new PgResponsePresence(),
    businessClock,
    pool: () => app,
  }
  items = new PgItemCommand(deps)
  // 替身假裝「已經有人作答」，不用真的去造回答就能逐條驗鎖定規則（真查詢的鎖定在 pg-submissions 的整合測試）。
  lockedItems = new PgItemCommand({ ...deps, responses: { hasAnyResponse: async () => true } })
  query = new PgItemQuery(() => app, responsePresenceReader(() => app))
  publicQuery = new PgPublicItemQuery(businessClock, () => app)
})

afterEach(() => {
  businessNow = new Date('2026-09-24T02:00:00Z')
})

afterAll(async () => {
  await app?.end()
  await owner?.close()
  await fs.rm(root, { recursive: true, force: true })
})

describe('授權：只有管理員能建立、編輯、發布、上傳', () => {
  it('學生與老師直接呼叫一律 FORBIDDEN，沒寫任何東西', async () => {
    const { cohortId, stageId } = await newCohort()
    const student = await newStudent(cohortId)
    for (const actor of [studentActor(student), teacherActor()]) {
      const created = await items.create(actor, input(cohortId, { stageId }), randomUUID())
      expect(created.ok || created.code).toBe('FORBIDDEN')
      const upload = await items.startUpload(actor, {
        cohortId,
        placement: 'news',
        kind: 'attachment',
        fileName: 'a.pdf',
        declaredMime: 'application/pdf',
        declaredSize: 10,
      })
      expect(upload.ok || upload.code).toBe('FORBIDDEN')
    }
    const item = await mustCreate(cohortId, { stageId })
    const published = await items.publish(studentActor(student), item.itemId, item.revision, { notify: true }, randomUUID())
    expect(published.ok || published.code).toBe('FORBIDDEN')
    expect(await count('select count(*) as n from managed_items where cohort_id = $1', [cohortId])).toBe(1)
    expect((await itemRow(item.itemId)).status).toBe('draft')
  })
})

describe('快速建立 → 完整編輯 → 發布（PUB-01、PUB-02、PUB-05）', () => {
  it('同一個 ID 從頭到尾；發布同一筆交易建名單、排到期工作、發事件', async () => {
    const { cohortId, stageId } = await newCohort()
    const s1 = await newStudent(cohortId)
    const s2 = await newStudent(cohortId)
    // 不該進名單的人：停用的、沒核准（沒有學號占用）的、別屆的。
    await newStudent(cohortId, { status: 'disabled' })
    await newStudent(cohortId, { identity: false })
    const elsewhere = await newCohort()
    await newStudent(elsewhere.cohortId)

    const created = await mustCreate(cohortId, { stageId: null, dueAt: '' })
    expect(created).toMatchObject({ revision: 1, status: 'draft' })

    // 完整編輯器補齊階段與截止，還是同一筆。
    const saved = await items.saveDraft(adminActor(), created.itemId, 1, input(cohortId, { stageId }), randomUUID())
    expect(saved.ok && saved.receipt).toMatchObject({ itemId: created.itemId, revision: 2 })
    expect(await count('select count(*) as n from managed_items where cohort_id = $1', [cohortId])).toBe(1)

    // 發布前預覽：展開看得到實際的人。
    const preview = await query.previewRecipients({ cohortId, audienceKind: 'cohort_students', groupIds: [], receiverUnit: 'individual' })
    expect(preview.people.map((p) => p.userId).sort()).toEqual([s1.id, s2.id].sort())

    const receipt = await mustPublish(created.itemId, 2)
    expect(receipt).toMatchObject({
      itemId: created.itemId,
      revision: 3,
      rosterCount: 2,
      contentVersionNo: 1,
      schemaVersionNo: 1,
      actualOpenedAt: businessNow.toISOString(),
      dueAt: '2026-11-15T15:59:00.000Z',
      notifiedCount: 2,
    })

    const row = await itemRow(created.itemId)
    expect(row.status).toBe('published')
    expect((row.actual_opened_at as Date).toISOString()).toBe(businessNow.toISOString())
    expect(row.current_content_version_id).not.toBeNull()
    expect(row.current_schema_version_id).not.toBeNull()
    expect(await currentRoster(created.itemId)).toEqual([s1.id, s2.id].sort())
    expect((await rosterRows(created.itemId)).every((r) => r.source === 'auto' && r.receiver_kind === 'user')).toBe(true)

    // 名單預覽與實際名單一致。
    expect(preview.people.map((p) => p.userId).sort()).toEqual(await currentRoster(created.itemId))

    const due = await owner.sql(
      `select state, due_business_at, deadline_version from due_work
        where kind = 'deadline_snapshot' and subject_type = 'item' and subject_id = $1`,
      [created.itemId],
    )
    expect(due.rows).toEqual([
      { state: 'pending', due_business_at: snapshotDueAt(new Date('2026-11-15T15:59:00Z')), deadline_version: 1 },
    ])

    const published = await events(created.itemId, 'item.published')
    expect(published).toHaveLength(1)
    expect([...(published[0]!.recipients as string[])].sort()).toEqual([s1.id, s2.id].sort())
    expect(published[0]!.payload).toMatchObject({ itemId: created.itemId, title: '期中報告', placement: 'submission' })
    expect(
      await count(`select count(*) as n from event_projections where event_id = $1 and consumer = 'notifications' and state = 'pending'`, [
        published[0]!.id,
      ]),
    ).toBe(1)

    expect(await count(`select count(*) as n from item_publications where item_id = $1 and action = 'publish'`, [created.itemId])).toBe(1)
    expect(
      await count(`select count(*) as n from audit_events where target_id = $1 and action = 'item.publish'`, [created.itemId]),
    ).toBe(1)
  })

  it('同一個請求編號重送：回同一份回執，名單、事件、到期工作都不會多', async () => {
    const { cohortId, stageId } = await newCohort()
    await newStudent(cohortId)
    const item = await mustCreate(cohortId, { stageId })
    const requestId = randomUUID()
    const first = await items.publish(adminActor(), item.itemId, 1, { notify: true }, requestId)
    const again = await items.publish(adminActor(), item.itemId, 1, { notify: true }, requestId)
    expect(first.ok && again.ok).toBe(true)
    if (first.ok && again.ok) expect(again.receipt).toEqual(first.receipt)
    expect(await count('select count(*) as n from response_rosters where item_id = $1', [item.itemId])).toBe(1)
    expect((await events(item.itemId, 'item.published'))).toHaveLength(1)
    expect(await count(`select count(*) as n from due_work where subject_id = $1`, [item.itemId])).toBe(1)
  })

  it('兩個視窗同時按發布：一個成功，另一個 CONFLICT，名單只有一份', async () => {
    const { cohortId, stageId } = await newCohort()
    await newStudent(cohortId)
    const item = await mustCreate(cohortId, { stageId })
    const results = await Promise.all([
      items.publish(adminActor(), item.itemId, 1, { notify: true }, randomUUID()),
      items.publish(adminActor(otherAdminId), item.itemId, 1, { notify: true }, randomUUID()),
    ])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(results.find((r) => !r.ok)).toMatchObject({ code: 'CONFLICT' })
    expect(await count('select count(*) as n from response_rosters where item_id = $1', [item.itemId])).toBe(1)
  })

  it('舊的 revision 存草稿：CONFLICT，內容不被蓋掉', async () => {
    const { cohortId, stageId } = await newCohort()
    const item = await mustCreate(cohortId, { stageId })
    const first = await items.saveDraft(adminActor(), item.itemId, 1, input(cohortId, { stageId, title: '新的標題' }), randomUUID())
    expect(first.ok).toBe(true)
    const stale = await items.saveDraft(adminActor(), item.itemId, 1, input(cohortId, { stageId, title: '舊視窗' }), randomUUID())
    expect(stale.ok || stale.code).toBe('CONFLICT')
    expect((await itemRow(item.itemId)).title).toBe('新的標題')
  })
})

describe('收件單位與對象展開（PUB-04、PUB-05、PUB-10）', () => {
  it('整組一份＋本屆：名單是本屆已成立的組（解散的不算），通知寫給組員', async () => {
    const { cohortId, stageId } = await newCohort()
    const [a, b, c, d] = [await newStudent(cohortId), await newStudent(cohortId), await newStudent(cohortId), await newStudent(cohortId)]
    const lonely = await newStudent(cohortId)
    const g1 = await newGroup(cohortId, [a, b], 'G01')
    const g2 = await newGroup(cohortId, [c], 'G02')
    await newGroup(cohortId, [d], 'G03', 'dissolved')

    const item = await mustCreate(cohortId, { stageId, receiverUnit: 'group' })
    const receipt = await mustPublish(item.itemId, 1)
    expect(receipt.rosterCount).toBe(2)
    expect(await currentRoster(item.itemId)).toEqual([g1, g2].sort())
    const recipients = (await events(item.itemId, 'item.published'))[0]!.recipients as string[]
    expect([...recipients].sort()).toEqual([a.id, b.id, c.id].sort())
    // 未成組的人不會被要求代組繳交（PUB-04）。
    expect(recipients).not.toContain(lonely.id)
  })

  it('整組一份＋指定組別：只有選到的組；G3 不在名單也收不到通知（PUB-10）', async () => {
    const { cohortId, stageId } = await newCohort()
    const [a, b, c] = [await newStudent(cohortId), await newStudent(cohortId), await newStudent(cohortId)]
    const g1 = await newGroup(cohortId, [a], 'G01')
    const g2 = await newGroup(cohortId, [b], 'G02')
    await newGroup(cohortId, [c], 'G03')

    const item = await mustCreate(cohortId, { stageId, receiverUnit: 'group', audienceKind: 'groups', groupIds: [g1, g2] })
    await mustPublish(item.itemId, 1)
    expect(await currentRoster(item.itemId)).toEqual([g1, g2].sort())
    const recipients = (await events(item.itemId, 'item.published'))[0]!.recipients as string[]
    expect([...recipients].sort()).toEqual([a.id, b.id].sort())
    expect(recipients).not.toContain(c.id)
  })

  it('個人一份＋指定組別：那幾組裡的有效學生每人一份', async () => {
    const { cohortId, stageId } = await newCohort()
    const [a, b, c] = [await newStudent(cohortId), await newStudent(cohortId), await newStudent(cohortId)]
    const g1 = await newGroup(cohortId, [a, b], 'G01')
    await newGroup(cohortId, [c], 'G02')
    const item = await mustCreate(cohortId, { stageId, receiverUnit: 'individual', audienceKind: 'groups', groupIds: [g1] })
    await mustPublish(item.itemId, 1)
    expect(await currentRoster(item.itemId)).toEqual([a.id, b.id].sort())
  })

  it('別屆或已解散的組別不能指定', async () => {
    const { cohortId, stageId } = await newCohort()
    const other = await newCohort()
    const foreign = await newGroup(other.cohortId, [], 'G99')
    const created = await items.create(
      adminActor(),
      input(cohortId, { stageId, receiverUnit: 'group', audienceKind: 'groups', groupIds: [foreign] }),
      randomUUID(),
    )
    expect(created.ok || created.code).toBe('VALIDATION_FAILED')
    const wrongStage = await items.create(adminActor(), input(cohortId, { stageId: other.stageId }), randomUUID())
    expect(wrongStage.ok || wrongStage.code).toBe('VALIDATION_FAILED')
  })
})

describe('發布前檢查（PUB-13、PUB-14）：被擋就什麼都不寫', () => {
  async function expectNothingPublished(itemId: string) {
    const row = await itemRow(itemId)
    expect(row.status).toBe('draft')
    expect(row.actual_opened_at).toBeNull()
    expect(await count('select count(*) as n from item_publications where item_id = $1', [itemId])).toBe(0)
    expect(await count('select count(*) as n from response_rosters where item_id = $1', [itemId])).toBe(0)
    expect(await count('select count(*) as n from due_work where subject_id = $1', [itemId])).toBe(0)
    expect(await count(`select count(*) as n from domain_events where source_id = $1`, [itemId])).toBe(0)
  }

  it('收件沒有欄位也沒有上傳要求：擋，文案固定', async () => {
    const { cohortId, stageId } = await newCohort()
    const item = await mustCreate(cohortId, { stageId, fields: [{ key: 'h', type: 'heading', label: '說明' }] })
    const result = await items.publish(adminActor(), item.itemId, 1, { notify: true }, randomUUID())
    expect(result.ok || result.code).toBe('VALIDATION_FAILED')
    if (!result.ok) expect(result.message).toContain(EMPTY_COLLECTION_MESSAGE)
    await expectNothingPublished(item.itemId)
  })

  it('指定組別沒選任何組：擋', async () => {
    const { cohortId, stageId } = await newCohort()
    const item = await mustCreate(cohortId, { stageId, audienceKind: 'groups', groupIds: [] })
    const result = await items.publish(adminActor(), item.itemId, 1, { notify: true }, randomUUID())
    expect(result.ok || result.code).toBe('VALIDATION_FAILED')
    await expectNothingPublished(item.itemId)
  })

  it('截止早於開放（沒設開放＝發布當下）：擋；只有上傳要求的收件可以發布', async () => {
    const { cohortId, stageId } = await newCohort()
    const past = await mustCreate(cohortId, { stageId, dueAt: '2026-09-01T12:00' })
    const rejected = await items.publish(adminActor(), past.itemId, 1, { notify: true }, randomUUID())
    expect(rejected.ok || rejected.code).toBe('VALIDATION_FAILED')
    await expectNothingPublished(past.itemId)

    const uploadOnly = await mustCreate(cohortId, { stageId })
    expect((await items.publish(adminActor(), uploadOnly.itemId, 1, { notify: true }, randomUUID())).ok).toBe(true)
  })

  it('收件缺截止：擋（C 階段起不再要求所屬階段，見下一條）', async () => {
    const { cohortId } = await newCohort()
    const item = await mustCreate(cohortId, { stageId: null, dueAt: '' })
    const result = await items.publish(adminActor(), item.itemId, 1, { notify: true }, randomUUID())
    expect(result.ok || result.code).toBe('VALIDATION_FAILED')
    expect(!result.ok && result.details?.checks).toEqual(['due'])
    await expectNothingPublished(item.itemId)
  })

  it('收件沒選所屬階段也能發布（C 階段 A3；`stage_id` 留 null）', async () => {
    const { cohortId } = await newCohort()
    await newStudent(cohortId)
    const item = await mustCreate(cohortId, { stageId: null })
    const result = await items.publish(adminActor(), item.itemId, 1, { notify: true }, randomUUID())
    expect(result.ok).toBe(true)
    expect(await count('select count(*) as n from managed_items where id = $1 and stage_id is null and status = $2', [item.itemId, 'published'])).toBe(1)
  })

  it('名單寫好之後出錯（故障注入）：整筆回滾，沒有發布紀錄、實際開放時間、名單、到期工作與事件', async () => {
    const { cohortId, stageId } = await newCohort()
    await newStudent(cohortId)
    const item = await mustCreate(cohortId, { stageId })
    const disable = enableFaultInjection()
    const clear = failAt('item.publish.after-roster')
    try {
      const result = await items.publish(adminActor(), item.itemId, 1, { notify: true }, randomUUID())
      expect(result.ok || result.code).toBe('INTERNAL')
    } finally {
      clear()
      disable()
    }
    await expectNothingPublished(item.itemId)
    expect(await count('select count(*) as n from item_versions where item_id = $1', [item.itemId])).toBe(0)
    // 修好之後同一筆可以正常發布。
    expect((await items.publish(adminActor(), item.itemId, 1, { notify: true }, randomUUID())).ok).toBe(true)
  })
})

describe('公告與資源', () => {
  it('公告不建名單、不排截止；不勾通知就不發事件', async () => {
    const { cohortId } = await newCohort()
    await newStudent(cohortId)
    const item = await mustCreate(cohortId, { placement: 'news', audienceKind: 'cohort_students', receiverUnit: 'none' })
    const receipt = await mustPublish(item.itemId, 1, false)
    expect(receipt).toMatchObject({ rosterCount: 0, notifiedCount: 0, dueAt: null })
    expect(await count('select count(*) as n from response_rosters where item_id = $1', [item.itemId])).toBe(0)
    expect(await count('select count(*) as n from due_work where subject_id = $1', [item.itemId])).toBe(0)
    expect(await events(item.itemId, 'item.announced')).toHaveLength(0)
    expect((await owner.sql('select notify from item_publications where item_id = $1', [item.itemId])).rows).toEqual([
      { notify: false },
    ])
  })

  it('勾「重要」：全部老師的公告寫給老師；公開公告展開到全站有效帳號（Roy 2026-09-25）', async () => {
    const { cohortId } = await newCohort()
    const teachers = await mustCreate(cohortId, { placement: 'news', audienceKind: 'teachers' })
    await mustPublish(teachers.itemId, 1, true)
    expect((await events(teachers.itemId, 'item.announced'))[0]!.recipients).toEqual([teacherId])

    const open = await mustCreate(cohortId, { placement: 'resource', audienceKind: 'public' })
    const receipt = await mustPublish(open.itemId, 1, true)
    const active = await count(`select count(*) as n from users where status = 'active' and deidentified_at is null`)
    expect(receipt.notifiedCount).toBe(active)
    const recipients = (await events(open.itemId, 'item.announced'))[0]!.recipients as string[]
    expect(recipients).toHaveLength(active)
    expect(recipients).toEqual(expect.arrayContaining([adminId, otherAdminId, teacherId]))

    // 沒勾「重要」的一般公開公告：只留發布紀錄，不發事件。
    const plain = await mustCreate(cohortId, { placement: 'news', audienceKind: 'signed_in' })
    expect((await mustPublish(plain.itemId, 1, false)).notifiedCount).toBe(0)
    expect(await events(plain.itemId, 'item.announced')).toHaveLength(0)
  })

  it('正文存的是清理過的 HTML', async () => {
    const { cohortId } = await newCohort()
    const item = await mustCreate(cohortId, {
      placement: 'news',
      audienceKind: 'public',
      body: '<p onclick="x()">說明會</p><script>alert(1)</script>',
    })
    expect((await itemRow(item.itemId)).body_html).toBe('<p>說明會</p>')
  })

  it('競賽資訊（票 39，0011）：報名截止與活動日存進頭列、前台卡片看得到；只改日期的發布更新記成設定變更', async () => {
    const { cohortId } = await newCohort()
    const news = {
      placement: 'news',
      audienceKind: 'public',
      receiverUnit: 'none',
      category: '競賽資訊',
      title: '競賽日期測試',
      dueAt: '',
      fields: [],
      registrationDeadline: '2026-10-03',
    }
    const item = await mustCreate(cohortId, news)
    const published = await mustPublish(item.itemId, 1, false)
    const [card] = await publicQuery.list({ kind: 'anonymous' }, 'news', { category: '競賽資訊', q: '競賽日期測試' })
    expect(card).toMatchObject({ registrationDeadline: '2026-10-03', eventDate: null, awardedOn: null })

    const updated = await items.updatePublished(
      adminActor(),
      item.itemId,
      published.revision,
      input(cohortId, { ...news, eventDate: '2026-11-20' }),
      { notify: false },
      randomUUID(),
    )
    expect(updated).toMatchObject({ ok: true, receipt: { changes: ['settings'] } })
    expect((await query.get(item.itemId))).toMatchObject({ registrationDeadline: '2026-10-03', eventDate: '2026-11-20' })

    // 分類改掉：日期一起清掉（不留前台看不到的值）。
    const again = await items.updatePublished(
      adminActor(),
      item.itemId,
      (await query.get(item.itemId))!.revision,
      input(cohortId, { ...news, category: '活動', eventDate: '2026-11-20' }),
      { notify: false },
      randomUUID(),
    )
    expect(again.ok).toBe(true)
    expect(await query.get(item.itemId)).toMatchObject({ registrationDeadline: null, eventDate: null })
  })

  it('DB 擋放錯位置的日期：競賽日期只給公告、得獎日期只給榮譽、活動日不早於截止', async () => {
    const { cohortId } = await newCohort()
    const item = await mustCreate(cohortId, { placement: 'resource', audienceKind: 'public', receiverUnit: 'none', dueAt: '', fields: [] })
    await expect(owner.sql(`update managed_items set event_date = '2026-10-01' where id = $1`, [item.itemId])).rejects.toThrow(
      /managed_items_competition_dates_check/,
    )
    await expect(owner.sql(`update managed_items set awarded_on = '2026-10-01' where id = $1`, [item.itemId])).rejects.toThrow(
      /managed_items_awarded_on_check/,
    )
    const news = await mustCreate(cohortId, { placement: 'news', audienceKind: 'public', receiverUnit: 'none', dueAt: '', fields: [] })
    await expect(
      owner.sql(`update managed_items set registration_deadline = '2026-10-03', event_date = '2026-10-01' where id = $1`, [news.itemId]),
    ).rejects.toThrow(/managed_items_event_after_deadline_check/)
  })
})

describe('發布更新（小幅修改自選通知；PUB-06 收件單位鎖定）', () => {
  it('改標題、不通知：切新內容版本，沒有事件；實際開放時間不變', async () => {
    const { cohortId, stageId } = await newCohort()
    await newStudent(cohortId)
    const item = await mustCreate(cohortId, { stageId })
    const published = await mustPublish(item.itemId, 1)
    const openedAt = (await itemRow(item.itemId)).actual_opened_at

    businessNow = new Date('2026-09-25T02:00:00Z')
    const updated = await items.updatePublished(
      adminActor(),
      item.itemId,
      published.revision,
      input(cohortId, { stageId, title: '期中報告（更正）' }),
      { notify: false },
      randomUUID(),
    )
    expect(updated.ok && updated.receipt).toMatchObject({ changes: ['content'], contentVersionNo: 2, schemaVersionNo: 1, notify: false })
    const row = await itemRow(item.itemId)
    expect(row.actual_opened_at).toEqual(openedAt)
    expect(await count('select count(*) as n from item_versions where item_id = $1', [item.itemId])).toBe(2)
    expect(await events(item.itemId, 'item.updated')).toHaveLength(0)
    expect(
      (await owner.sql(`select notify from item_publications where item_id = $1 and action = 'content_change'`, [item.itemId])).rows,
    ).toEqual([{ notify: false }])
  })

  it('改標題、要通知：名單上的人收到更新事件', async () => {
    const { cohortId, stageId } = await newCohort()
    const s = await newStudent(cohortId)
    const item = await mustCreate(cohortId, { stageId })
    const published = await mustPublish(item.itemId, 1)
    const updated = await items.updatePublished(
      adminActor(),
      item.itemId,
      published.revision,
      input(cohortId, { stageId, summary: '補充格式說明' }),
      { notify: true },
      randomUUID(),
    )
    expect(updated.ok).toBe(true)
    expect((await events(item.itemId, 'item.updated'))[0]!.recipients).toEqual([s.id])
  })

  it('沒人作答時可以切換收件單位：舊名單寫結束與理由（不刪），新名單插新列，新加入的人收到新收件', async () => {
    const { cohortId, stageId } = await newCohort()
    const [a, b] = [await newStudent(cohortId), await newStudent(cohortId)]
    const g1 = await newGroup(cohortId, [a, b], 'G01')
    const item = await mustCreate(cohortId, { stageId, receiverUnit: 'individual' })
    const published = await mustPublish(item.itemId, 1)

    const updated = await items.updatePublished(
      adminActor(),
      item.itemId,
      published.revision,
      input(cohortId, { stageId, receiverUnit: 'group' }),
      { notify: false },
      randomUUID(),
    )
    expect(updated.ok && updated.receipt).toMatchObject({ changes: ['settings'], rosterAdded: 1, rosterRemoved: 2 })
    const rows = await rosterRows(item.itemId)
    expect(rows.filter((r) => r.receiver_kind === 'user').every((r) => r.eligible_to_business_at !== null && r.removed_reason)).toBe(true)
    expect(await currentRoster(item.itemId)).toEqual([g1])
    const added = await events(item.itemId, 'item.published')
    expect(added).toHaveLength(2)
    expect([...(added[1]!.recipients as string[])].sort()).toEqual([a.id, b.id].sort())
  })

  it('有人作答後：切換收件單位、改對象、改欄位都被拒，名單與版本不變；改標題與截止仍可以', async () => {
    const { cohortId, stageId } = await newCohort()
    const s = await newStudent(cohortId)
    const g1 = await newGroup(cohortId, [s], 'G01')
    const item = await mustCreate(cohortId, { stageId })
    const published = await mustPublish(item.itemId, 1)
    const before = await rosterRows(item.itemId)

    const unit = await lockedItems.updatePublished(
      adminActor(),
      item.itemId,
      published.revision,
      input(cohortId, { stageId, receiverUnit: 'group' }),
      { notify: false },
      randomUUID(),
    )
    expect(unit.ok || unit.code).toBe('ITEM_HAS_RESPONSES')
    const audience = await lockedItems.updatePublished(
      adminActor(),
      item.itemId,
      published.revision,
      input(cohortId, { stageId, audienceKind: 'groups', groupIds: [g1] }),
      { notify: false },
      randomUUID(),
    )
    expect(audience.ok || audience.code).toBe('ITEM_HAS_RESPONSES')
    const schema = await lockedItems.updatePublished(
      adminActor(),
      item.itemId,
      published.revision,
      input(cohortId, { stageId, fields: [{ key: 'report', type: 'file', label: '報告 PDF', required: false }] }),
      { notify: false },
      randomUUID(),
    )
    expect(schema.ok || schema.code).toBe('ITEM_HAS_RESPONSES')
    expect(await rosterRows(item.itemId)).toEqual(before)
    expect((await itemRow(item.itemId)).receiver_unit).toBe('individual')
    expect(await count('select count(*) as n from form_schema_versions where item_id = $1', [item.itemId])).toBe(1)

    const title = await lockedItems.updatePublished(
      adminActor(),
      item.itemId,
      published.revision,
      input(cohortId, { stageId, title: '期中報告（延期）', dueAt: '2026-11-22T23:59' }),
      { notify: true },
      randomUUID(),
    )
    expect(title.ok && title.receipt.changes).toEqual(['content', 'deadline'])
  })

  it('有人交件後：只改欄名與說明可以存，學生看到新欄名、舊答案還在；改 key／型別／必填／選項／檔案規則／順序／加刪欄位仍被拒（AC-5）', async () => {
    const { cohortId } = await newCohort()
    const s = await newStudent(cohortId)
    const fields: ItemInput['fields'] = [
      { key: 'topic', type: 'text', label: '題目', required: true, help: '一句話' },
      { key: 'kind', type: 'select', label: '類型', required: false, options: ['系統', '研究'] },
      { key: 'report', type: 'file', label: '報告', required: false, fileRules: { allowedTypes: ['pdf'], maxMiB: 20 } },
    ]
    const item = await mustCreate(cohortId, { fields })
    const published = await mustPublish(item.itemId, 1, false)
    const submissions = new PgSubmissionCommand({
      audit: new PgAuditWriter(),
      ledger: new PgOperationLedger(() => app),
      businessClock,
      files: storage,
      events: new PgEventPublisher(),
      pool: () => app,
    })
    const saved = await submissions.saveDraft(studentActor(s), item.itemId, 0, { topic: '校園導覽 App', kind: '系統' }, randomUUID())
    if (!saved.ok) throw new Error(`${saved.code} ${saved.message}`)
    const submitted = await submissions.submit(studentActor(s), item.itemId, saved.receipt.revision, randomUUID())
    expect(submitted.ok).toBe(true)

    // (i) 只改欄名與說明：存得了，切新的欄位版本；學生端是新欄名，交過的那一版答案不變。
    const relabeled: ItemInput['fields'] = [
      { key: 'topic', type: 'text', label: '專題題目', required: true, help: '寫完整題目' },
      { key: 'kind', type: 'select', label: '專題類型', required: false, options: ['系統', '研究'] },
      { key: 'report', type: 'file', label: '期中報告', required: false, fileRules: { allowedTypes: ['pdf'], maxMiB: 20 } },
    ]
    const labels = await items.updatePublished(adminActor(), item.itemId, published.revision, input(cohortId, { fields: relabeled }), { notify: false }, randomUUID())
    if (!labels.ok) throw new Error(`${labels.code} ${labels.message}`)
    expect(labels.receipt.changes).toEqual(['schema'])
    const studentQuery = new PgSubmissionQuery(() => app, new PgSubmissionLateFlags(() => app))
    const mine = await studentQuery.myItem(s.id, item.itemId)
    expect(mine?.fields.map((f) => [f.key, f.label, f.help ?? null])).toEqual([
      ['topic', '專題題目', '寫完整題目'],
      ['kind', '專題類型', null],
      ['report', '期中報告', null],
    ])
    expect(mine?.versions).toHaveLength(1)
    expect((await studentQuery.myVersion(s.id, item.itemId, 1))?.answers).toMatchObject({ topic: '校園導覽 App', kind: '系統' })

    // (ii) 動到結構：一律 ITEM_HAS_RESPONSES，欄位版本不再增加。
    const versionsBefore = await count('select count(*) as n from form_schema_versions where item_id = $1', [item.itemId])
    const [topic, kind, report] = relabeled
    const structural: Record<string, ItemInput['fields']> = {
      key: [{ ...topic!, key: 'title' }, kind!, report!],
      type: [{ ...topic!, type: 'textarea' }, kind!, report!],
      required: [{ ...topic!, required: false }, kind!, report!],
      options: [topic!, { ...kind!, options: ['系統', '研究', '其他'] }, report!],
      fileRules: [topic!, kind!, { ...report!, fileRules: { allowedTypes: ['pdf'], maxMiB: 50 } }],
      order: [kind!, topic!, report!],
      added: [topic!, kind!, report!, { key: 'note', type: 'textarea', label: '備註', required: false }],
      removed: [topic!, kind!],
    }
    for (const [what, next] of Object.entries(structural)) {
      const refused = await items.updatePublished(adminActor(), item.itemId, labels.receipt.revision, input(cohortId, { fields: next }), { notify: false }, randomUUID())
      expect([what, refused.ok || refused.code]).toEqual([what, 'ITEM_HAS_RESPONSES'])
    }
    expect(await count('select count(*) as n from form_schema_versions where item_id = $1', [item.itemId])).toBe(versionsBefore)
  })

  it('改截止：期限版本 +1，舊的到期工作取消、新的排上', async () => {
    const { cohortId, stageId, laterStageId } = await newCohort()
    await newStudent(cohortId)
    const item = await mustCreate(cohortId, { stageId })
    const published = await mustPublish(item.itemId, 1)
    const updated = await items.updatePublished(
      adminActor(),
      item.itemId,
      published.revision,
      // 延到下一階段也不自動改所屬階段（產品模組 04「發布檢查與時間邊界」）。
      input(cohortId, { stageId, dueAt: '2026-12-01T12:00' }),
      { notify: false },
      randomUUID(),
    )
    expect(updated.ok && updated.receipt.changes).toEqual(['deadline'])
    const row = await itemRow(item.itemId)
    expect(row.deadline_version).toBe(2)
    expect(row.stage_id).toBe(stageId)
    expect(row.stage_id).not.toBe(laterStageId)
    const due = await owner.sql(
      `select deadline_version, state from due_work where subject_id = $1 order by deadline_version`,
      [item.itemId],
    )
    expect(due.rows).toEqual([
      { deadline_version: 1, state: 'cancelled' },
      { deadline_version: 2, state: 'pending' },
    ])
  })

  it('草稿不能用發布更新；已發布的不能用存草稿；已發布的不能換位置', async () => {
    const { cohortId, stageId } = await newCohort()
    const item = await mustCreate(cohortId, { stageId })
    const early = await items.updatePublished(adminActor(), item.itemId, 1, input(cohortId, { stageId }), { notify: false }, randomUUID())
    expect(early.ok || early.code).toBe('VALIDATION_FAILED')
    const published = await mustPublish(item.itemId, 1)
    const save = await items.saveDraft(adminActor(), item.itemId, published.revision, input(cohortId, { stageId }), randomUUID())
    expect(save.ok || save.code).toBe('VALIDATION_FAILED')
    const move = await items.updatePublished(
      adminActor(),
      item.itemId,
      published.revision,
      input(cohortId, { placement: 'news', audienceKind: 'cohort_students' }),
      { notify: false },
      randomUUID(),
    )
    expect(move.ok || move.code).toBe('VALIDATION_FAILED')
  })
})

describe('附件與封面（共用檔案能力；下載依對象）', () => {
  it('附件綁上引用；拿掉就釋放，再附回來插一筆新的有效引用（契約 01 §11）', async () => {
    const { cohortId, stageId } = await newCohort()
    const fileId = await uploadPdf(adminId, cohortId)
    const item = await mustCreate(cohortId, { stageId, attachmentFileIds: [fileId] })
    const refs = () =>
      owner.sql(`select released_at from file_references where file_id = $1 and ref_type = 'item_attachment' order by created_at`, [fileId])
    expect((await refs()).rows).toEqual([{ released_at: null }])

    const removed = await items.saveDraft(adminActor(), item.itemId, 1, input(cohortId, { stageId, attachmentFileIds: [] }), randomUUID())
    expect(removed.ok).toBe(true)
    expect((await refs()).rows[0]!.released_at).not.toBeNull()
    expect(await count('select count(*) as n from item_attachments where item_id = $1', [item.itemId])).toBe(0)

    const readded = await items.saveDraft(adminActor(), item.itemId, 2, input(cohortId, { stageId, attachmentFileIds: [fileId] }), randomUUID())
    expect(readded.ok).toBe(true)
    const all = (await refs()).rows
    expect(all).toHaveLength(2)
    expect(all.filter((r) => r.released_at === null)).toHaveLength(1)
  })

  it('別的管理員上傳的檔案不能綁（FILE_NOT_OWNED），整筆不寫', async () => {
    const { cohortId, stageId } = await newCohort()
    const fileId = await uploadPdf(otherAdminId, cohortId)
    const created = await items.create(adminActor(), input(cohortId, { stageId, attachmentFileIds: [fileId] }), randomUUID())
    expect(created.ok || created.code).toBe('FILE_NOT_OWNED')
    expect(await count('select count(*) as n from managed_items where cohort_id = $1', [cohortId])).toBe(0)
  })

  it('封面只接受圖片：把 PDF 附件指成封面被拒，整筆不寫；PNG 可以', async () => {
    const { cohortId } = await newCohort()
    const pdf = await uploadPdf(adminId, cohortId)
    const png = await uploadPdf(adminId, cohortId, 'png')
    const rejected = await items.create(
      adminActor(),
      input(cohortId, { placement: 'news', audienceKind: 'public', coverFileId: pdf }),
      randomUUID(),
    )
    expect(rejected.ok || rejected.code).toBe('FILE_TYPE_REJECTED')
    expect(await count('select count(*) as n from managed_items where cohort_id = $1', [cohortId])).toBe(0)
    expect(await count(`select count(*) as n from file_references where file_id = $1`, [pdf])).toBe(0)

    const item = await mustCreate(cohortId, { placement: 'news', audienceKind: 'public', coverFileId: png })
    expect((await itemRow(item.itemId)).cover_file_id).toBe(png)
    const swapped = await items.saveDraft(
      adminActor(),
      item.itemId,
      1,
      input(cohortId, { placement: 'news', audienceKind: 'public', coverFileId: pdf }),
      randomUUID(),
    )
    expect(swapped.ok || swapped.code).toBe('FILE_TYPE_REJECTED')
    expect((await itemRow(item.itemId)).cover_file_id).toBe(png)
  })

  it('上傳 ticket：附件只收文件與圖片、封面只收圖片', async () => {
    const { cohortId } = await newCohort()
    const cover = await items.startUpload(adminActor(), {
      cohortId,
      placement: 'news',
      kind: 'cover',
      fileName: 'cover.pdf',
      declaredMime: 'application/pdf',
      declaredSize: 100,
    })
    expect(cover.ok || cover.code).toBe('FILE_TYPE_REJECTED')
    const attachment = await items.startUpload(adminActor(), {
      cohortId,
      placement: 'news',
      kind: 'attachment',
      fileName: '說明.pdf',
      declaredMime: 'application/pdf',
      declaredSize: 100,
    })
    expect(attachment.ok).toBe(true)
  })

  describe('封存屆別的上傳（AC-55 F1）：只有榮譽還能開始上傳', () => {
    const start = (cohortId: string, placement: string, kind: 'attachment' | 'cover' = 'attachment') =>
      items.startUpload(adminActor(), {
        cohortId,
        placement,
        kind,
        fileName: kind === 'cover' ? '封面.png' : '說明.pdf',
        declaredMime: kind === 'cover' ? 'image/png' : 'application/pdf',
        declaredSize: 100,
      })
    const storedFiles = () => count('select count(*) as n from stored_files')

    it('封存後公告、作業、不認得的位置一律 COHORT_ARCHIVED，不多一個檔；榮譽的附件與封面照樣拿得到 ticket；沒封存的照舊', async () => {
      const active = await newCohort()
      expect((await start(active.cohortId, 'news')).ok).toBe(true)
      expect((await start(active.cohortId, 'submission')).ok).toBe(true)

      const { cohortId } = await newCohort()
      await owner.sql(`update cohorts set status = 'archived' where id = $1`, [cohortId])
      const before = await storedFiles()
      for (const placement of ['news', 'resource', 'submission', 'rules', 'showcase', '', 'HONOR', 'honor ']) {
        const refused = await start(cohortId, placement)
        expect(refused.ok || refused.code, placement).toBe('COHORT_ARCHIVED')
      }
      expect((await start(cohortId, 'news', 'cover')).ok || 'refused').toBe('refused')
      expect(await storedFiles()).toBe(before)

      expect((await start(cohortId, 'honor')).ok).toBe(true)
      expect((await start(cohortId, 'honor', 'cover')).ok).toBe(true)
    })

    it('謊報成榮譽拿到 ticket 傳上去，存成非榮譽項目時被封存守門擋下，檔案沒有被引用', async () => {
      const { cohortId } = await newCohort()
      const news = await mustCreate(cohortId, { placement: 'news', audienceKind: 'public', receiverUnit: 'none' })
      await owner.sql(`update cohorts set status = 'archived' where id = $1`, [cohortId])

      const issued = await start(cohortId, 'honor')
      if (!issued.ok) throw new Error(issued.message)
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(PDF)
          controller.close()
        },
      })
      const stored = await storage.upload(adminId, issued.receipt.ticket, stream, PDF.length)
      if (!stored.ok) throw new Error(stored.message)
      const fileId = stored.receipt.fileId

      const created = await items.create(
        adminActor(),
        input(cohortId, { placement: 'news', audienceKind: 'public', attachmentFileIds: [fileId] }),
        randomUUID(),
      )
      expect(created.ok || created.code).toBe('COHORT_ARCHIVED')
      const saved = await items.saveDraft(
        adminActor(),
        news.itemId,
        news.revision,
        input(cohortId, { placement: 'news', audienceKind: 'public', attachmentFileIds: [fileId] }),
        randomUUID(),
      )
      expect(saved.ok || saved.code).toBe('COHORT_ARCHIVED')
      expect(await count('select count(*) as n from file_references where file_id = $1', [fileId])).toBe(0)
    })

    describe('封存前拿到的 ticket，封存後才完成上傳（AC-55 F4）', () => {
      const send = (ticket: string) =>
        storage.upload(adminId, ticket, new ReadableStream<Uint8Array>({ start(c) { c.enqueue(PDF); c.close() } }), PDF.length)
      const fileRow = async (fileId: string) =>
        (await owner.sql('select status, size_bytes, checksum, finalized_at, revision from stored_files where id = $1', [fileId])).rows[0]

      it('非榮譽：COHORT_ARCHIVED，檔案列維持 uploading、沒有暫存也沒有正式檔', async () => {
        const { cohortId } = await newCohort()
        const issued = await start(cohortId, 'news')
        if (!issued.ok) throw new Error(issued.message)
        await owner.sql(`update cohorts set status = 'archived' where id = $1`, [cohortId])
        const before = await fileRow(issued.receipt.fileId)
        const refused = await send(issued.receipt.ticket)
        expect(refused.ok || refused.code).toBe('COHORT_ARCHIVED')
        expect(await fileRow(issued.receipt.fileId)).toEqual(before)
        expect(before).toMatchObject({ status: 'uploading' })
        expect(await fs.readdir(path.join(root, 'tmp')).catch(() => [])).not.toContain(issued.receipt.fileId)
      })

      it('榮譽：封存後照樣完成上傳', async () => {
        const { cohortId } = await newCohort()
        const issued = await start(cohortId, 'honor')
        if (!issued.ok) throw new Error(issued.message)
        await owner.sql(`update cohorts set status = 'archived' where id = $1`, [cohortId])
        expect((await send(issued.receipt.ticket)).ok).toBe(true)
        expect(await fileRow(issued.receipt.fileId)).toMatchObject({ status: 'stored' })
      })

      it('沒封存：非榮譽照舊完成上傳', async () => {
        const { cohortId } = await newCohort()
        const issued = await start(cohortId, 'news')
        if (!issued.ok) throw new Error(issued.message)
        expect((await send(issued.receipt.ticket)).ok).toBe(true)
        expect(await fileRow(issued.receipt.fileId)).toMatchObject({ status: 'stored' })
      })
    })
  })

  it('下載授權：草稿只有管理員；發布後本屆學生可以、別屆學生與老師不行', async () => {
    const { cohortId, stageId } = await newCohort()
    const mine = await newStudent(cohortId)
    const other = await newCohort()
    const stranger = await newStudent(other.cohortId)
    const fileId = await uploadPdf(adminId, cohortId)
    const coverId = await uploadPdf(adminId, cohortId, 'png')
    const item = await mustCreate(cohortId, {
      placement: 'news',
      audienceKind: 'cohort_students',
      attachmentFileIds: [fileId],
      coverFileId: coverId,
      stageId,
    })
    const canDownload = async (actor: ResolvedActor, id = fileId) => {
      const result = await storage.authorizeDownload(actor, id)
      if (result.ok) await result.receipt.body.cancel()
      return result.ok
    }

    expect(await canDownload(studentActor(mine))).toBe(false)
    expect(await canDownload(adminActor())).toBe(true)
    await mustPublish(item.itemId, 1, false)
    expect(await canDownload(studentActor(mine))).toBe(true)
    expect(await canDownload(studentActor(mine), coverId)).toBe(true)
    expect(await canDownload(studentActor(stranger))).toBe(false)
    expect(await canDownload(teacherActor())).toBe(false)
    expect(await canDownload({ kind: 'anonymous' })).toBe(false)
  })

  it('指定組別的附件：只有那幾組的成員下載得到（PUB-10）', async () => {
    const { cohortId, stageId } = await newCohort()
    const [a, b] = [await newStudent(cohortId), await newStudent(cohortId)]
    const g1 = await newGroup(cohortId, [a], 'G01')
    await newGroup(cohortId, [b], 'G02')
    const fileId = await uploadPdf(adminId, cohortId)
    const item = await mustCreate(cohortId, {
      stageId,
      receiverUnit: 'group',
      audienceKind: 'groups',
      groupIds: [g1],
      attachmentFileIds: [fileId],
    })
    await mustPublish(item.itemId, 1)
    const allowed = await storage.authorizeDownload(studentActor(a), fileId)
    if (allowed.ok) await allowed.receipt.body.cancel()
    expect(allowed.ok).toBe(true)
    const denied = await storage.authorizeDownload(studentActor(b), fileId)
    expect(denied.ok || denied.code).toBe('FORBIDDEN')
  })

  it('從項目拿掉的舊附件就下載不到了（只看有效引用）', async () => {
    const { cohortId } = await newCohort()
    const s = await newStudent(cohortId)
    const fileId = await uploadPdf(adminId, cohortId)
    const item = await mustCreate(cohortId, { placement: 'resource', audienceKind: 'signed_in', attachmentFileIds: [fileId] })
    const published = await mustPublish(item.itemId, 1, false)
    const before = await storage.authorizeDownload(studentActor(s), fileId)
    if (before.ok) await before.receipt.body.cancel()
    expect(before.ok).toBe(true)
    const updated = await items.updatePublished(
      adminActor(),
      item.itemId,
      published.revision,
      input(cohortId, { placement: 'resource', audienceKind: 'signed_in', attachmentFileIds: [] }),
      { notify: false },
      randomUUID(),
    )
    expect(updated.ok).toBe(true)
    expect((await storage.authorizeDownload(studentActor(s), fileId)).ok).toBe(false)
  })
})

describe('查詢', () => {
  it('工作台列表與編輯器資料', async () => {
    const { cohortId, stageId } = await newCohort()
    await newStudent(cohortId)
    const g = await newGroup(cohortId, [], 'G05')
    const news = await mustCreate(cohortId, { placement: 'news', audienceKind: 'groups', groupIds: [g] })
    const collect = await mustCreate(cohortId, { stageId })
    await mustPublish(collect.itemId, 1)

    const list = await query.list(cohortId)
    expect(list.map((r) => r.id).sort()).toEqual([news.itemId, collect.itemId].sort())
    expect(list.find((r) => r.id === news.itemId)).toMatchObject({ status: 'draft', audienceGroupCodes: ['G05'] })
    expect(list.find((r) => r.id === collect.itemId)).toMatchObject({ status: 'published', rosterCount: 1 })

    const detail = await query.get(collect.itemId)
    expect(detail).toMatchObject({ status: 'published', contentVersionNo: 1, schemaVersionNo: 1, rosterCount: 1, hasResponses: false })
    expect(detail?.publications.map((p) => p.action)).toEqual(['publish'])
    // 發布紀錄帶出操作者頭像兩欄（總表 Y-4）：沒有 profile 是 null；設了預設圖就帶出那一張。
    expect(detail?.publications[0]).toMatchObject({ actorUserId: adminId, actorAvatarPreset: null, actorAvatarFileId: null })
    await owner.sql(
      `insert into user_profiles (user_id, display_name, name_normalized, contact_email, avatar_preset)
       values ($1, 'A1', 'a1', 'a1-items-profile@example.com', 7)`,
      [adminId],
    )
    try {
      const withAvatar = await query.get(collect.itemId)
      expect(withAvatar?.publications[0]).toMatchObject({ actorUserId: adminId, actorName: 'A1', actorAvatarPreset: 7, actorAvatarFileId: null })
    } finally {
      await owner.sql('delete from user_profiles where user_id = $1', [adminId])
    }

    const options = await query.editorOptions(cohortId)
    expect(options.stages.map((s) => s.name)).toEqual(['成組期', '期中'])
    expect(options.groups.map((x) => x.code)).toEqual(['G05'])
  })

  it('工作台的「N 位」是應交數：不含免填與已移出，跟收件名單頁完成率的分母同一個口徑（PR #261 審查建議）', async () => {
    const { cohortId, stageId } = await newCohort()
    const [a, b, c] = [await newStudent(cohortId), await newStudent(cohortId), await newStudent(cohortId)]
    const collect = await mustCreate(cohortId, { stageId })
    expect((await mustPublish(collect.itemId, 1)).rosterCount).toBe(3)
    await owner.sql(
      `update response_rosters set exempt = true, exempt_reason = '休學' where item_id = $1 and receiver_id = $2`,
      [collect.itemId, a.id],
    )
    await owner.sql(
      `update response_rosters set eligible_to_business_at = eligible_from_business_at + interval '1 minute', removed_reason = '轉系'
        where item_id = $1 and receiver_id = $2`,
      [collect.itemId, b.id],
    )
    expect((await query.list(cohortId)).find((r) => r.id === collect.itemId)?.rosterCount).toBe(1)
    expect((await query.get(collect.itemId))?.rosterCount).toBe(1)
    expect(c.id).toBeTruthy()
  })

  it('資源、規則分頁一句查完（CL-1）：只列指定位置，帶分類、附件數、報名截止日與正文；不逐份 get', async () => {
    const { cohortId } = await newCohort()
    const [f1, f2] = [await uploadPdf(adminId, cohortId), await uploadPdf(adminId, cohortId)]
    const resource = await mustCreate(cohortId, {
      placement: 'resource',
      audienceKind: 'public',
      receiverUnit: 'none',
      category: '範本',
      dueAt: '',
      fields: [],
      attachmentFileIds: [f1, f2],
    })
    const rule = await mustCreate(cohortId, {
      placement: 'rules',
      audienceKind: 'public',
      receiverUnit: 'none',
      body: '<p>第一章</p>',
      dueAt: '',
      fields: [],
    })
    const contest = await mustCreate(cohortId, {
      placement: 'news',
      audienceKind: 'public',
      receiverUnit: 'none',
      category: '競賽資訊',
      dueAt: '',
      fields: [],
      registrationDeadline: '2026-10-03',
    })

    const resources = await query.listWithContent(cohortId, ['resource'])
    expect(resources.map((r) => r.id)).toEqual([resource.itemId])
    expect(resources[0]).toMatchObject({ placement: 'resource', category: '範本', attachmentCount: 2, registrationDeadline: null, status: 'draft' })
    const rules = await query.listWithContent(cohortId, ['rules'])
    expect(rules.map((r) => r.id)).toEqual([rule.itemId])
    expect(rules[0]).toMatchObject({ category: null, attachmentCount: 0, bodyHtml: '<p>第一章</p>' })
    expect((await query.listWithContent(cohortId, ['news']))[0]).toMatchObject({ id: contest.itemId, registrationDeadline: '2026-10-03' })
    // 跟 `list` 同一份清單列欄位。
    const plain = (await query.list(cohortId)).find((r) => r.id === resource.itemId)!
    expect(resources[0]).toMatchObject(plain)
    expect(await query.listWithContent(cohortId, [])).toEqual([])
    expect(await query.listWithContent('not-a-uuid', ['resource'])).toEqual([])
  })

  it('讀出正文時再淨化一次（CL-1）：資料庫被直接塞了 script／事件屬性，get 與 listWithContent 都只給清理過的', async () => {
    const { cohortId } = await newCohort()
    const rule = await mustCreate(cohortId, { placement: 'rules', audienceKind: 'public', receiverUnit: 'none', dueAt: '', fields: [] })
    // 繞過寫入時的 `sanitizeBody`，直接改頭列。
    await owner.sql(`update managed_items set body_html = $2 where id = $1`, [
      rule.itemId,
      '<p onclick="steal()">規則</p><script>alert(1)</script><img src="x" onerror="steal()">',
    ])
    expect((await itemRow(rule.itemId)).body_html).toContain('<script>')
    const detail = await query.get(rule.itemId)
    expect(detail?.bodyHtml).not.toMatch(/script|onclick|onerror/)
    expect(detail?.bodyHtml).toContain('<p>規則</p>')
    const [row] = await query.listWithContent(cohortId, ['rules'])
    expect(row?.bodyHtml).toBe(detail?.bodyHtml)
  })
})

// ── 票 16 ──────────────────────────────────────────────────────────────────────

async function mustChange(itemId: string, revision: number, action: 'withdraw' | 'archive' | 'republish') {
  const changed = await items.changeStatus(adminActor(), itemId, revision, action, randomUUID())
  if (!changed.ok) throw new Error(`${changed.code} ${changed.message}`)
  return changed.receipt
}

async function publicationActions(itemId: string): Promise<string[]> {
  return (
    await owner.sql('select action from item_publications where item_id = $1 order by real_at, id', [itemId])
  ).rows.map((r) => String(r.action))
}

async function dueWork(itemId: string) {
  return (
    await owner.sql(
      `select deadline_version, state from due_work where kind = 'deadline_snapshot' and subject_id = $1 order by deadline_version`,
      [itemId],
    )
  ).rows
}

describe('撤回、下架、重新發布（票 16；PUB-07、PUB-11）', () => {
  it('撤回：沒人作答時回到草稿、名單結束、截止工作取消並換版；再發布恢復同一個項目，實際開放時間不重設', async () => {
    const { cohortId, stageId } = await newCohort()
    const s1 = await newStudent(cohortId)
    const item = await mustCreate(cohortId, { stageId })
    const published = await mustPublish(item.itemId, 1)
    const opened = (await itemRow(item.itemId)).actual_opened_at as Date

    businessNow = new Date('2026-09-25T02:00:00Z')
    const withdrawn = await mustChange(item.itemId, published.revision, 'withdraw')
    expect(withdrawn).toMatchObject({ status: 'draft', action: 'withdraw', rosterClosed: 1 })
    const row = await itemRow(item.itemId)
    expect(row.status).toBe('draft')
    expect(row.actual_opened_at).toEqual(opened)
    expect(row.deadline_version).toBe(2)
    expect(await currentRoster(item.itemId)).toEqual([])
    expect((await rosterRows(item.itemId))[0]).toMatchObject({ removed_reason: '項目撤回成草稿' })
    expect(await dueWork(item.itemId)).toEqual([{ deadline_version: 1, state: 'cancelled' }])
    const withdrawEvents = await events(item.itemId, 'item.withdrawn')
    expect(withdrawEvents).toHaveLength(1)
    expect(withdrawEvents[0]!.recipients).toEqual([])
    expect(await count(`select count(*) as n from audit_events where target_id = $1 and action = 'item.withdraw'`, [item.itemId])).toBe(1)
    // 學生的日曆不再有撤回的收件。
    expect(await publicQuery.myDeadlines(studentActor(s1))).toEqual([])

    // 改好再發布：同一個 ID、實際開放時間不變、名單照當下對象重建、截止工作用新版本排上。
    businessNow = new Date('2026-09-26T02:00:00Z')
    const again = await mustPublish(item.itemId, withdrawn.revision)
    expect(again.actualOpenedAt).toBe(opened.toISOString())
    expect((await itemRow(item.itemId)).actual_opened_at).toEqual(opened)
    expect(await currentRoster(item.itemId)).toEqual([s1.id])
    expect(await dueWork(item.itemId)).toEqual([
      { deadline_version: 1, state: 'cancelled' },
      { deadline_version: 2, state: 'pending' },
    ])
    expect(await publicationActions(item.itemId)).toEqual(['publish', 'withdraw', 'publish'])
    expect((await publicQuery.myDeadlines(studentActor(s1))).map((d) => d.itemId)).toEqual([item.itemId])
  })

  it('已經有人作答：不能撤回（ITEM_HAS_RESPONSES），什麼都不改；下架仍可以', async () => {
    const { cohortId, stageId } = await newCohort()
    await newStudent(cohortId)
    const item = await mustCreate(cohortId, { stageId })
    const published = await mustPublish(item.itemId, 1)
    const refused = await lockedItems.changeStatus(adminActor(), item.itemId, published.revision, 'withdraw', randomUUID())
    expect(refused.ok || refused.code).toBe('ITEM_HAS_RESPONSES')
    expect((await itemRow(item.itemId)).status).toBe('published')
    expect(await currentRoster(item.itemId)).toHaveLength(1)
    expect(await publicationActions(item.itemId)).toEqual(['publish'])

    const archived = await lockedItems.changeStatus(adminActor(), item.itemId, published.revision, 'archive', randomUUID())
    expect(archived.ok).toBe(true)
  })

  it('下架保留名單與截止工作；已下架不能發布更新；重新發布不切新版本、不重設實際開放時間', async () => {
    const { cohortId, stageId } = await newCohort()
    const s1 = await newStudent(cohortId)
    const item = await mustCreate(cohortId, { stageId })
    const published = await mustPublish(item.itemId, 1)
    const opened = (await itemRow(item.itemId)).actual_opened_at as Date

    businessNow = new Date('2026-10-01T02:00:00Z')
    const archived = await mustChange(item.itemId, published.revision, 'archive')
    expect(archived.status).toBe('archived')
    expect(await currentRoster(item.itemId)).toEqual([s1.id])
    expect(await dueWork(item.itemId)).toEqual([{ deadline_version: 1, state: 'pending' }])
    expect(await publicQuery.myDeadlines(studentActor(s1))).toEqual([])
    const update = await items.updatePublished(
      adminActor(),
      item.itemId,
      archived.revision,
      input(cohortId, { stageId, title: '改標題' }),
      { notify: false },
      randomUUID(),
    )
    expect(update.ok || update.message).toContain('重新發布')

    const republished = await mustChange(item.itemId, archived.revision, 'republish')
    expect(republished).toMatchObject({ status: 'published', actualOpenedAt: opened.toISOString() })
    const row = await itemRow(item.itemId)
    expect(row.actual_opened_at).toEqual(opened)
    expect(row.deadline_version).toBe(1)
    expect(await count('select count(*) as n from item_versions where item_id = $1', [item.itemId])).toBe(1)
    expect(await dueWork(item.itemId)).toEqual([{ deadline_version: 1, state: 'pending' }])
    expect(await publicationActions(item.itemId)).toEqual(['publish', 'archive', 'republish'])
    expect(await events(item.itemId, 'item.archived')).toHaveLength(1)
    expect(await events(item.itemId, 'item.republished')).toHaveLength(1)
    expect((await query.get(item.itemId))?.publications.map((p) => p.action)).toEqual(['republish', 'archive', 'publish'])
  })

  it('重新發布照樣跑發布前檢查：已經截止的收件、下架期間解散的組別都擋下，什麼都不改', async () => {
    const { cohortId, stageId } = await newCohort()
    const a = await newStudent(cohortId)
    const g = await newGroup(cohortId, [a], 'G09')
    const item = await mustCreate(cohortId, { stageId, receiverUnit: 'group', audienceKind: 'groups', groupIds: [g] })
    const published = await mustPublish(item.itemId, 1)
    const archived = await mustChange(item.itemId, published.revision, 'archive')

    // 截止 2026/11/15 23:59（含這一分鐘）；隔天才要重新發布。
    const dueWorkBefore = await count('select count(*) as n from due_work where subject_id = $1', [item.itemId])
    businessNow = new Date('2026-11-15T16:00:00Z')
    const expired = await items.changeStatus(adminActor(), item.itemId, archived.revision, 'republish', randomUUID())
    expect(expired.ok || expired.code).toBe('VALIDATION_FAILED')
    expect(expired.ok || expired.message).toContain('截止（2026/11/15 23:59，臺灣時間）已經過了')
    expect(expired.ok || expired.details).toEqual({ checks: ['due'] })
    // 被拒就什麼都沒改（PR #260 審查建議補的整合案例）：狀態、revision、發布紀錄、事件、截止工作都跟拒絕前一樣。
    expect(await itemRow(item.itemId)).toMatchObject({ status: 'archived', revision: archived.revision })
    expect(await publicationActions(item.itemId)).toEqual(['publish', 'archive'])
    expect(await events(item.itemId, 'item.republished')).toHaveLength(0)
    expect(await count('select count(*) as n from due_work where subject_id = $1', [item.itemId])).toBe(dueWorkBefore)
    // 截止那一分鐘之內還可以。
    businessNow = new Date('2026-11-15T15:59:30Z')
    await owner.sql(`update groups set status = 'dissolved', dissolved_real_at = now(), dissolve_reason = '測試' where id = $1`, [g])
    const dissolved = await items.changeStatus(adminActor(), item.itemId, archived.revision, 'republish', randomUUID())
    expect(dissolved.ok || dissolved.code).toBe('VALIDATION_FAILED')
    expect(dissolved.ok || dissolved.message).toContain('組別')
    expect(await publicationActions(item.itemId)).toEqual(['publish', 'archive'])

    await owner.sql(`update groups set status = 'active', dissolved_real_at = null, dissolve_reason = null where id = $1`, [g])
    const ok = await items.changeStatus(adminActor(), item.itemId, archived.revision, 'republish', randomUUID())
    expect(ok.ok).toBe(true)
  })

  it('狀態不對、舊 revision、非管理員、封存的屆別：一律拒絕，什麼都不改；同一個請求重送回同一份回執', async () => {
    const { cohortId } = await newCohort()
    const student = await newStudent(cohortId)
    const item = await mustCreate(cohortId, { placement: 'news', audienceKind: 'public', receiverUnit: 'none' })

    const draftWithdraw = await items.changeStatus(adminActor(), item.itemId, 1, 'withdraw', randomUUID())
    expect(draftWithdraw.ok || draftWithdraw.code).toBe('VALIDATION_FAILED')
    const draftArchive = await items.changeStatus(adminActor(), item.itemId, 1, 'archive', randomUUID())
    expect(draftArchive.ok || draftArchive.code).toBe('VALIDATION_FAILED')

    const published = await mustPublish(item.itemId, 1, false)
    const republishPublished = await items.changeStatus(adminActor(), item.itemId, published.revision, 'republish', randomUUID())
    expect(republishPublished.ok || republishPublished.code).toBe('VALIDATION_FAILED')
    const stale = await items.changeStatus(adminActor(), item.itemId, published.revision - 1, 'archive', randomUUID())
    expect(stale.ok || stale.code).toBe('CONFLICT')
    const byStudent = await items.changeStatus(studentActor(student), item.itemId, published.revision, 'archive', randomUUID())
    expect(byStudent.ok || byStudent.code).toBe('FORBIDDEN')

    const requestId = randomUUID()
    const first = await items.changeStatus(adminActor(), item.itemId, published.revision, 'archive', requestId)
    const replay = await items.changeStatus(adminActor(), item.itemId, published.revision, 'archive', requestId)
    expect(first.ok && replay.ok && replay.receipt.revision).toBe(first.ok && first.receipt.revision)
    expect(await publicationActions(item.itemId)).toEqual(['publish', 'archive'])

    await owner.sql(`update cohorts set status = 'archived' where id = $1`, [cohortId])
    const closed = await items.changeStatus(adminActor(), item.itemId, published.revision + 1, 'republish', randomUUID())
    expect(closed.ok || closed.code).toBe('COHORT_ARCHIVED')
    expect((await itemRow(item.itemId)).status).toBe('archived')
  })
})

describe('前台查詢與訪客下載（票 16；SHW-01、SHW-02、SHW-06、PUB-10）', () => {
  const ANONYMOUS: ResolvedActor = { kind: 'anonymous' }

  function pendingActor(userId: string): ResolvedActor {
    return { kind: 'authenticated', userId, roles: [], status: 'pending', mustChangePassword: false, cohortMemberships: [] }
  }

  async function publishedNews(cohortId: string, patch: Partial<ItemInput>) {
    const item = await mustCreate(cohortId, { placement: 'news', receiverUnit: 'none', ...patch })
    const published = await mustPublish(item.itemId, 1, false)
    return { itemId: item.itemId, revision: published.revision }
  }

  it('列表依看的人過濾：訪客只有公開；登入者多看到登入可見、自己的屆別、自己的組；老師看到給老師的；草稿與下架都不在', async () => {
    const { cohortId } = await newCohort()
    const other = await newCohort()
    const inGroup = await newStudent(cohortId)
    const plain = await newStudent(cohortId)
    const outsider = await newStudent(other.cohortId)
    const g1 = await newGroup(cohortId, [inGroup], 'G01')
    const tag = randomUUID().slice(0, 8)
    const pub = await publishedNews(cohortId, { title: `${tag} 公開`, audienceKind: 'public' })
    await publishedNews(cohortId, { title: `${tag} 登入`, audienceKind: 'signed_in' })
    await publishedNews(cohortId, { title: `${tag} 本屆`, audienceKind: 'cohort_students' })
    await publishedNews(cohortId, { title: `${tag} 組別`, audienceKind: 'groups', groupIds: [g1] })
    await publishedNews(cohortId, { title: `${tag} 老師`, audienceKind: 'teachers' })
    await mustCreate(cohortId, { placement: 'news', receiverUnit: 'none', audienceKind: 'public', title: `${tag} 草稿` })
    const gone = await publishedNews(cohortId, { title: `${tag} 下架`, audienceKind: 'public' })
    await mustChange(gone.itemId, gone.revision, 'archive')

    const seen = async (actor: ResolvedActor) =>
      (await publicQuery.list(actor, 'news', { q: tag })).map((c) => c.title.replace(`${tag} `, '')).sort()
    expect(await seen(ANONYMOUS)).toEqual(['公開'])
    expect(await seen(pendingActor(plain.id))).toEqual(['公開'])
    expect(await seen(studentActor(inGroup))).toEqual(['公開', '本屆', '登入', '組別'].sort())
    expect(await seen(studentActor(plain))).toEqual(['公開', '本屆', '登入'].sort())
    expect(await seen(studentActor(outsider))).toEqual(['公開', '登入'].sort())
    expect(await seen(teacherActor())).toEqual(['公開', '登入', '老師'].sort())
    expect(await seen(adminActor())).toEqual(['公開', '本屆', '登入', '組別', '老師'].sort())

    // 前台卡片只帶公開欄位（票 39 加競賽的兩個日期與榮譽的得獎日期）。
    const [card] = await publicQuery.list(ANONYMOUS, 'news', { q: `${tag} 公開` })
    expect(Object.keys(card!).sort()).toEqual(
      [
        'attachments',
        'audienceKind',
        'awardedOn',
        'category',
        'cover',
        'eventDate',
        'id',
        'pinnedAt',
        'placement',
        'publishedAt',
        'registrationDeadline',
        'summary',
        'title',
      ].sort(),
    )
    expect(card!.id).toBe(pub.itemId)
    // 別的位置不混進來。
    expect(await publicQuery.list(ANONYMOUS, 'resource', { q: tag })).toEqual([])
  })

  it('打開單篇：公開給內容（正文重清一次）；要登入、已下架、已撤回、找不到各自不同，都不帶標題', async () => {
    const { cohortId } = await newCohort()
    const s1 = await newStudent(cohortId)
    const other = await newCohort()
    const outsider = await newStudent(other.cohortId)
    const pub = await publishedNews(cohortId, { audienceKind: 'public', body: '<p>說明會在 LM503</p>' })
    // 就算資料庫被人直接改過，前台輸出仍然是清理過的（renderBodyHtml）。
    await owner.sql(`update managed_items set body_html = $2 where id = $1`, [
      pub.itemId,
      '<p>說明會在 LM503</p><script>alert(1)</script><img src=x onerror="alert(2)">',
    ])
    const opened = await publicQuery.open(ANONYMOUS, pub.itemId, 'news')
    expect(opened.access).toBe('visible')
    expect(opened.access === 'visible' && opened.item.bodyHtml).toBe('<p>說明會在 LM503</p>')

    const cohortOnly = await publishedNews(cohortId, { audienceKind: 'cohort_students' })
    expect(await publicQuery.open(ANONYMOUS, cohortOnly.itemId, 'news')).toEqual({ access: 'need_login', placement: 'news' })
    expect((await publicQuery.open(studentActor(s1), cohortOnly.itemId, 'news')).access).toBe('visible')
    expect(await publicQuery.open(studentActor(outsider), cohortOnly.itemId, 'news')).toEqual({ access: 'not_found', placement: null })

    const archived = await publishedNews(cohortId, { audienceKind: 'public' })
    await mustChange(archived.itemId, archived.revision, 'archive')
    expect(await publicQuery.open(ANONYMOUS, archived.itemId, 'news')).toEqual({ access: 'archived', placement: 'news' })

    const withdrawn = await publishedNews(cohortId, { audienceKind: 'public' })
    await mustChange(withdrawn.itemId, withdrawn.revision, 'withdraw')
    expect(await publicQuery.open(ANONYMOUS, withdrawn.itemId, 'news')).toEqual({ access: 'withdrawn', placement: 'news' })

    const draft = await mustCreate(cohortId, { placement: 'news', receiverUnit: 'none', audienceKind: 'public' })
    expect(await publicQuery.open(adminActor(), draft.itemId, 'news')).toEqual({ access: 'not_found', placement: null })
    // 位置不對（公告的 ID 拿去資源頁）也是找不到。
    expect((await publicQuery.open(ANONYMOUS, pub.itemId, 'resource')).access).toBe('not_found')
    expect((await publicQuery.open(ANONYMOUS, 'not-a-uuid', 'news')).access).toBe('not_found')
  })

  it('分類與搜尋：分類只列看得到的；搜尋字裡的 % 不當萬用字元', async () => {
    const { cohortId } = await newCohort()
    const tag = randomUUID().slice(0, 8)
    await publishedNews(cohortId, { title: `${tag} 競賽 100%`, audienceKind: 'public', category: `競賽-${tag}` })
    await publishedNews(cohortId, { title: `${tag} 內部`, audienceKind: 'signed_in', category: `內部-${tag}` })
    const categories = await publicQuery.categories(ANONYMOUS, 'news')
    expect(categories).toContain(`競賽-${tag}`)
    expect(categories).not.toContain(`內部-${tag}`)
    expect((await publicQuery.list(ANONYMOUS, 'news', { category: `競賽-${tag}` })).map((c) => c.title)).toEqual([`${tag} 競賽 100%`])
    expect(await publicQuery.list(ANONYMOUS, 'news', { q: `${tag} %` })).toEqual([])
    expect(await publicQuery.list(ANONYMOUS, 'news', { q: `${tag} 競賽 100%` })).toHaveLength(1)
  })

  it('日曆的截止：只有本人或本人所在組別在目前名單上的發布中收件', async () => {
    const { cohortId, stageId } = await newCohort()
    const a = await newStudent(cohortId)
    const b = await newStudent(cohortId)
    const g1 = await newGroup(cohortId, [a], 'G01')
    await newGroup(cohortId, [b], 'G02')
    const groupItem = await mustCreate(cohortId, {
      stageId,
      title: 'G01 的收件',
      receiverUnit: 'group',
      audienceKind: 'groups',
      groupIds: [g1],
    })
    await mustPublish(groupItem.itemId, 1)
    const everyone = await mustCreate(cohortId, { stageId, title: '全屆個人收件', dueAt: '2026-10-30T17:00' })
    await mustPublish(everyone.itemId, 1)
    await mustCreate(cohortId, { stageId, title: '還是草稿' })

    const titles = async (actor: ResolvedActor) => (await publicQuery.myDeadlines(actor)).map((d) => d.title)
    expect(await titles(studentActor(a))).toEqual(['全屆個人收件', 'G01 的收件'])
    expect(await titles(studentActor(b))).toEqual(['全屆個人收件'])
    expect(await titles(ANONYMOUS)).toEqual([])
    const [deadline] = await publicQuery.myDeadlines(studentActor(b))
    expect(deadline).toMatchObject({ cohortId, receiverUnit: 'individual' })
    expect(deadline!.dueAt.toISOString()).toBe('2026-10-30T09:00:00.000Z')

    // 名單列從發布那一刻起算：業務鐘撥回發布之前，那兩份收件還不算他的。
    businessNow = new Date('2026-09-20T02:00:00Z')
    expect(await titles(studentActor(a))).toEqual([])
  })

  it('訪客下載：只有發布中、公開對象、目前有效引用的附件；其他一律 401（沒有這個檔也是 401）', async () => {
    const { cohortId } = await newCohort()
    const canDownload = async (actor: ResolvedActor, id: string) => {
      const result = await storage.authorizeDownload(actor, id)
      if (result.ok) await result.receipt.body.cancel()
      return result.ok ? 'ok' : result.code
    }
    const publicFile = await uploadPdf(adminId, cohortId)
    const cover = await uploadPdf(adminId, cohortId, 'png')
    const pub = await mustCreate(cohortId, {
      placement: 'news',
      receiverUnit: 'none',
      audienceKind: 'public',
      attachmentFileIds: [publicFile],
      coverFileId: cover,
    })
    expect(await canDownload(ANONYMOUS, publicFile)).toBe('UNAUTHENTICATED')
    const published = await mustPublish(pub.itemId, 1, false)
    expect(await canDownload(ANONYMOUS, publicFile)).toBe('ok')
    expect(await canDownload(ANONYMOUS, cover)).toBe('ok')

    const signedFile = await uploadPdf(adminId, cohortId)
    const signed = await mustCreate(cohortId, {
      placement: 'resource',
      receiverUnit: 'none',
      audienceKind: 'signed_in',
      attachmentFileIds: [signedFile],
    })
    await mustPublish(signed.itemId, 1, false)
    expect(await canDownload(ANONYMOUS, signedFile)).toBe('UNAUTHENTICATED')
    expect(await canDownload(teacherActor(), signedFile)).toBe('ok')

    // 待審的人：在政策之前就被擋（403），不會因為對象是公開而放行。
    const pending = await newStudent(cohortId, { status: 'pending' })
    expect(await canDownload(pendingActor(pending.id), publicFile)).toBe('FORBIDDEN')
    expect(await canDownload(ANONYMOUS, randomUUID())).toBe('UNAUTHENTICATED')
    expect(await canDownload(ANONYMOUS, 'nope')).toBe('UNAUTHENTICATED')

    // 下架後訪客就拿不到；重新發布又可以。
    const archived = await mustChange(pub.itemId, published.revision, 'archive')
    expect(await canDownload(ANONYMOUS, publicFile)).toBe('UNAUTHENTICATED')
    const back = await mustChange(pub.itemId, archived.revision, 'republish')
    expect(await canDownload(ANONYMOUS, publicFile)).toBe('ok')

    // 從項目拿掉（引用釋放）的舊附件：訪客也拿不到。
    const updated = await items.updatePublished(
      adminActor(),
      pub.itemId,
      back.revision,
      input(cohortId, { placement: 'news', receiverUnit: 'none', audienceKind: 'public', attachmentFileIds: [], coverFileId: cover }),
      { notify: false },
      randomUUID(),
    )
    expect(updated.ok).toBe(true)
    expect(await canDownload(ANONYMOUS, publicFile)).toBe('UNAUTHENTICATED')
  })
})

describe('前台卡片：封面與附件同一句查齊（#260、⑤-15 AC-62）', () => {
  it('有封面的卡片不多送查詢：stored_files 只查一次，封面與附件各自對到自己的項目', async () => {
    const { cohortId } = await newCohort()
    const coverA = await uploadPdf(adminId, cohortId, 'png')
    const coverB = await uploadPdf(adminId, cohortId, 'png')
    const fileA = await uploadPdf(adminId, cohortId)
    const fileB1 = await uploadPdf(adminId, cohortId)
    const fileB2 = await uploadPdf(adminId, cohortId)
    const a = await mustCreate(cohortId, { placement: 'news', receiverUnit: 'none', audienceKind: 'public', title: '封面 A', attachmentFileIds: [fileA], coverFileId: coverA })
    const b = await mustCreate(cohortId, { placement: 'news', receiverUnit: 'none', audienceKind: 'public', title: '封面 B', attachmentFileIds: [fileB1, fileB2], coverFileId: coverB })
    const c = await mustCreate(cohortId, { placement: 'news', receiverUnit: 'none', audienceKind: 'public', title: '沒封面', attachmentFileIds: [] })
    for (const item of [a, b, c]) await mustPublish(item.itemId, 1, false)

    const statements: string[] = []
    const counted = new PgPublicItemQuery(businessClock, () => ({
      query: ((text: string, values?: unknown[]) => {
        statements.push(text)
        return app.query(text, values)
      }) as Pick<Pool, 'query'>['query'],
    }))
    const cards = await counted.list({ kind: 'anonymous' }, 'news', { limit: 200 })

    const byId = new Map(cards.map((card) => [card.id, card]))
    expect(byId.get(a.itemId)?.cover?.fileId).toBe(coverA)
    expect(byId.get(a.itemId)?.attachments.map((f) => f.fileId)).toEqual([fileA])
    expect(byId.get(b.itemId)?.cover?.fileId).toBe(coverB)
    expect(byId.get(b.itemId)?.attachments.map((f) => f.fileId)).toEqual([fileB1, fileB2])
    expect(byId.get(c.itemId)?.cover).toBeNull()
    expect(byId.get(c.itemId)?.attachments).toEqual([])
    // 封面不再是另一句 `stored_files` 查詢（原本有封面就多 1 句，首頁三個區塊各多 1 句）。
    expect(statements.filter((s) => /\bstored_files\b/.test(s))).toHaveLength(1)
  })
})

describe('前台列表：先篩狀態、先依得獎日期排，再取筆數（#305、#307）', () => {
  const ANONYMOUS: ResolvedActor = { kind: 'anonymous' }

  /** 發布一則公開項目，再把發布時間與日期直接改成測試要的樣子（發布順序跟狀態／得獎順序刻意不同）。 */
  async function published(
    cohortId: string,
    placement: 'news' | 'honor',
    title: string,
    openedAt: string,
    dates: { registration_deadline?: string | null; event_date?: string | null; awarded_on?: string | null },
  ) {
    // 榮譽不從編輯器建（示範資料與匯入直接寫）：先建成公告，再把位置改成榮譽。
    const item = await mustCreate(cohortId, {
      placement: 'news',
      title,
      category: placement === 'news' ? '競賽資訊' : '',
      audienceKind: 'public',
      receiverUnit: 'none',
      dueAt: '',
      fields: [],
    })
    await mustPublish(item.itemId, 1, false)
    await owner.sql(
      `update managed_items set placement = $6, actual_opened_at = $2, registration_deadline = $3, event_date = $4, awarded_on = $5 where id = $1`,
      [item.itemId, openedAt, dates.registration_deadline ?? null, dates.event_date ?? null, dates.awarded_on ?? null, placement],
    )
    return item.itemId
  }

  it('競賽狀態在 SQL 裡篩：最早發布但還在報名中的那一則，limit 比總數小也拿得到；各狀態與 competitionStatus 一致', async () => {
    const { cohortId } = await newCohort()
    const tag = randomUUID().slice(0, 8)
    const today = '2026-10-10'
    await published(cohortId, 'news', `${tag} 報名中（最早發布）`, '2026-01-01T00:00:00Z', { registration_deadline: '2026-10-10' })
    await published(cohortId, 'news', `${tag} 決賽`, '2026-02-01T00:00:00Z', { registration_deadline: '2026-10-01', event_date: '2026-10-20' })
    await published(cohortId, 'news', `${tag} 只填活動日`, '2026-02-15T00:00:00Z', { event_date: '2026-10-10' })
    await published(cohortId, 'news', `${tag} 已結束 1`, '2026-03-01T00:00:00Z', { registration_deadline: '2026-09-01', event_date: '2026-09-09' })
    await published(cohortId, 'news', `${tag} 已結束 2`, '2026-04-01T00:00:00Z', { registration_deadline: '2026-10-09' })
    await published(cohortId, 'news', `${tag} 沒填日期`, '2026-05-01T00:00:00Z', {})

    const list = async (statuses: readonly ('open' | 'result' | 'closed')[], limit = 1) =>
      (await publicQuery.list(ANONYMOUS, 'news', { q: tag, category: '競賽資訊', competition: { today, statuses }, limit })).map((c) =>
        c.title.replace(`${tag} `, ''),
      )
    // 沒篩狀態時 limit 1 只拿到最新發布的那一則，篩了才拿得到報名中的。
    expect((await publicQuery.list(ANONYMOUS, 'news', { q: tag, limit: 1 })).map((c) => c.title)).toEqual([`${tag} 沒填日期`])
    expect(await list(['open'])).toEqual(['報名中（最早發布）'])
    expect(await list(['result'], 10)).toEqual(['只填活動日', '決賽'])
    expect(await list(['closed'], 10)).toEqual(['已結束 2', '已結束 1'])
    expect(await list(['open', 'result'], 10)).toEqual(['只填活動日', '決賽', '報名中（最早發布）'])
    expect(await list([], 10)).toEqual([])
    // SQL 與 application 的 competitionStatus 同一套規則。
    const all = await publicQuery.list(ANONYMOUS, 'news', { q: tag, limit: 10 })
    for (const status of ['open', 'result', 'closed'] as const) {
      expect((await list([status], 10)).sort()).toEqual(
        all
          .filter((c) => competitionStatus(c, today) === status)
          .map((c) => c.title.replace(`${tag} `, ''))
          .sort(),
      )
    }
  })

  it('榮譽依得獎日期排（沒填退回發布日的臺灣日期）再取筆數：較早發布但得獎較新的一則排在前面', async () => {
    const { cohortId } = await newCohort()
    const tag = randomUUID().slice(0, 8)
    await published(cohortId, 'honor', `${tag} 最新得獎（最早發布）`, '2026-01-01T00:00:00Z', { awarded_on: '2026-09-01' })
    await published(cohortId, 'honor', `${tag} 較早得獎`, '2026-06-01T00:00:00Z', { awarded_on: '2025-12-01' })
    // 沒填得獎日期：用發布日的臺灣日期（2026-03-01；UTC 還是 2 月 28 日）。
    await published(cohortId, 'honor', `${tag} 沒填得獎日`, '2026-02-28T17:00:00Z', {})

    const titles = async (order: 'awarded' | 'awarded-asc', limit: number) =>
      (await publicQuery.list(ANONYMOUS, 'honor', { q: tag, order, limit })).map((c) => c.title.replace(`${tag} `, ''))
    expect(await titles('awarded', 1)).toEqual(['最新得獎（最早發布）'])
    expect(await titles('awarded', 3)).toEqual(['最新得獎（最早發布）', '沒填得獎日', '較早得獎'])
    expect(await titles('awarded-asc', 1)).toEqual(['較早得獎'])
    // 發布日的臺灣日期（2026-03-01）排在 2026-03-01 以前得獎的後面、以後的前面。
    expect(await titles('awarded-asc', 3)).toEqual(['較早得獎', '沒填得獎日', '最新得獎（最早發布）'])
  })
})

describe('刪除（第三波 W1；AC-3～AC-7）：只限草稿與已下架、有人交件擋下、之後各處都當作不存在', () => {
  it('草稿可以刪：清單與編輯器都看不到、寫稽核 item.deleted；同一個請求重送回同一份回執，之後再動都是找不到', async () => {
    const { cohortId } = await newCohort()
    const item = await mustCreate(cohortId, { placement: 'news', audienceKind: 'public', receiverUnit: 'none', title: '要刪的草稿' })

    const requestId = randomUUID()
    const deleted = await items.delete(adminActor(), item.itemId, 1, requestId)
    expect(deleted.ok && deleted.receipt).toMatchObject({ itemId: item.itemId, cohortId, title: '要刪的草稿', status: 'draft' })
    const row = await itemRow(item.itemId)
    expect(row.status).toBe('draft')
    expect(row.deleted_at).toBeInstanceOf(Date)
    expect(row.deleted_by_user_id).toBe(adminId)
    expect((await query.list(cohortId)).map((r) => r.id)).not.toContain(item.itemId)
    expect(await query.get(item.itemId)).toBeNull()
    const audit = await owner.sql(`select payload from audit_events where target_id = $1 and action = 'item.deleted'`, [item.itemId])
    expect(audit.rows).toHaveLength(1)
    expect(audit.rows[0]!.payload).toMatchObject({ status: 'draft', title: '要刪的草稿', placement: 'news', cohortId })

    const replay = await items.delete(adminActor(), item.itemId, 1, requestId)
    expect(replay.ok && replay.receipt.itemId).toBe(item.itemId)
    const again = await items.delete(adminActor(), item.itemId, 2, randomUUID())
    expect(again.ok || again.message).toContain('找不到這個項目')
    const save = await items.saveDraft(adminActor(), item.itemId, 2, input(cohortId, { placement: 'news', audienceKind: 'public' }), randomUUID())
    expect(save.ok || save.message).toContain('找不到這個項目')
    const publish = await items.publish(adminActor(), item.itemId, 2, { notify: false }, randomUUID())
    expect(publish.ok || publish.message).toContain('找不到這個項目')
    expect(await count(`select count(*) as n from audit_events where target_id = $1 and action = 'item.deleted'`, [item.itemId])).toBe(1)
  })

  it('發布中不能刪（要先撤回或下架）；非管理員、舊 revision 一律拒絕；什麼都不改', async () => {
    const { cohortId } = await newCohort()
    const student = await newStudent(cohortId)
    const item = await mustCreate(cohortId, { placement: 'news', audienceKind: 'public', receiverUnit: 'none' })
    const published = await mustPublish(item.itemId, 1, false)

    const refused = await items.delete(adminActor(), item.itemId, published.revision, randomUUID())
    expect(refused.ok || refused.code).toBe('VALIDATION_FAILED')
    expect(refused.ok || refused.message).toContain('發布中的項目不能刪除')
    const archived = await mustChange(item.itemId, published.revision, 'archive')
    const byStudent = await items.delete(studentActor(student), item.itemId, archived.revision, randomUUID())
    expect(byStudent.ok || byStudent.code).toBe('FORBIDDEN')
    const stale = await items.delete(adminActor(), item.itemId, archived.revision - 1, randomUUID())
    expect(stale.ok || stale.code).toBe('CONFLICT')
    expect(await itemRow(item.itemId)).toMatchObject({ status: 'archived', deleted_at: null, revision: archived.revision })
  })

  it('已下架的公開公告刪掉後：原網址對訪客與管理員都是「已刪除」（不是已下架，CL-14）、附件與封面連管理員都下載不到、檔案管理不再列它為引用來源', async () => {
    const { cohortId } = await newCohort()
    const fileId = await uploadPdf(adminId, cohortId)
    const coverId = await uploadPdf(adminId, cohortId, 'png')
    const item = await mustCreate(cohortId, {
      placement: 'news',
      audienceKind: 'public',
      receiverUnit: 'none',
      attachmentFileIds: [fileId],
      coverFileId: coverId,
    })
    const published = await mustPublish(item.itemId, 1, false)
    const archived = await mustChange(item.itemId, published.revision, 'archive')
    const canDownload = async (actor: ResolvedActor, id: string) => {
      const result = await storage.authorizeDownload(actor, id)
      if (result.ok) await result.receipt.body.cancel()
      return result.ok
    }
    expect((await publicQuery.open({ kind: 'anonymous' }, item.itemId, 'news')).access).toBe('archived')
    expect(await canDownload(adminActor(), fileId)).toBe(true)

    const deleted = await items.delete(adminActor(), item.itemId, archived.revision, randomUUID())
    expect(deleted.ok).toBe(true)
    // CL-14：原本看得到的人（公開公告＝訪客與管理員都算）看到「已刪除」，不是裸 404；不帶標題與內容。
    expect(await publicQuery.open({ kind: 'anonymous' }, item.itemId, 'news')).toEqual({ access: 'deleted', placement: 'news' })
    expect(await publicQuery.open(adminActor(), item.itemId, 'news')).toEqual({ access: 'deleted', placement: 'news' })
    for (const id of [fileId, coverId]) {
      expect(await canDownload({ kind: 'anonymous' }, id)).toBe(false)
      expect(await canDownload(adminActor(), id)).toBe(false)
    }
    // 附件引用照留（不刪檔、不放引用），只是不再算數。
    expect(await count('select count(*) as n from file_references where ref_id = $1 and released_at is null', [item.itemId])).toBe(2)
    const files = await listStoredFiles(app)
    for (const id of [fileId, coverId]) {
      const listed = files.find((f) => f.id === id)
      expect(listed).toBeDefined()
      expect(listed!.where).toBeNull()
      expect(listed!.activeRefs).toBe(0)
    }
  })

  it('已下架、沒人交件的收件：可以刪，截止快照工作一併取消；學生日曆與名單頁都看不到；原通知仍點得開、目的頁是找不到', async () => {
    const { cohortId, stageId } = await newCohort()
    const s1 = await newStudent(cohortId)
    const item = await mustCreate(cohortId, { stageId })
    const published = await mustPublish(item.itemId, 1)
    // 把「新收件」事件投影成學生的通知（背景工作那一段）。
    await new PgNotificationProjector({ pool: () => app, events: new PgEventPublisher(), businessClock, log: () => {} }).runOnce()
    const archived = await mustChange(item.itemId, published.revision, 'archive')
    expect(await dueWork(item.itemId)).toEqual([{ deadline_version: 1, state: 'pending' }])

    const deleted = await items.delete(adminActor(), item.itemId, archived.revision, randomUUID())
    expect(deleted.ok && deleted.receipt.status).toBe('archived')
    expect(await dueWork(item.itemId)).toEqual([{ deadline_version: 1, state: 'cancelled' }])
    expect(await publicQuery.myDeadlines(studentActor(s1))).toEqual([])
    expect((await query.list(cohortId)).map((r) => r.id)).not.toContain(item.itemId)
    // 已寄出的「新收件」通知事件不收回。
    expect(await events(item.itemId, 'item.published')).toHaveLength(1)
    // AC-6：通知還在而且點得開（連到作業區那一份），那一頁的查詢找不到它 → 頁面回中文 404。
    const inbox = await new PgInbox({ db: () => app }).list(studentActor(s1), { kind: 'all' }, null)
    const note = inbox.items.find((n) => n.source.state === 'ok' && n.source.href === `/dashboard/student/affairs/${item.itemId}`)
    expect(note).toBeDefined()
    expect(await new PgSubmissionQuery(() => app, new PgSubmissionLateFlags(() => app)).myItem(s1.id, item.itemId)).toBeNull()
    expect((await new PgSubmissionQuery(() => app, new PgSubmissionLateFlags(() => app)).myItems(s1.id)).map((r) => r.itemId)).not.toContain(item.itemId)
  })

  it('已刪除的公告（CL-14）：原本在對象內的人看到「已刪除」；不在對象內的照舊找不到、訪客照舊先登入；從沒發布過的草稿刪掉仍是找不到', async () => {
    const { cohortId } = await newCohort()
    const s1 = await newStudent(cohortId)
    const outsider = await newStudent((await newCohort()).cohortId)
    const created = await mustCreate(cohortId, { placement: 'news', receiverUnit: 'none', audienceKind: 'cohort_students' })
    const news = { itemId: created.itemId, revision: (await mustPublish(created.itemId, 1, false)).revision }
    // 刪除前後，看不到的人拿到的結果一模一樣（分不出被刪了）。
    const before = {
      outsider: await publicQuery.open(studentActor(outsider), news.itemId, 'news'),
      anonymous: await publicQuery.open({ kind: 'anonymous' }, news.itemId, 'news'),
    }
    const archived = await mustChange(news.itemId, news.revision, 'archive')
    expect((await items.delete(adminActor(), news.itemId, archived.revision, randomUUID())).ok).toBe(true)

    expect(await publicQuery.open(studentActor(s1), news.itemId, 'news')).toEqual({ access: 'deleted', placement: 'news' })
    expect(await publicQuery.open(adminActor(), news.itemId, 'news')).toEqual({ access: 'deleted', placement: 'news' })
    expect(await publicQuery.open(studentActor(outsider), news.itemId, 'news')).toEqual({ access: 'not_found', placement: null })
    expect(await publicQuery.open({ kind: 'anonymous' }, news.itemId, 'news')).toEqual({ access: 'need_login', placement: 'news' })
    expect(before).toEqual({ outsider: { access: 'not_found', placement: null }, anonymous: { access: 'need_login', placement: 'news' } })
    // 不是公告的位置照舊找不到。
    expect((await publicQuery.open(studentActor(s1), news.itemId, 'resource')).access).toBe('not_found')

    const draft = await mustCreate(cohortId, { placement: 'news', receiverUnit: 'none', audienceKind: 'public' })
    expect((await items.delete(adminActor(), draft.itemId, draft.revision, randomUUID())).ok).toBe(true)
    expect(await publicQuery.open({ kind: 'anonymous' }, draft.itemId, 'news')).toEqual({ access: 'not_found', placement: null })
    expect(await publicQuery.open(adminActor(), draft.itemId, 'news')).toEqual({ access: 'not_found', placement: null })
  })

  it('已刪除的作業（CL-14 `deletedItemSeenBy`）：名單上的學生、此刻指導該屆的老師才算「看得到」；外人、別屆老師、還在的作業、從沒發布的草稿都不算', async () => {
    const { cohortId } = await newCohort()
    const s1 = await newStudent(cohortId)
    const outsider = await newStudent((await newCohort()).cohortId)
    const groupId = await newGroup(cohortId, [], 'G77')
    const advisor = await newTeacher()
    await assignAdvisor(groupId, advisor)
    const otherAdvisor = await newTeacher()
    await assignAdvisor(await newGroup((await newCohort()).cohortId, [], 'G78'), otherAdvisor)
    const submissions = new PgSubmissionQuery(() => app, new PgSubmissionLateFlags(() => app))

    const item = await mustCreate(cohortId)
    const published = await mustPublish(item.itemId, 1)
    // 還在的作業：一律 false（頁面該走原本的路）。
    expect(await submissions.deletedItemSeenBy(s1.id, item.itemId)).toBe(false)
    const archived = await mustChange(item.itemId, published.revision, 'archive')
    expect((await items.delete(adminActor(), item.itemId, archived.revision, randomUUID())).ok).toBe(true)

    expect(await submissions.deletedItemSeenBy(s1.id, item.itemId)).toBe(true)
    expect(await submissions.deletedItemSeenBy(outsider.id, item.itemId)).toBe(false)
    expect(await submissions.deletedItemSeenBy(advisor, item.itemId, { asAdvisor: true })).toBe(true)
    expect(await submissions.deletedItemSeenBy(advisor, item.itemId)).toBe(false)
    expect(await submissions.deletedItemSeenBy(otherAdvisor, item.itemId, { asAdvisor: true })).toBe(false)
    expect(await submissions.deletedItemSeenBy(s1.id, randomUUID())).toBe(false)
    expect(await submissions.deletedItemSeenBy(s1.id, 'not-a-uuid')).toBe(false)

    const draft = await mustCreate(cohortId)
    expect((await items.delete(adminActor(), draft.itemId, draft.revision, randomUUID())).ok).toBe(true)
    expect(await submissions.deletedItemSeenBy(s1.id, draft.itemId)).toBe(false)
    expect(await submissions.deletedItemSeenBy(advisor, draft.itemId, { asAdvisor: true })).toBe(false)
  })

  it('已有人交件（Q28）：學生存過草稿的收件下架後也不能刪，只能下架（ITEM_HAS_RESPONSES），項目仍在清單', async () => {
    const { cohortId, stageId } = await newCohort()
    const s1 = await newStudent(cohortId)
    const item = await mustCreate(cohortId, { stageId })
    const published = await mustPublish(item.itemId, 1)
    // 真的回答資料：學生在這份收件存過一份有內容的草稿（`hasAnyResponse` 算它）。
    await owner.sql(
      `insert into submission_drafts (id, item_id, receiver_kind, receiver_id, schema_version_id, answers, created_by_kind, created_by_user_id)
       select gen_random_uuid(), $1, 'user', $2, m.current_schema_version_id, '{"report":"草稿"}'::jsonb, 'user', $2
         from managed_items m where m.id = $1`,
      [item.itemId, s1.id],
    )
    const archived = await mustChange(item.itemId, published.revision, 'archive')

    const refused = await items.delete(adminActor(), item.itemId, archived.revision, randomUUID())
    expect(refused.ok || { code: refused.code, message: refused.message }).toEqual({
      code: 'ITEM_HAS_RESPONSES',
      message: '已經有學生交件，只能下架，不能刪除。',
    })
    expect((await itemRow(item.itemId)).deleted_at).toBeNull()
    expect((await query.list(cohortId)).map((r) => r.id)).toContain(item.itemId)
  })

  it('DB 也擋：發布中的列不能有刪除標記', async () => {
    const { cohortId } = await newCohort()
    const item = await mustCreate(cohortId, { placement: 'news', audienceKind: 'public', receiverUnit: 'none' })
    await mustPublish(item.itemId, 1, false)
    await expect(
      owner.sql('update managed_items set deleted_at = now(), deleted_by_user_id = $2 where id = $1', [item.itemId, adminId]),
    ).rejects.toThrow(/managed_items_deleted_check/)
  })
})

describe('榮譽榜（第三波 W1；AC-8、AC-9）：公開、不收件、不發通知；封存屆別仍可管理', () => {
  const honor = (cohortId: string, patch: Partial<ItemInput> = {}) =>
    input(cohortId, {
      placement: 'honor',
      audienceKind: 'public',
      receiverUnit: 'none',
      dueAt: '',
      fields: [],
      title: '全國大專校院資訊應用服務創新競賽 佳作',
      ...patch,
    })

  it('新增並發布（得獎日期 2026-09-30）：前台榮譽榜看得到、帶得獎日期；勾了通知也不發', async () => {
    const { cohortId } = await newCohort()
    const created = await items.create(adminActor(), honor(cohortId, { awardedOn: '2026-09-30' }), randomUUID())
    if (!created.ok) throw new Error(created.message)
    expect((await itemRow(created.receipt.itemId)).receiver_unit).toBe('none')
    expect((await query.get(created.receipt.itemId))?.awardedOn).toBe('2026-09-30')

    const published = await mustPublish(created.receipt.itemId, created.receipt.revision, true)
    expect(published.notifiedCount).toBe(0)
    expect(await events(created.receipt.itemId, 'item.announced')).toHaveLength(0)
    const cards = await publicQuery.list({ kind: 'anonymous' }, 'honor', { order: 'awarded' })
    expect(cards.find((c) => c.id === created.receipt.itemId)?.awardedOn).toBe('2026-09-30')

    // 對象一定要公開。
    const hidden = await items.create(adminActor(), honor(cohortId, { audienceKind: 'signed_in' }), randomUUID())
    expect(hidden.ok || hidden.message).toContain('公開訪客')
  })

  it('封存屆別的榮譽：可以下架、重新發布（勾通知也不發）、改標題、新增、刪除；同屆的公告照樣擋', async () => {
    const { cohortId } = await newCohort()
    const created = await mustCreate(cohortId, honor(cohortId))
    const published = await mustPublish(created.itemId, created.revision, false)
    const news = await mustCreate(cohortId, { placement: 'news', audienceKind: 'public', receiverUnit: 'none' })
    await owner.sql(`update cohorts set status = 'archived' where id = $1`, [cohortId])

    const archived = await mustChange(created.itemId, published.revision, 'archive')
    expect((await publicQuery.list({ kind: 'anonymous' }, 'honor')).map((c) => c.id)).not.toContain(created.itemId)
    const republished = await items.changeStatus(adminActor(), created.itemId, archived.revision, 'republish', randomUUID(), { notify: true })
    if (!republished.ok) throw new Error(republished.message)
    expect(republished.receipt.notifiedCount).toBe(0)
    expect(await events(created.itemId, 'item.announced')).toHaveLength(0)
    expect((await publicQuery.list({ kind: 'anonymous' }, 'honor')).map((c) => c.id)).toContain(created.itemId)

    const renamed = await items.updatePublished(
      adminActor(),
      created.itemId,
      republished.receipt.revision,
      honor(cohortId, { title: '改過的榮譽標題', awardedOn: '2025-12-01' }),
      { notify: true },
      randomUUID(),
    )
    if (!renamed.ok) throw new Error(renamed.message)
    expect(renamed.receipt.notifiedCount).toBe(0)
    expect(await itemRow(created.itemId)).toMatchObject({ title: '改過的榮譽標題' })
    expect((await query.get(created.itemId))?.awardedOn).toBe('2025-12-01')

    const added = await items.create(adminActor(), honor(cohortId, { title: '補登的歷屆榮譽' }), randomUUID())
    expect(added.ok).toBe(true)
    const deleted = added.ok ? await items.delete(adminActor(), added.receipt.itemId, added.receipt.revision, randomUUID()) : null
    expect(deleted?.ok).toBe(true)

    const newsArchive = await items.delete(adminActor(), news.itemId, news.revision, randomUUID())
    expect(newsArchive.ok || newsArchive.code).toBe('COHORT_ARCHIVED')
    const newsCreate = await items.create(adminActor(), input(cohortId, { placement: 'news', audienceKind: 'public' }), randomUUID())
    expect(newsCreate.ok || newsCreate.code).toBe('COHORT_ARCHIVED')
    // 存草稿把公告改成榮譽也不行（原本的位置不是榮譽）。
    const sneaky = await items.saveDraft(adminActor(), news.itemId, news.revision, honor(cohortId), randomUUID())
    expect(sneaky.ok || sneaky.code).toBe('COHORT_ARCHIVED')
  })
})

describe('指導老師（第三波 W4；Q13、Q14，AC-32、AC-33）：本屆公告與資源唯讀、不通知；指定組別公告看得到也通知', () => {
  // 這一段另外建老師帳號：放在檔尾，前面「全部老師只寫給 T1」的斷言不受影響。
  async function newTeacher(): Promise<string> {
    seq += 1
    const user = await owner.sql(
      `insert into users (id, name, email, email_verified, updated_at, status)
       values (gen_random_uuid(), $1, $2, true, now(), 'active') returning id`,
      [`老師${seq}`, `t${seq}-items@example.com`],
    )
    const id = String(user.rows[0]!.id)
    await owner.sql(
      `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at)
       values (gen_random_uuid(), $1, 'teacher', $2, now())`,
      [id, adminId],
    )
    return id
  }

  async function assignAdvisor(groupId: string, teacherUserId: string): Promise<string> {
    const row = await owner.sql(
      `insert into advisor_assignments (id, group_id, teacher_user_id, source, valid_from, assigned_by_user_id, reason)
       values (gen_random_uuid(), $1, $2, 'admin', now(), $3, '測試指派') returning id`,
      [groupId, teacherUserId, adminId],
    )
    return String(row.rows[0]!.id)
  }

  function teacherOf(userId: string): ResolvedActor {
    return { kind: 'authenticated', userId, roles: ['teacher'], status: 'active', mustChangePassword: false, cohortMemberships: [] }
  }

  async function published(cohortId: string, patch: Partial<ItemInput>, notify = false) {
    const item = await mustCreate(cohortId, { placement: 'news', receiverUnit: 'none', ...patch })
    await mustPublish(item.itemId, 1, notify)
    return item.itemId
  }

  /** 本屆一組 G01（一位組員、一位指導老師）、一組 G02（另一位指導老師）；另一屆一組（只指導別屆的老師）。 */
  async function scene() {
    const { cohortId, stageId } = await newCohort()
    const other = await newCohort()
    const [member, otherMember, elsewhere] = [await newStudent(cohortId), await newStudent(cohortId), await newStudent(other.cohortId)]
    const g1 = await newGroup(cohortId, [member], 'G01')
    const g2 = await newGroup(cohortId, [otherMember], 'G02')
    const g9 = await newGroup(other.cohortId, [elsewhere], 'G09')
    const [advisor1, advisor2, otherCohortAdvisor] = [await newTeacher(), await newTeacher(), await newTeacher()]
    await assignAdvisor(g1, advisor1)
    await assignAdvisor(g2, advisor2)
    await assignAdvisor(g9, otherCohortAdvisor)
    return { cohortId, stageId, member, g1, g2, advisor1, advisor2, otherCohortAdvisor }
  }

  it('前台列表與單篇：指導本屆的老師看得到「本屆學生」的公告與資源、自己那組的組別公告；沒指導的與只指導別屆的看不到；收件看不到', async () => {
    const s = await scene()
    const tag = randomUUID().slice(0, 8)
    const cohortNews = await published(s.cohortId, { title: `${tag} 本屆`, audienceKind: 'cohort_students' })
    await published(s.cohortId, { title: `${tag} G01`, audienceKind: 'groups', groupIds: [s.g1] })
    await published(s.cohortId, { title: `${tag} G02`, audienceKind: 'groups', groupIds: [s.g2] })
    await published(s.cohortId, { title: `${tag} 老師`, audienceKind: 'teachers' })
    await published(s.cohortId, { placement: 'resource', title: `${tag} 範本`, audienceKind: 'cohort_students' })
    const collect = await mustCreate(s.cohortId, { stageId: s.stageId, title: `${tag} 收件` })
    await mustPublish(collect.itemId, 1, false)

    const seen = async (actor: ResolvedActor, placement: 'news' | 'resource' = 'news') =>
      (await publicQuery.list(actor, placement, { q: tag })).map((c) => c.title.replace(`${tag} `, '')).sort()
    expect(await seen(teacherOf(s.advisor1))).toEqual(['G01', '本屆', '老師'].sort())
    expect(await seen(teacherOf(s.advisor2))).toEqual(['G02', '本屆', '老師'].sort())
    expect(await seen(teacherOf(s.otherCohortAdvisor))).toEqual(['老師'])
    expect(await seen(teacherActor())).toEqual(['老師'])
    expect(await seen(teacherOf(s.advisor1), 'resource')).toEqual(['範本'])
    expect(await seen(teacherOf(s.otherCohortAdvisor), 'resource')).toEqual([])
    // 組員身分不受影響：學生仍只看到自己那組與本屆的。
    expect(await seen(studentActor(s.member))).toEqual(['G01', '本屆'].sort())

    expect((await publicQuery.open(teacherOf(s.advisor1), cohortNews, 'news')).access).toBe('visible')
    expect((await publicQuery.open(teacherOf(s.otherCohortAdvisor), cohortNews, 'news')).access).toBe('not_found')
    expect((await publicQuery.open(teacherActor(), cohortNews, 'news')).access).toBe('not_found')
    // 收件（本屆學生、個人一份）：指導老師當作找不到；同屆學生看得到。
    expect((await publicQuery.open(teacherOf(s.advisor1), collect.itemId, 'submission')).access).toBe('not_found')
    expect((await publicQuery.open(studentActor(s.member), collect.itemId, 'submission')).access).toBe('visible')
  })

  it('附件下載跟前台同一條規則：指導本屆的老師下載得到本屆資源的附件，收件的附件、別人那組的組別公告附件下載不到', async () => {
    const s = await scene()
    const resourceFile = await uploadPdf(adminId, s.cohortId)
    const collectFile = await uploadPdf(adminId, s.cohortId)
    const groupFile = await uploadPdf(adminId, s.cohortId)
    await published(s.cohortId, { placement: 'resource', audienceKind: 'cohort_students', attachmentFileIds: [resourceFile] })
    const collect = await mustCreate(s.cohortId, { stageId: s.stageId, attachmentFileIds: [collectFile] })
    await mustPublish(collect.itemId, 1, false)
    await published(s.cohortId, { audienceKind: 'groups', groupIds: [s.g2], attachmentFileIds: [groupFile] })

    const canDownload = async (actor: ResolvedActor, id: string) => {
      const result = await storage.authorizeDownload(actor, id)
      if (result.ok) await result.receipt.body.cancel()
      return result.ok
    }
    expect(await canDownload(teacherOf(s.advisor1), resourceFile)).toBe(true)
    expect(await canDownload(teacherOf(s.otherCohortAdvisor), resourceFile)).toBe(false)
    expect(await canDownload(teacherActor(), resourceFile)).toBe(false)
    expect(await canDownload(teacherOf(s.advisor1), collectFile)).toBe(false)
    expect(await canDownload(studentActor(s.member), collectFile)).toBe(true)
    expect(await canDownload(teacherOf(s.advisor1), groupFile)).toBe(false)
    expect(await canDownload(teacherOf(s.advisor2), groupFile)).toBe(true)
  })

  it('指定組別的收件（整組一份）：組員看得到、下載得到附件；那組的指導老師列不到、打不開、下載不到', async () => {
    const s = await scene()
    const fileId = await uploadPdf(adminId, s.cohortId)
    const tag = randomUUID().slice(0, 8)
    const collect = await mustCreate(s.cohortId, {
      stageId: s.stageId,
      title: `${tag} G01 收件`,
      audienceKind: 'groups',
      groupIds: [s.g1],
      receiverUnit: 'group',
      attachmentFileIds: [fileId],
    })
    await mustPublish(collect.itemId, 1, false)
    const canDownload = async (actor: ResolvedActor) => {
      const result = await storage.authorizeDownload(actor, fileId)
      if (result.ok) await result.receipt.body.cancel()
      return result.ok
    }
    const listed = async (actor: ResolvedActor) => (await publicQuery.list(actor, 'submission', { q: tag })).length

    expect(await listed(studentActor(s.member))).toBe(1)
    expect((await publicQuery.open(studentActor(s.member), collect.itemId, 'submission')).access).toBe('visible')
    expect(await canDownload(studentActor(s.member))).toBe(true)

    expect(await listed(teacherOf(s.advisor1))).toBe(0)
    expect((await publicQuery.open(teacherOf(s.advisor1), collect.itemId, 'submission')).access).toBe('not_found')
    expect(await canDownload(teacherOf(s.advisor1))).toBe(false)
  })

  it('通知：指定組別的重要公告寫給組員＋那組目前的指導老師，別組的指導老師不收；本屆學生的重要公告不寫給任何老師', async () => {
    const s = await scene()
    const groupNews = await published(s.cohortId, { audienceKind: 'groups', groupIds: [s.g1] }, true)
    const recipients = (await events(groupNews, 'item.announced'))[0]!.recipients as string[]
    expect([...recipients].sort()).toEqual([s.member.id, s.advisor1].sort())

    const cohortNews = await published(s.cohortId, { audienceKind: 'cohort_students' }, true)
    const cohortRecipients = (await events(cohortNews, 'item.announced'))[0]!.recipients as string[]
    expect(cohortRecipients).toContain(s.member.id)
    for (const teacher of [s.advisor1, s.advisor2, s.otherCohortAdvisor, teacherId]) expect(cohortRecipients).not.toContain(teacher)
  })

  it('只列指定對象（老師首頁）：SQL 先篩對象再取筆數，較舊的老師公告不會被 101 則較新的公開公告擠掉；不會因此多看到別人的', async () => {
    const s = await scene()
    const tag = randomUUID().slice(0, 8)
    await published(s.cohortId, { title: `${tag} 老師`, audienceKind: 'teachers' })
    await published(s.cohortId, { title: `${tag} G02`, audienceKind: 'groups', groupIds: [s.g2] })
    await published(s.cohortId, { title: `${tag} G01`, audienceKind: 'groups', groupIds: [s.g1] })
    for (let i = 0; i < 101; i += 1) await published(s.cohortId, { title: `${tag} 公開 ${i}`, audienceKind: 'public' })

    const teacherKinds = ['teachers', 'signed_in', 'groups'] as const
    // 舊做法（先取 100 則再在畫面挑）：老師公告全被擠掉。
    const recent = await publicQuery.list(teacherOf(s.advisor1), 'news', { q: tag, limit: 100 })
    expect(recent.filter((c) => (teacherKinds as readonly string[]).includes(c.audienceKind))).toEqual([])

    const titles = async (actor: ResolvedActor) =>
      (await publicQuery.list(actor, 'news', { q: tag, audiences: teacherKinds, limit: 5 })).map((c) => c.title.replace(`${tag} `, ''))
    expect(await titles(teacherOf(s.advisor1))).toEqual(['G01', '老師'])
    expect(await titles(teacherOf(s.advisor2))).toEqual(['G02', '老師'])
    expect(await titles(teacherActor())).toEqual(['老師'])
    expect(await publicQuery.list(teacherOf(s.advisor1), 'news', { q: tag, audiences: [] })).toEqual([])
  })

  it('目前指導的屆別（老師首頁「本屆活動」用）：只算有效指派；沒指導、學生、訪客都是空的；解除後就沒有', async () => {
    const s = await scene()
    const other = (await owner.sql(`select g.cohort_id from advisor_assignments a join groups g on g.id = a.group_id
                                     where a.teacher_user_id = $1 and a.valid_to is null`, [s.otherCohortAdvisor])).rows[0]!.cohort_id
    expect(await publicQuery.advisedCohortIds(teacherOf(s.advisor1))).toEqual([s.cohortId])
    expect(await publicQuery.advisedCohortIds(teacherOf(s.otherCohortAdvisor))).toEqual([String(other)])
    expect(await publicQuery.advisedCohortIds(teacherActor())).toEqual([])
    expect(await publicQuery.advisedCohortIds(studentActor(s.member))).toEqual([])
    expect(await publicQuery.advisedCohortIds({ kind: 'anonymous' })).toEqual([])
    await owner.sql(
      `update advisor_assignments set valid_to = now(), ended_real_at = now(), ended_by_user_id = $2, end_reason = '測試解除'
        where teacher_user_id = $1 and valid_to is null`,
      [s.advisor1, adminId],
    )
    expect(await publicQuery.advisedCohortIds(teacherOf(s.advisor1))).toEqual([])
  })

  it('解除指導後（valid_to 有值）就不算指導老師：看不到、也不再收到該組公告的通知', async () => {
    const s = await scene()
    await owner.sql(
      `update advisor_assignments set valid_to = now(), ended_real_at = now(), ended_by_user_id = $2, end_reason = '測試解除'
        where group_id = $1 and valid_to is null`,
      [s.g1, adminId],
    )
    const tag = randomUUID().slice(0, 8)
    const itemId = await published(s.cohortId, { title: `${tag} G01`, audienceKind: 'groups', groupIds: [s.g1] }, true)
    await published(s.cohortId, { title: `${tag} 本屆`, audienceKind: 'cohort_students' })
    expect(await publicQuery.list(teacherOf(s.advisor1), 'news', { q: tag })).toEqual([])
    expect((await events(itemId, 'item.announced'))[0]!.recipients).toEqual([s.member.id])
  })
})

describe('公告置頂（第 1 批 V1；Q48-a，AC-V01～V03、V07～V10）', () => {
  const ANONYMOUS: ResolvedActor = { kind: 'anonymous' }

  /** 發布一則公告（預設公開），再把第一次發布時間改成測試要的樣子（排序看它）。 */
  async function news(cohortId: string, title: string, openedAt: string, patch: Partial<ItemInput> = {}) {
    const item = await mustCreate(cohortId, {
      placement: 'news',
      title,
      audienceKind: 'public',
      receiverUnit: 'none',
      dueAt: '',
      fields: [],
      ...patch,
    })
    const published = await mustPublish(item.itemId, 1, false)
    await owner.sql('update managed_items set actual_opened_at = $2 where id = $1', [item.itemId, openedAt])
    return { itemId: item.itemId, revision: published.revision }
  }

  async function mustPin(itemId: string, pinned = true) {
    const result = await items.setPinned(adminActor(), itemId, pinned, randomUUID())
    if (!result.ok) throw new Error(`${result.code} ${result.message}`)
    return result.receipt
  }

  const titles = async (actor: ResolvedActor, tag: string, filter: { order?: 'oldest'; category?: string } = {}) =>
    (await publicQuery.list(actor, 'news', { q: tag, ...filter })).map((c) => c.title.replace(`${tag} `, ''))

  it('置頂後排最前、卡片帶置頂時間；revision、版本、發布紀錄都不動，稽核一筆 item.pin；oldest 不受影響', async () => {
    const { cohortId } = await newCohort()
    const tag = randomUUID().slice(0, 8)
    await news(cohortId, `${tag} A`, '2026-09-01T00:00:00Z')
    const b = await news(cohortId, `${tag} B`, '2026-09-10T00:00:00Z')
    await news(cohortId, `${tag} C`, '2026-09-20T00:00:00Z')
    expect(await titles(ANONYMOUS, tag)).toEqual(['C', 'B', 'A'])

    const versionsBefore = await count('select count(*) as n from item_versions where item_id = $1', [b.itemId])
    const publicationsBefore = await count('select count(*) as n from item_publications where item_id = $1', [b.itemId])
    const receipt = await mustPin(b.itemId)
    expect(receipt).toMatchObject({ itemId: b.itemId, title: `${tag} B`, pinned: true })

    expect(await titles(ANONYMOUS, tag)).toEqual(['B', 'C', 'A'])
    expect(await titles(ANONYMOUS, tag, { order: 'oldest' })).toEqual(['A', 'B', 'C'])
    const cards = await publicQuery.list(ANONYMOUS, 'news', { q: tag })
    expect(cards.map((c) => c.pinnedAt !== null)).toEqual([true, false, false])
    const row = await itemRow(b.itemId)
    expect(row.pinned_at).toBeInstanceOf(Date)
    expect(row.revision).toBe(b.revision)
    expect(await count('select count(*) as n from item_versions where item_id = $1', [b.itemId])).toBe(versionsBefore)
    expect(await count('select count(*) as n from item_publications where item_id = $1', [b.itemId])).toBe(publicationsBefore)
    expect(await count(`select count(*) as n from audit_events where target_id = $1 and action = 'item.pin'`, [b.itemId])).toBe(1)
    // 後台工作台也看得到置頂。
    expect((await query.list(cohortId)).find((r) => r.id === b.itemId)!.pinnedAt).toEqual(row.pinned_at)

    // 分類篩選時置頂的仍在該分類結果最前（AC-V03）。
    await owner.sql(`update managed_items set category = '活動' where title like $1`, [`${tag} %`])
    expect(await titles(ANONYMOUS, tag, { category: '活動' })).toEqual(['B', 'C', 'A'])
  })

  it('同一個請求編號重送拿回原回執；已經置頂再按一次回 ok、置頂時間不變、不再寫稽核；取消置頂回到日期序', async () => {
    const { cohortId } = await newCohort()
    const tag = randomUUID().slice(0, 8)
    const a = await news(cohortId, `${tag} A`, '2026-09-01T00:00:00Z')
    await news(cohortId, `${tag} B`, '2026-09-10T00:00:00Z')
    const requestId = randomUUID()
    const first = await items.setPinned(adminActor(), a.itemId, true, requestId)
    const replay = await items.setPinned(adminActor(), a.itemId, true, requestId)
    expect(first.ok && replay.ok && replay.receipt).toEqual(first.ok && first.receipt)
    const pinnedAt = (await itemRow(a.itemId)).pinned_at

    const again = await items.setPinned(adminActor(), a.itemId, true, randomUUID())
    expect(again.ok && again.receipt.pinned).toBe(true)
    expect((await itemRow(a.itemId)).pinned_at).toEqual(pinnedAt)
    expect(await count(`select count(*) as n from audit_events where target_id = $1 and action = 'item.pin'`, [a.itemId])).toBe(1)

    expect(await mustPin(a.itemId, false)).toMatchObject({ pinned: false })
    expect((await itemRow(a.itemId)).pinned_at).toBeNull()
    expect(await titles(ANONYMOUS, tag)).toEqual(['B', 'A'])
    expect(await count(`select count(*) as n from audit_events where target_id = $1 and action = 'item.unpin'`, [a.itemId])).toBe(1)
    // 已經沒置頂再取消一次：ok、不寫稽核。
    expect(await mustPin(a.itemId, false)).toMatchObject({ pinned: false })
    expect(await count(`select count(*) as n from audit_events where target_id = $1 and action = 'item.unpin'`, [a.itemId])).toBe(1)
  })

  it('多則置頂不設上限、後置頂的在前，都排在未置頂之前（D9；AC-V07）', async () => {
    const { cohortId } = await newCohort()
    const tag = randomUUID().slice(0, 8)
    const a = await news(cohortId, `${tag} A`, '2026-09-01T00:00:00Z')
    const b = await news(cohortId, `${tag} B`, '2026-09-02T00:00:00Z')
    const c = await news(cohortId, `${tag} C`, '2026-09-03T00:00:00Z')
    await news(cohortId, `${tag} D`, '2026-09-30T00:00:00Z')
    for (const item of [a, b, c]) {
      await mustPin(item.itemId)
      // 置頂時間用真實時間；隔一下確保先後分得出來。
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(await titles(ANONYMOUS, tag)).toEqual(['C', 'B', 'A', 'D'])
  })

  it('撤回、下架同一筆清掉置頂；重新發布不恢復（AC-V08）', async () => {
    const { cohortId } = await newCohort()
    const tag = randomUUID().slice(0, 8)
    const a = await news(cohortId, `${tag} A`, '2026-09-01T00:00:00Z')
    const b = await news(cohortId, `${tag} B`, '2026-09-10T00:00:00Z')
    await mustPin(a.itemId)
    await mustPin(b.itemId)

    const archived = await items.changeStatus(adminActor(), a.itemId, a.revision, 'archive', randomUUID())
    expect(archived.ok).toBe(true)
    expect((await itemRow(a.itemId)).pinned_at).toBeNull()
    expect(await titles(ANONYMOUS, tag)).toEqual(['B'])
    const republished = await items.changeStatus(adminActor(), a.itemId, a.revision + 1, 'republish', randomUUID())
    expect(republished.ok).toBe(true)
    expect((await itemRow(a.itemId)).pinned_at).toBeNull()
    const cards = await publicQuery.list(ANONYMOUS, 'news', { q: tag })
    expect(cards.map((card) => [card.title.replace(`${tag} `, ''), card.pinnedAt !== null])).toEqual([
      ['B', true],
      ['A', false],
    ])

    const withdrawn = await items.changeStatus(adminActor(), b.itemId, b.revision, 'withdraw', randomUUID())
    expect(withdrawn.ok).toBe(true)
    expect((await itemRow(b.itemId)).pinned_at).toBeNull()
  })

  it('草稿、已下架、榮譽擋下並回給系辦看的句子，資料不變；學生 FORBIDDEN；找不到的 ID（AC-V02）', async () => {
    const { cohortId } = await newCohort()
    const tag = randomUUID().slice(0, 8)
    const draft = await mustCreate(cohortId, {
      placement: 'news',
      title: `${tag} 草稿`,
      audienceKind: 'public',
      receiverUnit: 'none',
      dueAt: '',
      fields: [],
    })
    const refusedDraft = await items.setPinned(adminActor(), draft.itemId, true, randomUUID())
    expect(refusedDraft.ok ? null : [refusedDraft.code, refusedDraft.message]).toEqual([
      'VALIDATION_FAILED',
      '只有發布中的公告可以置頂，請先發布。',
    ])

    // 榮譽不從編輯器建（示範資料與匯入直接寫）：先發布成公告，再把位置改成榮譽。
    const honor = await news(cohortId, `${tag} 榮譽`, '2026-09-01T00:00:00Z')
    await owner.sql(`update managed_items set placement = 'honor' where id = $1`, [honor.itemId])
    const refusedHonor = await items.setPinned(adminActor(), honor.itemId, true, randomUUID())
    expect(refusedHonor.ok ? null : refusedHonor.message).toBe('只有公告可以置頂。')

    const student = await newStudent(cohortId)
    const published = await news(cohortId, `${tag} 公告`, '2026-09-02T00:00:00Z')
    const byStudent = await items.setPinned(studentActor(student), published.itemId, true, randomUUID())
    expect(byStudent.ok || byStudent.code).toBe('FORBIDDEN')
    const missing = await items.setPinned(adminActor(), randomUUID(), true, randomUUID())
    expect(missing.ok || missing.code).toBe('VALIDATION_FAILED')

    for (const itemId of [draft.itemId, honor.itemId, published.itemId]) expect((await itemRow(itemId)).pinned_at).toBeNull()
    expect(
      await count(`select count(*) as n from audit_events where target_id = any($1::uuid[]) and action = 'item.pin'`, [
        [draft.itemId, honor.itemId, published.itemId],
      ]),
    ).toBe(0)
    // DB 也擋：不是公告的列寫不進置頂時間。
    await expect(owner.sql('update managed_items set pinned_at = now() where id = $1', [honor.itemId])).rejects.toThrow(
      /managed_items_pinned_news_check/,
    )
  })

  it('編輯器開著的舊 revision 在置頂之後照樣存得進去，置頂保留（AC-V09）', async () => {
    const { cohortId } = await newCohort()
    const tag = randomUUID().slice(0, 8)
    const a = await news(cohortId, `${tag} A`, '2026-09-01T00:00:00Z')
    await mustPin(a.itemId)
    const updated = await items.updatePublished(
      adminActor(),
      a.itemId,
      a.revision,
      input(cohortId, {
        placement: 'news',
        title: `${tag} A`,
        summary: '改過的摘要',
        audienceKind: 'public',
        receiverUnit: 'none',
        dueAt: '',
        fields: [],
      }),
      { notify: false },
      randomUUID(),
    )
    expect(updated.ok || `${updated.code} ${updated.message}`).toBe(true)
    const row = await itemRow(a.itemId)
    expect([row.summary, row.pinned_at instanceof Date]).toEqual(['改過的摘要', true])
  })

  it('本屆學生的置頂公告：訪客看不到，同屆學生的公告列表第一則就是它（AC-V10）', async () => {
    const { cohortId } = await newCohort()
    const tag = randomUUID().slice(0, 8)
    const student = await newStudent(cohortId)
    const s = await news(cohortId, `${tag} 本屆`, '2026-09-01T00:00:00Z', { audienceKind: 'cohort_students' })
    await news(cohortId, `${tag} 公開`, '2026-09-10T00:00:00Z')
    await mustPin(s.itemId)
    expect(await titles(ANONYMOUS, tag)).toEqual(['公開'])
    expect(await titles(studentActor(student), tag)).toEqual(['本屆', '公開'])
  })
})

describe('規則章節上下移（A-14；Q198，AC-A-38、39、50）', () => {
  const ANONYMOUS: ResolvedActor = { kind: 'anonymous' }
  const RULE: Partial<ItemInput> = { placement: 'rules', audienceKind: 'public', receiverUnit: 'none', dueAt: '', fields: [] }

  /** 建一章規則（預設發布），第一次發布時間改成測試要的樣子。 */
  async function rule(cohortId: string, title: string, openedAt: string, publish = true) {
    const item = await mustCreate(cohortId, { ...RULE, title })
    if (!publish) return { itemId: item.itemId, revision: item.revision }
    const published = await mustPublish(item.itemId, 1, false)
    await owner.sql('update managed_items set actual_opened_at = $2 where id = $1', [item.itemId, openedAt])
    return { itemId: item.itemId, revision: published.revision }
  }

  async function mustMove(itemId: string, direction: 'up' | 'down') {
    const result = await items.moveRule(adminActor(), itemId, direction, randomUUID())
    if (!result.ok) throw new Error(`${result.code} ${result.message}`)
    return result.receipt
  }

  /** 系辦「規則」篩選看到的順序（同頁面：位置排；這裡的資料都有位置）。 */
  const adminOrder = async (cohortId: string, tag: string) =>
    (await query.list(cohortId))
      .filter((r) => r.placement === 'rules')
      .sort((a, b) => a.rulesPosition! - b.rulesPosition!)
      .map((r) => r.title.replace(`${tag} `, ''))
  /** 前台 `/rules`（`fullText`）與列表看到的順序；測試庫有別的測試的規則，用標籤濾。 */
  const publicOrder = async (tag: string) => {
    const full = (await publicQuery.fullText(ANONYMOUS, 'rules')).filter((c) => c.title.startsWith(`${tag} `))
    const listed = await publicQuery.list(ANONYMOUS, 'rules', { q: tag, order: 'newest' })
    expect(listed.map((c) => c.title)).toEqual(full.map((c) => c.title))
    return full.map((c) => c.title.replace(`${tag} `, ''))
  }

  it('建立規則給同屆 max+1（各屆各自編、刪除的不算）；其他位置是 null', async () => {
    const a = await newCohort()
    const b = await newCohort()
    const first = await rule(a.cohortId, '甲一', '2026-09-01T00:00:00Z', false)
    const second = await rule(a.cohortId, '甲二', '2026-09-02T00:00:00Z', false)
    const other = await rule(b.cohortId, '乙一', '2026-09-01T00:00:00Z', false)
    const news = await mustCreate(a.cohortId, { ...RULE, placement: 'news', title: '公告' })
    const positions = async (...ids: string[]) => Promise.all(ids.map(async (id) => (await itemRow(id)).rules_position))
    expect(await positions(first.itemId, second.itemId, other.itemId, news.itemId)).toEqual([1, 2, 1, null])

    const deleted = await items.delete(adminActor(), second.itemId, second.revision, randomUUID())
    expect(deleted.ok).toBe(true)
    const third = await rule(a.cohortId, '甲三', '2026-09-03T00:00:00Z', false)
    expect(await positions(third.itemId)).toEqual([2])
  })

  it('AC-A-38：四章都已發布，第 3 章下移 → 系辦與前台第 3、4 章互換；不動 revision，稽核一筆 item.rule_moved', async () => {
    const { cohortId } = await newCohort()
    const tag = randomUUID().slice(0, 8)
    const chapters = []
    for (const [n, day] of [[1, '01'], [2, '02'], [3, '03'], [4, '04']] as const) {
      chapters.push(await rule(cohortId, `${tag} 第${n}章`, `2026-09-${day}T00:00:00Z`))
    }
    expect(await adminOrder(cohortId, tag)).toEqual(['第1章', '第2章', '第3章', '第4章'])
    expect(await publicOrder(tag)).toEqual(['第1章', '第2章', '第3章', '第4章'])

    const third = chapters[2]!
    const receipt = await mustMove(third.itemId, 'down')
    expect(receipt).toMatchObject({ itemId: third.itemId, title: `${tag} 第3章`, position: 4 })
    expect(await adminOrder(cohortId, tag)).toEqual(['第1章', '第2章', '第4章', '第3章'])
    expect(await publicOrder(tag)).toEqual(['第1章', '第2章', '第4章', '第3章'])

    expect((await itemRow(third.itemId)).revision).toBe(third.revision)
    expect((await itemRow(chapters[3]!.itemId)).revision).toBe(chapters[3]!.revision)
    const audit = await owner.sql(`select payload from audit_events where target_id = $1 and action = 'item.rule_moved'`, [third.itemId])
    expect(audit.rows).toHaveLength(1)
    expect(audit.rows[0]!.payload).toMatchObject({ direction: 'down', swappedWith: chapters[3]!.itemId, positionBefore: 3, positionAfter: 4 })
  })

  it('AC-A-39：第 1 章上移、最後一章下移 → VALIDATION_FAILED，順序不變、不寫稽核；同一個請求編號重送拿回原回執', async () => {
    const { cohortId } = await newCohort()
    const tag = randomUUID().slice(0, 8)
    const one = await rule(cohortId, `${tag} 第1章`, '2026-09-01T00:00:00Z')
    const two = await rule(cohortId, `${tag} 第2章`, '2026-09-02T00:00:00Z')

    const top = await items.moveRule(adminActor(), one.itemId, 'up', randomUUID())
    expect(top.ok ? null : [top.code, top.message]).toEqual(['VALIDATION_FAILED', '已經在最上面了。'])
    const bottom = await items.moveRule(adminActor(), two.itemId, 'down', randomUUID())
    expect(bottom.ok ? null : [bottom.code, bottom.message]).toEqual(['VALIDATION_FAILED', '已經在最下面了。'])
    expect(await adminOrder(cohortId, tag)).toEqual(['第1章', '第2章'])
    expect(
      await count(`select count(*) as n from audit_events where target_id = any($1::uuid[]) and action = 'item.rule_moved'`, [
        [one.itemId, two.itemId],
      ]),
    ).toBe(0)

    const requestId = randomUUID()
    const first = await items.moveRule(adminActor(), two.itemId, 'up', requestId)
    const replay = await items.moveRule(adminActor(), two.itemId, 'up', requestId)
    expect(first.ok && replay.ok && replay.receipt).toEqual(first.ok && first.receipt)
    expect(await adminOrder(cohortId, tag)).toEqual(['第2章', '第1章'])
  })

  it('AC-A-50：第 3 章是草稿 → 前台只有 1、2、4、5；第 2 章下移兩次，系辦 1、3、2、4、5 → 1、3、4、2、5，前台 1、2、4、5 → 1、4、2、5', async () => {
    const { cohortId } = await newCohort()
    const tag = randomUUID().slice(0, 8)
    const ids: string[] = []
    for (const n of [1, 2, 3, 4, 5]) {
      ids.push((await rule(cohortId, `${tag} 第${n}章`, `2026-09-0${n}T00:00:00Z`, n !== 3)).itemId)
    }
    expect(await adminOrder(cohortId, tag)).toEqual(['第1章', '第2章', '第3章', '第4章', '第5章'])
    expect(await publicOrder(tag)).toEqual(['第1章', '第2章', '第4章', '第5章'])

    await mustMove(ids[1]!, 'down')
    expect(await adminOrder(cohortId, tag)).toEqual(['第1章', '第3章', '第2章', '第4章', '第5章'])
    expect(await publicOrder(tag)).toEqual(['第1章', '第2章', '第4章', '第5章'])

    await mustMove(ids[1]!, 'down')
    expect(await adminOrder(cohortId, tag)).toEqual(['第1章', '第3章', '第4章', '第2章', '第5章'])
    expect(await publicOrder(tag)).toEqual(['第1章', '第4章', '第2章', '第5章'])
  })

  it('前台列出多個屆別的規則時按屆別分段（先發布的屆別在前），屆內照位置；不會兩屆交錯', async () => {
    const early = await newCohort()
    const late = await newCohort()
    const tag = randomUUID().slice(0, 8)
    // 舊排法（實際開放時間）：甲1、甲2、乙1、乙2。遷移後沒人動過要一樣。
    const a1 = await rule(early.cohortId, `${tag} 甲1`, '2025-09-01T00:00:00Z')
    const a2 = await rule(early.cohortId, `${tag} 甲2`, '2025-09-02T00:00:00Z')
    await rule(late.cohortId, `${tag} 乙1`, '2026-09-01T00:00:00Z')
    const b2 = await rule(late.cohortId, `${tag} 乙2`, '2026-09-02T00:00:00Z')
    expect(await publicOrder(tag)).toEqual(['甲1', '甲2', '乙1', '乙2'])

    await mustMove(a2.itemId, 'up')
    await mustMove(b2.itemId, 'up')
    expect(await publicOrder(tag)).toEqual(['甲2', '甲1', '乙2', '乙1'])
    expect((await itemRow(a1.itemId)).rules_position).toBe(2)
  })

  it('位置有 NULL 或同號（舊資料、同時建立）→ 照移完的順序整屆重編 1..n', async () => {
    const { cohortId } = await newCohort()
    const tag = randomUUID().slice(0, 8)
    const a = await rule(cohortId, `${tag} A`, '2026-09-01T00:00:00Z')
    const b = await rule(cohortId, `${tag} B`, '2026-09-02T00:00:00Z')
    const c = await rule(cohortId, `${tag} C`, '2026-09-03T00:00:00Z')
    // A、B 同號；C 沒有位置（排最後）。
    await owner.sql('update managed_items set rules_position = 5 where id = any($1::uuid[])', [[a.itemId, b.itemId]])
    await owner.sql('update managed_items set rules_position = null where id = $1', [c.itemId])
    expect(await publicOrder(tag)).toEqual(['A', 'B', 'C'])

    expect(await mustMove(b.itemId, 'up')).toMatchObject({ position: 1 })
    const positions = await Promise.all([a, b, c].map(async (x) => (await itemRow(x.itemId)).rules_position))
    expect(positions).toEqual([2, 1, 3])
    expect(await publicOrder(tag)).toEqual(['B', 'A', 'C'])
  })

  it('存草稿換成規則 → 排到同屆最後；換離規則 → 位置清掉', async () => {
    const { cohortId } = await newCohort()
    const one = await rule(cohortId, '第1章', '2026-09-01T00:00:00Z', false)
    const news = await mustCreate(cohortId, { ...RULE, placement: 'news', title: '原本是公告' })
    const saved = await items.saveDraft(adminActor(), news.itemId, news.revision, input(cohortId, { ...RULE, title: '改成規則' }), randomUUID())
    expect(saved.ok || `${saved.code} ${saved.message}`).toBe(true)
    expect((await itemRow(news.itemId)).rules_position).toBe(2)

    const back = await items.saveDraft(
      adminActor(),
      one.itemId,
      one.revision,
      input(cohortId, { ...RULE, placement: 'news', title: '改成公告' }),
      randomUUID(),
    )
    expect(back.ok || `${back.code} ${back.message}`).toBe(true)
    expect((await itemRow(one.itemId)).rules_position).toBeNull()
    // 換出去的那一章留下的缺號同一筆交易補掉。
    expect((await itemRow(news.itemId)).rules_position).toBe(1)
  })

  it('AC-A-40：前台跨屆槽位照遷移前（時間、id）——甲1、乙1、甲2 沒人動過時不變；移動只在該屆自己的槽位裡換', async () => {
    const a = await newCohort()
    const b = await newCohort()
    const tag = randomUUID().slice(0, 8)
    const a1 = await rule(a.cohortId, `${tag} 甲1`, '2026-09-01T00:00:00Z')
    await rule(b.cohortId, `${tag} 乙1`, '2026-09-02T00:00:00Z')
    const a2 = await rule(a.cohortId, `${tag} 甲2`, '2026-09-03T00:00:00Z')
    expect(await publicOrder(tag)).toEqual(['甲1', '乙1', '甲2'])

    await mustMove(a2.itemId, 'up')
    expect(await publicOrder(tag)).toEqual(['甲2', '乙1', '甲1'])
    await mustMove(a1.itemId, 'up')
    expect(await publicOrder(tag)).toEqual(['甲1', '乙1', '甲2'])
  })

  it('Review 反例：位置重複（A=1、B=2、C=2）時 A 下移只跨一章 → B、A、C，之後整屆是 1..n', async () => {
    const { cohortId } = await newCohort()
    const tag = randomUUID().slice(0, 8)
    const a = await rule(cohortId, `${tag} A`, '2026-09-05T00:00:00Z')
    const b = await rule(cohortId, `${tag} B`, '2026-09-02T00:00:00Z')
    const c = await rule(cohortId, `${tag} C`, '2026-09-03T00:00:00Z')
    await owner.sql('update managed_items set rules_position = $2 where id = $1', [a.itemId, 1])
    await owner.sql('update managed_items set rules_position = 2 where id = any($1::uuid[])', [[b.itemId, c.itemId]])
    // 同號時依實際開放時間：A、B、C。
    expect(await publicOrder(tag)).toEqual(['A', 'B', 'C'])

    expect(await mustMove(a.itemId, 'down')).toMatchObject({ position: 2 })
    const positions = await Promise.all([a, b, c].map(async (x) => (await itemRow(x.itemId)).rules_position))
    expect(positions).toEqual([2, 1, 3])
    expect(await publicOrder(tag)).toEqual(['B', 'A', 'C'])
  })

  it('Review 反例：刪掉中間一章 → 同一筆交易補成連號；之後移動回報的就是實際章次', async () => {
    const { cohortId } = await newCohort()
    const tag = randomUUID().slice(0, 8)
    const chapters: { itemId: string; revision: number }[] = []
    for (const n of [1, 2, 3, 4]) chapters.push(await rule(cohortId, `${tag} 第${n}章`, `2026-09-0${n}T00:00:00Z`, false))
    const deleted = await items.delete(adminActor(), chapters[1]!.itemId, chapters[1]!.revision, randomUUID())
    expect(deleted.ok).toBe(true)
    const positions = async () => Promise.all(chapters.map(async (x) => (await itemRow(x.itemId)).rules_position))
    expect(await positions()).toEqual([1, null, 2, 3])

    expect(await mustMove(chapters[3]!.itemId, 'up')).toMatchObject({ position: 2 })
    expect(await positions()).toEqual([1, null, 3, 2])
  })

  /** 等條件成立（最多 `ms`）；拿來當並行測試的屏障，逾時不丟錯，讓斷言去判。 */
  async function waitFor(condition: () => Promise<boolean> | boolean, ms = 3000) {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (await condition()) return
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }

  /** 卡在屏障（`barrierPid`）上、或卡在「卡在屏障上的交易」上的連線數。 */
  async function blockedBehind(barrierPid: number): Promise<number> {
    const rows = await owner.sql(
      `select count(*) as n from pg_stat_activity a
        where $1 = any(pg_blocking_pids(a.pid))
           or exists (select 1 from unnest(pg_blocking_pids(a.pid)) b where $1 = any(pg_blocking_pids(b)))`,
      [barrierPid],
    )
    return Number(rows.rows[0]!.n)
  }

  function settled<T>(promise: Promise<T>): () => boolean {
    let done = false
    void promise.finally(() => {
      done = true
    })
    return () => done
  }

  it('Review 反例：並行把兩筆公告草稿改成規則，不會拿到同一個位置', async () => {
    const { cohortId } = await newCohort()
    await rule(cohortId, '第1章', '2026-09-01T00:00:00Z', false)
    const x = await mustCreate(cohortId, { ...RULE, placement: 'news', title: '公告 X' })
    const y = await mustCreate(cohortId, { ...RULE, placement: 'news', title: '公告 Y' })

    // 屏障：擋住稽核寫入，兩筆存草稿都會停在「位置算好、還沒 commit」。
    const barrier = await owner.pool.connect()
    try {
      await barrier.query('begin')
      await barrier.query('lock table audit_events in share mode')
      const pid = (await barrier.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
      const save = (item: typeof x, title: string) =>
        items.saveDraft(adminActor(), item.itemId, item.revision, input(cohortId, { ...RULE, title }), randomUUID())
      const both = [save(x, '第X章'), save(y, '第Y章')]
      await waitFor(async () => (await blockedBehind(pid)) >= 2)
      await barrier.query('commit')
      const results = await Promise.all(both)
      expect(results.map((r) => r.ok || `${r.code} ${r.message}`)).toEqual([true, true])
    } finally {
      barrier.release()
    }
    const positions = await owner.sql(
      `select rules_position from managed_items where cohort_id = $1 and placement = 'rules' and deleted_at is null order by rules_position`,
      [cohortId],
    )
    expect(positions.rows.map((r) => r.rules_position)).toEqual([1, 2, 3])
  })

  it('Review 反例：移動卡在編輯中的章節時，另一筆公告改成規則再移動，不會互鎖（不回 INTERNAL）', async () => {
    const { cohortId } = await newCohort()
    // id 依建立先後：N < R < S。位置 S=1、R=2；N 之後才改成規則（排最後）。
    const n = await mustCreate(cohortId, { ...RULE, placement: 'news', title: 'N' })
    const r = await rule(cohortId, 'R', '2026-09-01T00:00:00Z')
    const sItem = await rule(cohortId, 'S', '2026-09-02T00:00:00Z')
    await owner.sql('update managed_items set rules_position = 1 where id = $1', [sItem.itemId])
    await owner.sql('update managed_items set rules_position = 2 where id = $1', [r.itemId])

    // 屏障：模擬「S 正在被編輯」——另一筆交易握著 S 的列鎖。
    const barrier = await owner.pool.connect()
    let results: { ok: boolean; code?: string; message?: string }[] = []
    try {
      await barrier.query('begin')
      await barrier.query('select 1 from managed_items where id = $1 for update', [sItem.itemId])
      const pid = (await barrier.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid

      const m1 = items.moveRule(adminActor(), r.itemId, 'down', randomUUID())
      const m1Done = settled(m1)
      await waitFor(async () => m1Done() || (await blockedBehind(pid)) >= 1)
      const convert = items.saveDraft(adminActor(), n.itemId, n.revision, input(cohortId, { ...RULE, title: 'N' }), randomUUID())
      const convertDone = settled(convert)
      await waitFor(async () => convertDone() || (await blockedBehind(pid)) >= 2)
      const m2 = items.moveRule(adminActor(), n.itemId, 'up', randomUUID())
      const m2Done = settled(m2)
      await waitFor(async () => m2Done() || (await blockedBehind(pid)) >= (convertDone() ? 2 : 3), 1000)
      await barrier.query('commit')
      results = (await Promise.all([m1, convert, m2])).map((x) => (x.ok ? { ok: true } : { ok: false, code: x.code, message: x.message }))
    } finally {
      barrier.release()
    }
    expect(results.filter((x) => x.code === 'INTERNAL' || x.code === 'CONFLICT')).toEqual([])
    expect(results[1]).toEqual({ ok: true })
    const positions = await owner.sql(
      `select rules_position from managed_items where cohort_id = $1 and placement = 'rules' and deleted_at is null order by rules_position`,
      [cohortId],
    )
    expect(positions.rows.map((x) => x.rules_position)).toEqual([1, 2, 3])
  })

  it('Review 反例反向：公告 N 正在被編輯（握著列鎖）時，把 N 改成規則、再對 S、R 上下移 → 三筆都排在編輯之後完成，不互鎖', async () => {
    const { cohortId } = await newCohort()
    const n = await mustCreate(cohortId, { ...RULE, placement: 'news', title: 'N' })
    const r = await rule(cohortId, 'R', '2026-09-01T00:00:00Z')
    const sItem = await rule(cohortId, 'S', '2026-09-02T00:00:00Z')

    // 屏障：模擬「N 正在被編輯」——另一筆交易握著 N 的列鎖。改成規則的交易會握著規則鎖等 N；兩個移動排在規則鎖後面。
    const barrier = await owner.pool.connect()
    let results: { ok: boolean; code?: string; message?: string }[] = []
    try {
      await barrier.query('begin')
      await barrier.query('select 1 from managed_items where id = $1 for update', [n.itemId])
      const pid = (await barrier.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid

      const convert = items.saveDraft(adminActor(), n.itemId, n.revision, input(cohortId, { ...RULE, title: 'N' }), randomUUID())
      const convertDone = settled(convert)
      await waitFor(async () => convertDone() || (await blockedBehind(pid)) >= 1)
      const m1 = items.moveRule(adminActor(), sItem.itemId, 'up', randomUUID())
      const m1Done = settled(m1)
      await waitFor(async () => m1Done() || (await blockedBehind(pid)) >= 2)
      const m2 = items.moveRule(adminActor(), r.itemId, 'down', randomUUID())
      const m2Done = settled(m2)
      await waitFor(async () => m2Done() || (await blockedBehind(pid)) >= 3, 1000)
      await barrier.query('commit')
      results = (await Promise.all([convert, m1, m2])).map((x) => (x.ok ? { ok: true } : { ok: false, code: x.code, message: x.message }))
    } finally {
      barrier.release()
    }
    expect(results.filter((x) => x.code === 'INTERNAL' || x.code === 'CONFLICT')).toEqual([])
    expect(results[0]).toEqual({ ok: true })
    const positions = await owner.sql(
      `select rules_position from managed_items where cohort_id = $1 and placement = 'rules' and deleted_at is null order by rules_position`,
      [cohortId],
    )
    expect(positions.rows.map((x) => x.rules_position)).toEqual([1, 2, 3])
  })

  /** 這一列此刻是不是被別的交易鎖著（`FOR UPDATE NOWAIT` 撞 55P03 就是）。 */
  async function rowLocked(itemId: string): Promise<boolean> {
    const probe = await owner.pool.connect()
    try {
      await probe.query('begin')
      try {
        await probe.query('select 1 from managed_items where id = $1 for update nowait', [itemId])
        return false
      } catch (error) {
        if ((error as { code?: string }).code === '55P03') return true
        throw error
      } finally {
        await probe.query('rollback')
      }
    } finally {
      probe.release()
    }
  }

  /** r2 反例的資料：草稿規則 A、已發布規則 B、C，和一份兩邊都要附上的檔案 F。 */
  async function r2Fixture() {
    const { cohortId } = await newCohort()
    const a = await rule(cohortId, 'r2 A', '2026-09-01T00:00:00Z', false)
    const b = await rule(cohortId, 'r2 B', '2026-09-02T00:00:00Z')
    const c = await rule(cohortId, 'r2 C', '2026-09-03T00:00:00Z')
    const fileId = await uploadPdf(adminId, cohortId)
    const toNews = () =>
      items.saveDraft(adminActor(), a.itemId, a.revision, input(cohortId, { ...RULE, placement: 'news', title: 'r2 A', attachmentFileIds: [fileId] }), randomUUID())
    const editB = () =>
      items.updatePublished(adminActor(), b.itemId, b.revision, input(cohortId, { ...RULE, title: 'r2 B', attachmentFileIds: [fileId] }), { notify: false }, randomUUID())
    const verify = async (results: { ok: boolean; code?: string; message?: string }[]) => {
      expect(results).toEqual([{ ok: true }, { ok: true }])
      const positions = await Promise.all([a, b, c].map(async (x) => (await itemRow(x.itemId)).rules_position))
      expect(positions).toEqual([null, 1, 2])
      const attached = await owner.sql('select item_id from item_attachments where file_id = $1', [fileId])
      expect(attached.rows.map((row) => String(row.item_id)).sort()).toEqual([a.itemId, b.itemId].sort())
    }
    return { a, b, c, fileId, toNews, editB, verify }
  }

  const outcome = (x: { ok: boolean; code?: string; message?: string }) => (x.ok ? { ok: true } : { ok: false, code: x.code, message: x.message })

  it('Review r2 反例：草稿規則 A 換成公告並附上 F，同屆已發布規則 B 同時附上 F（A 先鎖到檔案）→ 兩筆都成功、不互鎖；A 握著檔案列時整屆規則列已先鎖好', async () => {
    const { b, c, toNews, editB, verify } = await r2Fixture()
    // 屏障：擋住 item_attachments 的寫入——A 的存草稿會停在「檔案列 F 已鎖、附件表還沒改」，正是 Review 反例的交錯點。
    const barrier = await owner.pool.connect()
    let results: { ok: boolean; code?: string; message?: string }[] = []
    let siblingsLocked: boolean[] = []
    try {
      await barrier.query('begin')
      await barrier.query('lock table item_attachments in share mode')
      const pid = (await barrier.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid

      const first = toNews()
      const firstDone = settled(first)
      await waitFor(async () => firstDone() || (await blockedBehind(pid)) >= 1)
      // A 握著檔案列的這一刻，同屆其他規則列（B、C）必須已經被 A 鎖住：項目列一律在檔案列之前（鎖序第 3、4 步）。
      siblingsLocked = await Promise.all([rowLocked(b.itemId), rowLocked(c.itemId)])
      const second = editB()
      const secondDone = settled(second)
      await waitFor(async () => secondDone() || (await blockedBehind(pid)) >= 2)
      await barrier.query('commit')
      results = (await Promise.all([first, second])).map(outcome)
    } finally {
      barrier.release()
    }
    expect(siblingsLocked).toEqual([true, true])
    await verify(results)
  })

  it('Review r2 反例反向：已發布規則 B 先附上 F（握著自己那一列與檔案列），草稿規則 A 再換成公告並附上 F → A 排在 B 後面完成，不互鎖', async () => {
    const { toNews, editB, verify } = await r2Fixture()
    const barrier = await owner.pool.connect()
    let results: { ok: boolean; code?: string; message?: string }[] = []
    try {
      await barrier.query('begin')
      await barrier.query('lock table item_attachments in share mode')
      const pid = (await barrier.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid

      const first = editB()
      const firstDone = settled(first)
      await waitFor(async () => firstDone() || (await blockedBehind(pid)) >= 1)
      const second = toNews()
      const secondDone = settled(second)
      await waitFor(async () => secondDone() || (await blockedBehind(pid)) >= 2)
      await barrier.query('commit')
      results = (await Promise.all([second, first])).map(outcome)
    } finally {
      barrier.release()
    }
    await verify(results)
  })

  /** 屏障：握住這一屆的規則集合 advisory lock（鎖序第 1 步），會換集合的交易都停在拿任何列鎖之前；回 pid 給 `blockedBehind`。 */
  async function holdRuleSet(barrier: PoolClient, cohortId: string): Promise<number> {
    await barrier.query('begin')
    await barrier.query(`select pg_advisory_xact_lock(hashtextextended('items.rules:' || $1::uuid::text, 0))`, [cohortId])
    return (await barrier.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
  }

  /** 放行屏障後等兩筆都收完；斷言失敗時也要收，不留握著鎖的連線與懸著的交易。 */
  async function releaseRuleSet(barrier: PoolClient, pending: readonly Promise<unknown>[]) {
    await barrier.query('rollback').catch(() => undefined)
    barrier.release()
    await Promise.allSettled(pending)
  }

  for (const [from, to] of [
    ['rules', 'news'],
    ['news', 'rules'],
  ] as const) {
    it(`Review r3 反例：同一個請求編號並行送兩次「${from} → ${to}」存草稿（都先讀到舊位置、排在規則鎖後面）→ 兩筆都回同一份回執，只寫一次`, async () => {
      const { cohortId } = await newCohort()
      const draft = await mustCreate(cohortId, { ...RULE, placement: from, title: 'r3 重送' })
      const next = input(cohortId, { ...RULE, placement: to, title: 'r3 重送' })
      const requestId = randomUUID()
      const barrier = await owner.pool.connect()
      let twice: ReturnType<typeof items.saveDraft>[] = []
      let results: Awaited<ReturnType<typeof items.saveDraft>>[] = []
      try {
        const pid = await holdRuleSet(barrier, cohortId)
        // 兩筆都在屏障放行前送出：不加鎖讀到的都是舊位置，然後一起卡在規則鎖上；放行後規則鎖一次只給一筆，
        // 第二筆鎖到時第一筆已經 commit、位置已換——這就是 Review 第 3 輪的交錯。
        twice = [
          items.saveDraft(adminActor(), draft.itemId, draft.revision, next, requestId),
          items.saveDraft(adminActor(), draft.itemId, draft.revision, next, requestId),
        ]
        await waitFor(async () => (await blockedBehind(pid)) >= 2)
        expect(await blockedBehind(pid)).toBe(2)
        await barrier.query('commit')
        results = await Promise.all(twice)
      } finally {
        await releaseRuleSet(barrier, twice)
      }
      expect(results.map(outcome)).toEqual([{ ok: true }, { ok: true }])
      expect(results[1]).toEqual(results[0])
      const row = await itemRow(draft.itemId)
      expect([row.placement, Number(row.revision)]).toEqual([to, 2])
      expect(await count('select count(*) as n from operation_records where request_id = $1', [requestId])).toBe(1)
      expect(await count(`select count(*) as n from audit_events where target_id = $1 and action = 'item.save_draft'`, [draft.itemId])).toBe(1)
    })
  }

  it('Review r3 同型：同一個請求編號並行刪同一章草稿規則兩次（排在規則鎖後面）→ 兩筆都回同一份回執，只刪一次、其餘補成連號', async () => {
    const { cohortId } = await newCohort()
    const one = await rule(cohortId, '第1章', '2026-09-01T00:00:00Z')
    const gone = await rule(cohortId, '第2章', '2026-09-02T00:00:00Z', false)
    const three = await rule(cohortId, '第3章', '2026-09-03T00:00:00Z')
    const requestId = randomUUID()
    const barrier = await owner.pool.connect()
    let twice: ReturnType<typeof items.delete>[] = []
    let results: Awaited<ReturnType<typeof items.delete>>[] = []
    try {
      const pid = await holdRuleSet(barrier, cohortId)
      twice = [
        items.delete(adminActor(), gone.itemId, gone.revision, requestId),
        items.delete(adminActor(), gone.itemId, gone.revision, requestId),
      ]
      await waitFor(async () => (await blockedBehind(pid)) >= 2)
      expect(await blockedBehind(pid)).toBe(2)
      await barrier.query('commit')
      results = await Promise.all(twice)
    } finally {
      await releaseRuleSet(barrier, twice)
    }
    expect(results.map(outcome)).toEqual([{ ok: true }, { ok: true }])
    expect(results[1]).toEqual(results[0])
    expect((await itemRow(gone.itemId)).deleted_at).not.toBeNull()
    const positions = await Promise.all([one, three].map(async (x) => (await itemRow(x.itemId)).rules_position))
    expect(positions).toEqual([1, 2])
    expect(await count('select count(*) as n from operation_records where request_id = $1', [requestId])).toBe(1)
    expect(await count(`select count(*) as n from audit_events where target_id = $1 and action = 'item.deleted'`, [gone.itemId])).toBe(1)
  })

  it('Review r2 反例：同屆 201 章、第 201 章上移到第 200 位 → 前台整本目錄照位置列出全部 201 章；取 200 筆也是排完才截，第 200 位的那一章在、被擠到第 201 位的不在', async () => {
    // 用自己的隔離資料庫：共用庫裡別的案例建的規則會占掉槽位，看不出截取的邊界。
    const own = await createIsolatedDatabase({ label: 'rules201', setup: migratedSchema })
    const ownApp = await poolAsRole(own, 'fju_app')
    try {
      const admin = await own.sql(
        `insert into users (id, name, email, email_verified, updated_at, status)
         values (gen_random_uuid(), 'A', 'a-rules201@example.com', true, now(), 'active') returning id`,
      )
      const cohort = await own.sql(
        `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
         values (gen_random_uuid(), 'R201', 'R201', 'active', '2027-06-30', 'system') returning id`,
      )
      const cohortId = String(cohort.rows[0]!.id)
      const actor = adminActor(String(admin.rows[0]!.id))
      const ownItems = new PgItemCommand({
        audit: new PgAuditWriter(),
        ledger: new PgOperationLedger(() => ownApp),
        events: new PgEventPublisher(),
        dueWork: new PgDueWorkScheduler({ testKindsEnabled: false }),
        files: storage,
        responses: new PgResponsePresence(),
        businessClock,
        pool: () => ownApp,
      })
      const ownPublic = new PgPublicItemQuery(businessClock, () => ownApp)

      const chapters: string[] = []
      for (let no = 1; no <= 201; no += 1) {
        const created = await ownItems.create(actor, input(cohortId, { ...RULE, title: `第${no}章` }), randomUUID())
        if (!created.ok) throw new Error(`${created.code} ${created.message}`)
        const published = await ownItems.publish(actor, created.receipt.itemId, 1, { notify: false }, randomUUID())
        if (!published.ok) throw new Error(`${published.code} ${published.message}`)
        chapters.push(created.receipt.itemId)
      }
      // 發布時間依章次遞增（遷移前的時間序），位置 1..201。
      await own.sql(
        `update managed_items set actual_opened_at = timestamptz '2026-09-01T00:00:00Z' + rules_position * interval '1 minute'
          where cohort_id = $1`,
        [cohortId],
      )
      const moved = await ownItems.moveRule(actor, chapters[200]!, 'up', randomUUID())
      expect(moved.ok && moved.receipt.position).toBe(200)

      const expected = [...Array.from({ length: 199 }, (_, i) => `第${i + 1}章`), '第201章', '第200章']
      const full = await ownPublic.fullText(ANONYMOUS, 'rules')
      expect(full.map((c) => c.title)).toEqual(expected)
      const capped = await ownPublic.list(ANONYMOUS, 'rules', { limit: 200 })
      expect(capped.map((c) => c.title)).toEqual(expected.slice(0, 200))
      expect(capped.at(-1)?.title).toBe('第201章')
    } finally {
      await ownApp.end()
      await own.close()
    }
  })

  it('不是規則、學生、找不到、封存屆別都擋下，順序不變', async () => {
    const { cohortId } = await newCohort()
    const one = await rule(cohortId, '第1章', '2026-09-01T00:00:00Z')
    const two = await rule(cohortId, '第2章', '2026-09-02T00:00:00Z')
    const news = await mustCreate(cohortId, { ...RULE, placement: 'news', title: '公告' })

    const notRule = await items.moveRule(adminActor(), news.itemId, 'up', randomUUID())
    expect(notRule.ok ? null : [notRule.code, notRule.message]).toEqual(['VALIDATION_FAILED', '只有專題規則能調整章節順序。'])
    const student = await newStudent(cohortId)
    const byStudent = await items.moveRule(studentActor(student), two.itemId, 'up', randomUUID())
    expect(byStudent.ok || byStudent.code).toBe('FORBIDDEN')
    const missing = await items.moveRule(adminActor(), randomUUID(), 'up', randomUUID())
    expect(missing.ok || missing.code).toBe('VALIDATION_FAILED')
    const sideways = await items.moveRule(adminActor(), two.itemId, 'left' as 'up', randomUUID())
    expect(sideways.ok || sideways.code).toBe('VALIDATION_FAILED')

    await owner.sql(`update cohorts set status = 'archived' where id = $1`, [cohortId])
    const archived = await items.moveRule(adminActor(), two.itemId, 'up', randomUUID())
    expect(archived.ok || archived.code).toBe('COHORT_ARCHIVED')
    const positions = await Promise.all([one, two].map(async (x) => (await itemRow(x.itemId)).rules_position))
    expect(positions).toEqual([1, 2])
  })
})

// ── C 階段規格① C1-02 ─────────────────────────────────────────────────────────

async function newTeacher(options: { status?: string; revoked?: boolean } = {}): Promise<string> {
  seq += 1
  const user = await owner.sql(
    `insert into users (id, name, email, email_verified, updated_at, status)
     values (gen_random_uuid(), $1, $2, true, now(), $3) returning id`,
    [`老師${seq}`, `t${seq}-items@example.com`, options.status ?? 'active'],
  )
  const id = String(user.rows[0]!.id)
  await owner.sql(
    `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at, revoked_by_user_id, revoked_real_at)
     values (gen_random_uuid(), $1, 'teacher', $2, now(), case when $3 then $2::uuid end, case when $3 then now() end)`,
    [id, adminId, options.revoked === true],
  )
  return id
}

async function assignAdvisor(groupId: string, teacherUserId: string) {
  await owner.sql(
    `insert into advisor_assignments (id, group_id, teacher_user_id, source, valid_from, assigned_by_user_id, reason)
     values (gen_random_uuid(), $1, $2, 'admin', now(), $3, '指派')`,
    [groupId, teacherUserId, adminId],
  )
}

async function showcaseDraft(cohortId: string, groupId: string) {
  const entry = await owner.sql(
    `insert into showcase_entries (id, cohort_id, group_id, created_by_user_id) values (gen_random_uuid(), $1, $2, $3) returning id`,
    [cohortId, groupId, adminId],
  )
  await owner.sql(
    `insert into showcase_drafts (entry_id, title, summary, summary_checksum) values ($1, '題目', '', encode(sha256(''::bytea), 'hex'))`,
    [entry.rows[0]!.id],
  )
}

async function expectStillDraft(itemId: string) {
  const row = await itemRow(itemId)
  expect(row.status).toBe('draft')
  expect(row.actual_opened_at).toBeNull()
  expect(await count('select count(*) as n from item_publications where item_id = $1', [itemId])).toBe(0)
  expect(await count('select count(*) as n from response_rosters where item_id = $1', [itemId])).toBe(0)
  expect(await count(`select count(*) as n from domain_events where source_id = $1`, [itemId])).toBe(0)
}

/** 記下呼叫、可以指定回錯的同意書 hook（真的建包在 C1-03）；假裝第一組（依 id 排序）沒有主指導、其他組建好。 */
function fakeConsentHook(fail?: { code: 'VALIDATION_FAILED'; message: string }) {
  const calls: { kind: string; itemId: string; groupIds: readonly string[]; purpose?: string; bodyHtml?: string }[] = []
  const meta = (requestId: string) => ({ requestId, serverTime: new Date().toISOString() })
  const hook = {
    async onPublished(_tx: PoolClient, item: { id: string; groupIds: readonly string[]; purpose: string; bodyHtml: string }, _u: string, requestId: string) {
      calls.push({ kind: 'published', itemId: item.id, groupIds: item.groupIds, purpose: item.purpose, bodyHtml: item.bodyHtml })
      if (fail) return { ok: false as const, ...fail }
      return { ok: true as const, receipt: { created: item.groupIds.length - 1, skipped: [{ groupId: item.groupIds[0]!, reason: 'no_advisor' as const }], ...meta(requestId) } }
    },
    async onContentChanged(_tx: PoolClient, item: { id: string; groupIds: readonly string[]; bodyHtml: string }, _u: string, requestId: string) {
      calls.push({ kind: 'content_changed', itemId: item.id, groupIds: item.groupIds, bodyHtml: item.bodyHtml })
      return { ok: true as const, receipt: { superseded: 0, created: 0, ...meta(requestId) } }
    },
    async createForGroup() {
      return { ok: false as const, code: 'VALIDATION_FAILED' as const, message: '不支援' }
    },
    async onGroupsRemoved(_tx: PoolClient, itemId: string, groupIds: readonly string[], _u: string, requestId: string) {
      calls.push({ kind: 'groups_removed', itemId, groupIds })
      return { ok: true as const, receipt: { voided: groupIds.length, ...meta(requestId) } }
    },
  }
  return { hook, calls }
}

function itemsWith(consent: ReturnType<typeof fakeConsentHook>['hook']): PgItemCommand {
  return new PgItemCommand({
    audit: new PgAuditWriter(),
    ledger: new PgOperationLedger(() => app),
    events: new PgEventPublisher(),
    dueWork: new PgDueWorkScheduler({ testKindsEnabled: false }),
    files: storage,
    responses: new PgResponsePresence(),
    businessClock,
    consent,
    pool: () => app,
  })
}

describe('給老師的作業（C 階段 T3、AC-7）：名單＝啟用中、有老師角色的帳號，每人一列', () => {
  it('預覽與發布同一份名單；學生、停用的老師、老師角色已撤銷的不在名單上；事件發給名單上的老師', async () => {
    const { cohortId } = await newCohort()
    await newStudent(cohortId)
    const t1 = await newTeacher()
    const t2 = await newTeacher()
    const disabled = await newTeacher({ status: 'disabled' })
    const revoked = await newTeacher({ revoked: true })
    const item = await mustCreate(cohortId, { audienceKind: 'teachers', receiverUnit: 'individual', title: '指導意願調查表' })
    const preview = await query.previewRecipients({ cohortId, audienceKind: 'teachers', groupIds: [], receiverUnit: 'individual' })
    const previewIds = preview.people.map((p) => p.userId)
    expect(previewIds).toEqual(expect.arrayContaining([teacherId, t1, t2]))
    expect(previewIds).not.toContain(disabled)
    expect(previewIds).not.toContain(revoked)

    const published = await mustPublish(item.itemId, item.revision)
    const roster = await currentRoster(item.itemId)
    expect(roster).toEqual([...previewIds].sort())
    expect(published.rosterCount).toBe(previewIds.length)
    expect((await rosterRows(item.itemId)).every((r) => r.receiver_kind === 'user')).toBe(true)
    const [event] = await events(item.itemId, 'item.published')
    expect([...(event!.recipients as string[])].sort()).toEqual([...previewIds].sort())
  })

  it('給老師的作業不能整組一份（application 先擋，不靠 DB CHECK）', async () => {
    const { cohortId } = await newCohort()
    const created = await items.create(adminActor(), input(cohortId, { audienceKind: 'teachers', receiverUnit: 'group' }), randomUUID())
    expect(created.ok || created.code).toBe('VALIDATION_FAILED')
  })
})

describe('站內同意書作業（C 階段規格① §1.2、AC-21、AC-21a）', () => {
  const consent = (patch: Partial<ItemInput> = {}): Partial<ItemInput> => ({
    title: '期中結果確認同意書',
    body: '<p>本組同意期中結果。</p>',
    receiverUnit: 'group',
    consentMode: 'form',
    consentPurpose: 'final_document',
    dueAt: '',
    fields: [],
    ...patch,
  })

  it('存草稿就落盤模式與用途、讀回得到；不建任何簽核包、不發事件；改用途也存得住（AC-21a）', async () => {
    const { cohortId } = await newCohort()
    const fake = fakeConsentHook()
    const command = itemsWith(fake.hook)
    const created = await command.create(adminActor(), input(cohortId, consent()), randomUUID())
    if (!created.ok) throw new Error(created.message)
    expect(await itemRow(created.receipt.itemId)).toMatchObject({ status: 'draft', consent_mode: 'form', consent_purpose: 'final_document' })
    const detail = await query.get(created.receipt.itemId)
    expect(detail).toMatchObject({ consentMode: 'form', consentPurpose: 'final_document' })
    expect((await query.list(cohortId)).find((r) => r.id === created.receipt.itemId)?.consentMode).toBe('form')

    const saved = await command.saveDraft(adminActor(), created.receipt.itemId, 1, input(cohortId, consent({ consentPurpose: 'result_confirmation' })), randomUUID())
    expect(saved.ok).toBe(true)
    expect((await query.get(created.receipt.itemId))?.consentPurpose).toBe('result_confirmation')
    expect(await count('select count(*) as n from signoff_packages where item_id = $1', [created.receipt.itemId])).toBe(0)
    expect(await count("select count(*) as n from domain_events where source_type = 'item' and source_id = $1", [created.receipt.itemId])).toBe(0)
    expect(fake.calls).toEqual([])
  })

  it('發布：名單一列一組、同一筆交易呼叫 hook（對象組、正文、用途），不發「新作業」；截止選填、不要繳交欄位（AC-21）', async () => {
    const { cohortId } = await newCohort()
    const s1 = await newStudent(cohortId)
    const s2 = await newStudent(cohortId)
    const g1 = await newGroup(cohortId, [s1], 'G01')
    const g2 = await newGroup(cohortId, [s2], 'G02')
    await assignAdvisor(g2, teacherId)
    const fake = fakeConsentHook()
    const command = itemsWith(fake.hook)
    const created = await command.create(adminActor(), input(cohortId, consent({ consentPurpose: 'result_confirmation' })), randomUUID())
    if (!created.ok) throw new Error(created.message)
    const published = await command.publish(adminActor(), created.receipt.itemId, 1, { notify: true }, randomUUID())
    if (!published.ok) throw new Error(published.message)
    expect(published.receipt).toMatchObject({ rosterCount: 2, notifiedCount: 0, consent: { created: 1, skipped: [{ groupId: [g1, g2].sort()[0], reason: 'no_advisor' }] } })
    expect(await currentRoster(created.receipt.itemId)).toEqual([g1, g2].sort())
    expect(fake.calls).toEqual([
      { kind: 'published', itemId: created.receipt.itemId, groupIds: [g1, g2].sort(), purpose: 'result_confirmation', bodyHtml: '<p>本組同意期中結果。</p>' },
    ])
    expect(await events(created.receipt.itemId, 'item.published')).toHaveLength(0)
    expect((await itemRow(created.receipt.itemId)).status).toBe('published')
  })

  it('交給 hook 的正文讀出時再淨化一次（CL-1）：資料庫被直接塞了 script，簽核包拿到的是清理過的', async () => {
    const { cohortId } = await newCohort()
    const s1 = await newStudent(cohortId)
    const g1 = await newGroup(cohortId, [s1], 'G01')
    await assignAdvisor(g1, teacherId)
    const fake = fakeConsentHook()
    const command = itemsWith(fake.hook)
    const created = await command.create(adminActor(), input(cohortId, consent({ consentPurpose: 'result_confirmation' })), randomUUID())
    if (!created.ok) throw new Error(created.message)
    await owner.sql(`update managed_items set body_html = $2 where id = $1`, [created.receipt.itemId, '<p onclick="x()">本組同意。</p><script>alert(1)</script>'])
    const published = await command.publish(adminActor(), created.receipt.itemId, 1, { notify: true }, randomUUID())
    if (!published.ok) throw new Error(published.message)
    expect(fake.calls.map((c) => c.bodyHtml)).toEqual(['<p>本組同意。</p>'])
  })

  it('hook 回錯（例如有組沒有成果展示草稿）：整筆回滾，作業仍是草稿、沒有名單與事件', async () => {
    const { cohortId } = await newCohort()
    const s1 = await newStudent(cohortId)
    const g1 = await newGroup(cohortId, [s1], 'G01')
    await assignAdvisor(g1, teacherId)
    await showcaseDraft(cohortId, g1)
    const fake = fakeConsentHook({ code: 'VALIDATION_FAILED', message: '這些組還沒有成果展示草稿：G01' })
    const command = itemsWith(fake.hook)
    const created = await command.create(adminActor(), input(cohortId, consent()), randomUUID())
    if (!created.ok) throw new Error(created.message)
    const result = await command.publish(adminActor(), created.receipt.itemId, 1, { notify: true }, randomUUID())
    expect(result).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', message: '這些組還沒有成果展示草稿：G01' })
    await expectStillDraft(created.receipt.itemId)
  })

  it('發布前檢查：對象組都沒有主指導 → 擋；最終文件授權有組沒有成果展示草稿 → 擋並列組別（AC-21b 的前一道）', async () => {
    const { cohortId } = await newCohort()
    const s1 = await newStudent(cohortId)
    const s2 = await newStudent(cohortId)
    const g1 = await newGroup(cohortId, [s1], 'G01')
    const g2 = await newGroup(cohortId, [s2], 'G02')
    const fake = fakeConsentHook()
    const command = itemsWith(fake.hook)
    const created = await command.create(adminActor(), input(cohortId, consent()), randomUUID())
    if (!created.ok) throw new Error(created.message)
    const noAdvisor = await command.publish(adminActor(), created.receipt.itemId, 1, { notify: true }, randomUUID())
    expect(!noAdvisor.ok && noAdvisor.details?.checks).toEqual(['consent_advisor', 'consent_drafts'])

    await assignAdvisor(g1, teacherId)
    await showcaseDraft(cohortId, g2)
    const noDraft = await command.publish(adminActor(), created.receipt.itemId, 1, { notify: true }, randomUUID())
    expect(noDraft).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', details: { checks: ['consent_drafts'] } })
    expect(!noDraft.ok && noDraft.message).toContain('這些組還沒有成果展示草稿：G01')
    await expectStillDraft(created.receipt.itemId)
    expect(fake.calls).toEqual([])

    await showcaseDraft(cohortId, g1)
    expect((await command.publish(adminActor(), created.receipt.itemId, 1, { notify: true }, randomUUID())).ok).toBe(true)
  })

  it('發布後模式與用途鎖定；改正文才請 hook 建新版，只改標題不會；移出對象的組請 hook 作廢；不發 item.updated；沒有回答仍可撤回', async () => {
    const { cohortId } = await newCohort()
    const s1 = await newStudent(cohortId)
    const s2 = await newStudent(cohortId)
    const g1 = await newGroup(cohortId, [s1], 'G01')
    const g2 = await newGroup(cohortId, [s2], 'G02')
    await assignAdvisor(g1, teacherId)
    const fake = fakeConsentHook()
    const command = itemsWith(fake.hook)
    const base = consent({ consentPurpose: 'result_confirmation', audienceKind: 'groups', groupIds: [g1, g2] })
    const created = await command.create(adminActor(), input(cohortId, base), randomUUID())
    if (!created.ok) throw new Error(created.message)
    const published = await command.publish(adminActor(), created.receipt.itemId, 1, { notify: false }, randomUUID())
    if (!published.ok) throw new Error(published.message)
    let revision = published.receipt.revision

    const relocked = await command.updatePublished(adminActor(), created.receipt.itemId, revision, input(cohortId, { ...base, consentPurpose: 'final_document' }), { notify: false }, randomUUID())
    expect(relocked).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', details: { field: 'consentMode' } })

    const retitled = await command.updatePublished(adminActor(), created.receipt.itemId, revision, input(cohortId, { ...base, title: '新標題' }), { notify: false }, randomUUID())
    if (!retitled.ok) throw new Error(retitled.message)
    revision = retitled.receipt.revision
    expect(fake.calls.map((c) => c.kind)).toEqual(['published'])

    const rebodied = await command.updatePublished(
      adminActor(),
      created.receipt.itemId,
      revision,
      input(cohortId, { ...base, title: '新標題', body: '<p>改過的內容。</p>' }),
      { notify: false },
      randomUUID(),
    )
    if (!rebodied.ok) throw new Error(rebodied.message)
    revision = rebodied.receipt.revision
    expect(fake.calls.at(-1)).toMatchObject({ kind: 'content_changed', groupIds: [g1, g2].sort(), bodyHtml: '<p>改過的內容。</p>' })

    const narrowed = await command.updatePublished(
      adminActor(),
      created.receipt.itemId,
      revision,
      input(cohortId, { ...base, title: '新標題', body: '<p>改過的內容。</p>', groupIds: [g1] }),
      { notify: true },
      randomUUID(),
    )
    if (!narrowed.ok) throw new Error(narrowed.message)
    expect(fake.calls.at(-1)).toEqual({ kind: 'groups_removed', itemId: created.receipt.itemId, groupIds: [g2] })
    expect(await events(created.receipt.itemId, 'item.published')).toHaveLength(0)

    // 發布更新勾了通知也不發一般的「作業已更新」（同意書通知交給 hook，Review r1）。
    expect(await events(created.receipt.itemId, 'item.updated')).toHaveLength(0)

    // 沒有任何回答時 API 仍可撤回（規格 §2.5、T6；既有 lifecycle 守門）。
    const withdrawn = await command.changeStatus(adminActor(), created.receipt.itemId, narrowed.receipt.revision, 'withdraw', randomUUID())
    expect(withdrawn.ok).toBe(true)
    expect((await itemRow(created.receipt.itemId)).status).toBe('draft')
  })

  it('只改截止、勾通知：不發一般的 item.updated（Review r1；AC-23）', async () => {
    const { cohortId } = await newCohort()
    const s1 = await newStudent(cohortId)
    const g1 = await newGroup(cohortId, [s1], 'G01')
    await assignAdvisor(g1, teacherId)
    const fake = fakeConsentHook()
    const command = itemsWith(fake.hook)
    const base = consent({ consentPurpose: 'result_confirmation' })
    const created = await command.create(adminActor(), input(cohortId, base), randomUUID())
    if (!created.ok) throw new Error(created.message)
    const published = await command.publish(adminActor(), created.receipt.itemId, 1, { notify: false }, randomUUID())
    if (!published.ok) throw new Error(published.message)
    const updated = await command.updatePublished(
      adminActor(),
      created.receipt.itemId,
      published.receipt.revision,
      input(cohortId, { ...base, dueAt: '2026-12-31T23:59' }),
      { notify: true },
      randomUUID(),
    )
    expect(updated).toMatchObject({ ok: true, receipt: { changes: ['deadline'], notifiedCount: 0 } })
    expect(await events(created.receipt.itemId, 'item.updated')).toHaveLength(0)
    expect(fake.calls.map((c) => c.kind)).toEqual(['published'])
  })

  it('上傳簽名檔的同意書就是個人作業：照常發「新作業」、不呼叫 hook', async () => {
    const { cohortId } = await newCohort()
    await newStudent(cohortId)
    const fake = fakeConsentHook()
    const command = itemsWith(fake.hook)
    const created = await command.create(
      adminActor(),
      input(cohortId, { consentMode: 'upload', receiverUnit: 'individual', title: '授權書（簽名上傳）' }),
      randomUUID(),
    )
    if (!created.ok) throw new Error(created.message)
    const published = await command.publish(adminActor(), created.receipt.itemId, 1, { notify: true }, randomUUID())
    expect(published.ok && published.receipt.consent).toBeNull()
    expect(await events(created.receipt.itemId, 'item.published')).toHaveLength(1)
    expect(fake.calls).toEqual([])
  })
})

describe('專題需求以作業載入（C 階段規格① §0.4）', () => {
  it('requirement 的列用 submission 表單存草稿、發布更新：位置保留 requirement', async () => {
    const { cohortId } = await newCohort()
    await newStudent(cohortId)
    const item = await mustCreate(cohortId)
    await owner.sql(`update managed_items set placement = 'requirement' where id = $1`, [item.itemId])
    const saved = await items.saveDraft(adminActor(), item.itemId, 1, input(cohortId, { title: '專題需求表' }), randomUUID())
    if (!saved.ok) throw new Error(saved.message)
    expect((await itemRow(item.itemId)).placement).toBe('requirement')
    const published = await mustPublish(item.itemId, saved.receipt.revision)
    const updated = await items.updatePublished(adminActor(), item.itemId, published.revision, input(cohortId, { title: '專題需求表（改）' }), { notify: false }, randomUUID())
    expect(updated.ok).toBe(true)
    expect(await itemRow(item.itemId)).toMatchObject({ placement: 'requirement', title: '專題需求表（改）' })
  })
})

describe('專題規則整批排序 reorderRules（C 階段規格① §3.1）', () => {
  async function rules(cohortId: string, n: number): Promise<string[]> {
    const ids: string[] = []
    for (let i = 0; i < n; i += 1) {
      const created = await mustCreate(cohortId, { placement: 'rules', audienceKind: 'public', receiverUnit: 'none', title: `第 ${i + 1} 章`, fields: [] })
      ids.push(created.itemId)
    }
    return ids
  }
  async function order(cohortId: string): Promise<string[]> {
    return (
      await owner.sql(`select id from managed_items where cohort_id = $1 and placement = 'rules' and deleted_at is null order by rules_position`, [cohortId])
    ).rows.map((r) => String(r.id))
  }

  it('照送來的順序寫成 1..n；不動 revision、不切版本；同一個請求重送回同一個回執；順序一樣不寫稽核', async () => {
    const { cohortId } = await newCohort()
    const [a, b, c] = await rules(cohortId, 3)
    const requestId = randomUUID()
    const result = await items.reorderRules(adminActor(), cohortId, [c!, a!, b!], requestId)
    expect(result).toMatchObject({ ok: true, receipt: { cohortId, count: 3 } })
    expect(await order(cohortId)).toEqual([c, a, b])
    expect((await owner.sql('select array_agg(rules_position order by rules_position) as p from managed_items where cohort_id = $1', [cohortId])).rows[0]!.p).toEqual([1, 2, 3])
    expect(await count('select count(*) as n from managed_items where cohort_id = $1 and revision <> 1', [cohortId])).toBe(0)
    expect(await count("select count(*) as n from audit_events where action = 'item.rule_moved' and target_id = $1", [cohortId])).toBe(1)
    const again = await items.reorderRules(adminActor(), cohortId, [c!, a!, b!], requestId)
    expect(again.ok && result.ok && again.receipt.serverTime).toBe(result.ok && result.receipt.serverTime)
    expect((await items.reorderRules(adminActor(), cohortId, [c!, a!, b!], randomUUID())).ok).toBe(true)
    expect(await count("select count(*) as n from audit_events where action = 'item.rule_moved' and target_id = $1", [cohortId])).toBe(1)
  })

  it('集合不符（少一章、多一章、重複、別屆的、不是規則）→ VALIDATION_FAILED，順序不動；不是系辦 FORBIDDEN', async () => {
    const { cohortId } = await newCohort()
    const [a, b] = await rules(cohortId, 2)
    const other = await newCohort()
    const [x] = await rules(other.cohortId, 1)
    const news = await mustCreate(cohortId, { placement: 'news', audienceKind: 'public', receiverUnit: 'none', fields: [] })
    for (const ids of [[a!], [a!, b!, x!], [a!, a!], [b!, x!], [b!, news.itemId]]) {
      const result = await items.reorderRules(adminActor(), cohortId, ids, randomUUID())
      expect(result.ok || result.code).toBe('VALIDATION_FAILED')
    }
    expect(await order(cohortId)).toEqual([a, b])
    expect((await items.reorderRules(teacherActor(), cohortId, [b!, a!], randomUUID())).ok || 'x').toBe('x')
    expect(await order(cohortId)).toEqual([a, b])
  })
})

describe('資源分類改名 renameResourceCategory（C 階段規格① §11.3 resource_category）', () => {
  it('跨屆把同名分類一次改掉、revision+1；不產生內容版本與發布紀錄；稽核一筆；別的位置同名分類不動', async () => {
    const one = await newCohort()
    const two = await newCohort()
    const resource = (cohortId: string, category: string) =>
      mustCreate(cohortId, { placement: 'resource', audienceKind: 'public', receiverUnit: 'none', category, fields: [] })
    const r1 = await resource(one.cohortId, '範本-改名測試')
    const r2 = await resource(two.cohortId, '範本-改名測試')
    await mustPublish(r2.itemId, r2.revision, false)
    const news = await mustCreate(one.cohortId, { placement: 'news', audienceKind: 'public', receiverUnit: 'none', category: '範本-改名測試', fields: [] })
    const versionsBefore = await count('select count(*) as n from item_versions where item_id = any($1::uuid[])', [[r1.itemId, r2.itemId]])
    const publicationsBefore = await count('select count(*) as n from item_publications where item_id = any($1::uuid[])', [[r1.itemId, r2.itemId]])

    const result = await items.renameResourceCategory(adminActor(), { from: '範本-改名測試', to: '表單範本-改名測試', requestId: randomUUID() })
    expect(result).toMatchObject({ ok: true, receipt: { from: '範本-改名測試', to: '表單範本-改名測試', count: 2 } })
    expect(await itemRow(r1.itemId)).toMatchObject({ category: '表單範本-改名測試', revision: 2 })
    expect(await itemRow(r2.itemId)).toMatchObject({ category: '表單範本-改名測試', revision: 3 })
    expect((await itemRow(news.itemId)).category).toBe('範本-改名測試')
    expect(await count('select count(*) as n from item_versions where item_id = any($1::uuid[])', [[r1.itemId, r2.itemId]])).toBe(versionsBefore)
    expect(await count('select count(*) as n from item_publications where item_id = any($1::uuid[])', [[r1.itemId, r2.itemId]])).toBe(publicationsBefore)
    const audit = await owner.sql("select payload from audit_events where action = 'item.category_renamed' order by real_at desc limit 1")
    expect(audit.rows[0]!.payload).toEqual({ from: '範本-改名測試', to: '表單範本-改名測試', count: 2 })
  })

  it('新名撞到既有資源分類（任何一屆）→「已有這個分類」；找不到舊分類、空白新名、不是系辦都擋，什麼都不改', async () => {
    const one = await newCohort()
    const two = await newCohort()
    const a = await mustCreate(one.cohortId, { placement: 'resource', audienceKind: 'public', receiverUnit: 'none', category: '甲-衝突測試', fields: [] })
    await mustCreate(two.cohortId, { placement: 'resource', audienceKind: 'public', receiverUnit: 'none', category: '乙-衝突測試', fields: [] })
    const clash = await items.renameResourceCategory(adminActor(), { from: '甲-衝突測試', to: '乙-衝突測試', requestId: randomUUID() })
    expect(clash).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', message: '已有這個分類，請換一個名稱。' })
    expect((await items.renameResourceCategory(adminActor(), { from: '沒有這個-衝突測試', to: '丙', requestId: randomUUID() })).ok).toBe(false)
    expect((await items.renameResourceCategory(adminActor(), { from: '甲-衝突測試', to: '   ', requestId: randomUUID() })).ok).toBe(false)
    const denied = await items.renameResourceCategory(teacherActor(), { from: '甲-衝突測試', to: '丙', requestId: randomUUID() })
    expect(denied.ok || denied.code).toBe('FORBIDDEN')
    expect(await itemRow(a.itemId)).toMatchObject({ category: '甲-衝突測試', revision: 1 })
  })
})
