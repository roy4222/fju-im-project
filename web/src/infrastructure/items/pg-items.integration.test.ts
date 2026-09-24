import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { assertTestDatabaseReachable, createIsolatedDatabase, poolAsRole, type IsolatedDatabase } from '../../../test/db'
import { enableFaultInjection, failAt } from '../../../test/fault-injection'
import { migratedSchema } from '../../../test/migrations'
import type { ResolvedActor } from '@/application/accounts'
import { EMPTY_COLLECTION_MESSAGE, snapshotDueAt, type ItemInput } from '@/application/items'
import { createAttachmentPolicy } from '@/infrastructure/items/attachment-policy'
import { NoResponsesYet } from '@/infrastructure/items/no-responses-yet'
import { PgItemCommand, PgItemQuery } from '@/infrastructure/items/pg-items'
import { PgPublicItemQuery } from '@/infrastructure/items/pg-public-items'
import { PgDueWorkScheduler } from '@/infrastructure/notifications/pg-due-work-scheduler'
import { PgEventPublisher } from '@/infrastructure/notifications/pg-event-publisher'
import { PgAuditWriter } from '@/infrastructure/ops/audit-writer'
import { FsFileStorage } from '@/infrastructure/ops/file-storage'
import { PgOperationLedger } from '@/infrastructure/ops/operation-ledger'

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
    responses: new NoResponsesYet(),
    businessClock,
    pool: () => app,
  }
  items = new PgItemCommand(deps)
  // 票 17 之後才會有真的回答；這個替身假裝「已經有人作答」，證明鎖定規則已經接好。
  lockedItems = new PgItemCommand({ ...deps, responses: { hasAnyResponse: async () => true } })
  query = new PgItemQuery(() => app)
  publicQuery = new PgPublicItemQuery(() => app)
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

  it('收件缺所屬階段：擋', async () => {
    const { cohortId } = await newCohort()
    const item = await mustCreate(cohortId, { stageId: null })
    const result = await items.publish(adminActor(), item.itemId, 1, { notify: true }, randomUUID())
    expect(result.ok || result.code).toBe('VALIDATION_FAILED')
    await expectNothingPublished(item.itemId)
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

  it('勾通知：全部老師的公告寫給老師；公開公告只留事件、不展開全站', async () => {
    const { cohortId } = await newCohort()
    const teachers = await mustCreate(cohortId, { placement: 'news', audienceKind: 'teachers' })
    await mustPublish(teachers.itemId, 1, true)
    expect((await events(teachers.itemId, 'item.announced'))[0]!.recipients).toEqual([teacherId])

    const open = await mustCreate(cohortId, { placement: 'resource', audienceKind: 'public' })
    const receipt = await mustPublish(open.itemId, 1, true)
    expect(receipt.notifiedCount).toBe(0)
    expect((await events(open.itemId, 'item.announced'))[0]!.recipients).toEqual([])
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
      kind: 'cover',
      fileName: 'cover.pdf',
      declaredMime: 'application/pdf',
      declaredSize: 100,
    })
    expect(cover.ok || cover.code).toBe('FILE_TYPE_REJECTED')
    const attachment = await items.startUpload(adminActor(), {
      cohortId,
      kind: 'attachment',
      fileName: '說明.pdf',
      declaredMime: 'application/pdf',
      declaredSize: 100,
    })
    expect(attachment.ok).toBe(true)
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

    const options = await query.editorOptions(cohortId)
    expect(options.stages.map((s) => s.name)).toEqual(['成組期', '期中'])
    expect(options.groups.map((x) => x.code)).toEqual(['G05'])
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

    // 前台卡片只帶公開欄位。
    const [card] = await publicQuery.list(ANONYMOUS, 'news', { q: `${tag} 公開` })
    expect(Object.keys(card!).sort()).toEqual(
      ['attachments', 'audienceKind', 'category', 'cover', 'id', 'placement', 'publishedAt', 'summary', 'title'].sort(),
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
