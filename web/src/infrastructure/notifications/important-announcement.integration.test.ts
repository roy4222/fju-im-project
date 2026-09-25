import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assertTestDatabaseReachable, createIsolatedDatabase, poolAsRole, type IsolatedDatabase } from '../../../test/db'
import { migratedSchema } from '../../../test/migrations'
import type { ResolvedActor } from '@/application/accounts'
import type { AudienceKind, ItemInput } from '@/application/items'
import { createAttachmentPolicy } from '@/infrastructure/items/attachment-policy'
import { PgItemCommand } from '@/infrastructure/items/pg-items'
import { PgDueWorkScheduler } from '@/infrastructure/notifications/pg-due-work-scheduler'
import { PgEventPublisher } from '@/infrastructure/notifications/pg-event-publisher'
import { PgInbox } from '@/infrastructure/notifications/pg-inbox'
import { PgNotificationProjector } from '@/infrastructure/notifications/pg-projector'
import { PgAuditWriter } from '@/infrastructure/ops/audit-writer'
import { FsFileStorage } from '@/infrastructure/ops/file-storage'
import { PgOperationLedger } from '@/infrastructure/ops/operation-ledger'
import { PgResponsePresence } from '@/infrastructure/submissions/pg-response-presence'

/**
 * 重要公告逐人通知（Roy 2026-09-25 定；產品模組 08 §4「重要公告發布→受眾」、NTF-01／NTF-06）。
 *
 * 公開或所有登入者的公告：勾了「重要」才逐人寫站內通知給全站有效帳號；一般公告只留發布紀錄、不發事件。
 * 從發布（`PgItemCommand`）→ 事件 → 背景工作投影（`PgNotificationProjector`）→ 通知匣（`PgInbox`）整條走一遍，
 * 全部以正式執行角色 `fju_app` 連線。
 */

let owner: IsolatedDatabase
let app: Pool
let items: PgItemCommand
let inbox: PgInbox
let cohortId: string
let otherCohortId: string
const ids: Record<string, string> = {}

const publisher = new PgEventPublisher()
const businessClock = { now: async () => new Date('2026-09-25T02:00:00Z') }
const projector = () => new PgNotificationProjector({ pool: () => app, events: publisher, businessClock, log: () => undefined })

const admin = (): ResolvedActor => ({
  kind: 'authenticated',
  userId: ids.admin!,
  roles: ['admin'],
  status: 'active',
  mustChangePassword: false,
  cohortMemberships: [],
})

const reader = (userId: string): ResolvedActor => ({
  kind: 'authenticated',
  userId,
  roles: ['student'],
  status: 'active',
  mustChangePassword: false,
  cohortMemberships: [],
})

async function newUser(key: string, role: 'admin' | 'teacher' | 'student', options: { status?: string; email?: string; deidentified?: boolean; cohort?: string } = {}) {
  const user = await owner.sql(
    `insert into users (id, name, email, email_verified, updated_at, status, deidentified_at)
     values (gen_random_uuid(), $1, $2, true, now(), $3, case when $4 then now() end) returning id`,
    [key, options.email ?? `${key}-notify@example.com`, options.status ?? 'active', options.deidentified === true],
  )
  const id = String(user.rows[0]!.id)
  ids[key] = id
  await owner.sql(
    `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at)
     values (gen_random_uuid(), $1, $2, $1, now())`,
    [id, role],
  )
  if (role === 'student') {
    const studentNo = `4150${String(Object.keys(ids).length).padStart(5, '0')}`
    const cohort = options.cohort ?? cohortId
    await owner.sql(
      `insert into user_profiles (user_id, display_name, name_normalized, student_no, cohort_id, contact_email)
       values ($1, $2, $2, $3, $4, $5)`,
      [id, key, studentNo, cohort, `${key}@contact.example.com`],
    )
    await owner.sql('insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)', [cohort, studentNo, id])
  }
  return id
}

function announcement(audienceKind: AudienceKind, title: string): ItemInput {
  return {
    cohortId,
    placement: 'news',
    title,
    summary: '摘要',
    body: '<p>內容</p>',
    category: '',
    coverFileId: null,
    attachmentFileIds: [],
    audienceKind,
    groupIds: [],
    receiverUnit: 'none',
    stageId: null,
    opensAt: '',
    dueAt: '',
    fields: [],
  }
}

async function publishAnnouncement(audienceKind: AudienceKind, important: boolean, title = `公告 ${randomUUID().slice(0, 8)}`) {
  const created = await items.create(admin(), announcement(audienceKind, title), randomUUID())
  if (!created.ok) throw new Error(`${created.code} ${created.message}`)
  const published = await items.publish(admin(), created.receipt.itemId, created.receipt.revision, { notify: important }, randomUUID())
  if (!published.ok) throw new Error(`${published.code} ${published.message}`)
  return published.receipt
}

async function notifiedUsers(itemId: string): Promise<string[]> {
  const rows = await owner.sql(
    `select recipient_user_id from notifications where source_ref->>'type' = 'item' and source_ref->>'id' = $1
      order by recipient_user_id`,
    [itemId],
  )
  return rows.rows.map((r) => String(r.recipient_user_id))
}

async function count(sql: string, values: unknown[] = []): Promise<number> {
  return Number((await owner.sql(sql, values)).rows[0]!.n)
}

async function drain() {
  for (let i = 0; i < 20; i += 1) {
    const summary = await projector().runOnce()
    if (summary.done + summary.retried + summary.failed === 0) return
  }
}

beforeAll(async () => {
  await assertTestDatabaseReachable()
  owner = await createIsolatedDatabase({ label: 'notify', setup: migratedSchema })
  app = await poolAsRole(owner, 'fju_app')

  const cohorts = await owner.sql(
    `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
     values (gen_random_uuid(), '115-N', '115', 'active', '2027-06-30', 'system'),
            (gen_random_uuid(), '114-N', '114', 'active', '2026-06-30', 'system')
     returning id, code`,
  )
  cohortId = String(cohorts.rows.find((r) => r.code === '115-N')!.id)
  otherCohortId = String(cohorts.rows.find((r) => r.code === '114-N')!.id)

  await newUser('admin', 'admin')
  await newUser('teacher', 'teacher')
  await newUser('student', 'student')
  await newUser('elder', 'student', { cohort: otherCohortId })
  await newUser('demo', 'student', { email: 'demo-student@demo.invalid' })
  await newUser('pending', 'student', { status: 'pending' })
  await newUser('disabled', 'student', { status: 'disabled' })
  await newUser('gone', 'student', { status: 'disabled', deidentified: true })

  const storage = new FsFileStorage({
    root: () => '/nonexistent-notify-test',
    environmentMaxBytes: () => 1024,
    ticketSecret: () => 'notify-integration-secret-notify-integration',
    policies: { attachment: createAttachmentPolicy(() => app) },
    db: () => app,
  })
  items = new PgItemCommand({
    audit: new PgAuditWriter(),
    ledger: new PgOperationLedger(() => app),
    events: publisher,
    dueWork: new PgDueWorkScheduler({ testKindsEnabled: false }),
    files: storage,
    responses: new PgResponsePresence(),
    businessClock,
    pool: () => app,
  })
  inbox = new PgInbox({ db: () => app })
})

afterAll(async () => {
  await app?.end()
  await owner?.close()
})

describe('重要公告（公開／所有登入者）逐人發站內通知', () => {
  it('所有登入者＋重要：每位有效帳號一則（含示範帳號）；待審、停用、去識別化不收', async () => {
    const receipt = await publishAnnouncement('signed_in', true, '期末展延期')
    const expected = [ids.admin!, ids.teacher!, ids.student!, ids.elder!, ids.demo!].sort()
    expect(receipt.notifiedCount).toBe(expected.length)

    await drain()
    expect(await notifiedUsers(receipt.itemId)).toEqual(expected)
    for (const key of ['pending', 'disabled', 'gone']) {
      expect(await count('select count(*) as n from notifications where recipient_user_id = $1', [ids[key]])).toBe(0)
    }

    // 通知匣與未讀徽章自然生效：標題是公告標題，點進前台內容頁。
    expect(await inbox.unreadCount(reader(ids.student!))).toBe(1)
    const page = await inbox.list(reader(ids.student!), { kind: 'all' }, null)
    expect(page.items).toHaveLength(1)
    expect(page.items[0]).toMatchObject({ title: '期末展延期', kind: 'system', source: { state: 'ok', href: `/news/${receipt.itemId}` } })
  })

  it('一般公告（沒勾重要）：只留發布紀錄，不發事件、沒有任何通知', async () => {
    for (const audience of ['public', 'signed_in'] as const) {
      const receipt = await publishAnnouncement(audience, false)
      expect(receipt.notifiedCount).toBe(0)
      expect(await count(`select count(*) as n from domain_events where source_id = $1 and type = 'item.announced'`, [receipt.itemId])).toBe(0)
      expect(
        (await owner.sql(`select notify from item_publications where item_id = $1 and action = 'publish'`, [receipt.itemId])).rows,
      ).toEqual([{ notify: false }])
      await drain()
      expect(await notifiedUsers(receipt.itemId)).toEqual([])
    }
  })

  it('本屆學生＋重要：非受眾（其他屆學生、老師）不收', async () => {
    const receipt = await publishAnnouncement('cohort_students', true)
    await drain()
    expect(await notifiedUsers(receipt.itemId)).toEqual([ids.student!, ids.demo!].sort())
  })

  it('重跑投影不重複：把投影列改回 pending 再跑一次，每人仍只有一則', async () => {
    const receipt = await publishAnnouncement('public', true)
    await drain()
    const first = await notifiedUsers(receipt.itemId)
    expect(first).toHaveLength(5)

    await owner.sql(
      `update event_projections set state = 'pending', done_at = null, claimed_at = null
        where consumer = 'notifications' and event_id in (select id from domain_events where source_id = $1)`,
      [receipt.itemId],
    )
    await drain()
    expect(await notifiedUsers(receipt.itemId)).toEqual(first)
  })

  it('大量受眾：1,200 位有效帳號一輪投影就全部寫進去（分批寫入），每人一則', async () => {
    await owner.sql(
      `insert into users (id, name, email, email_verified, updated_at, status)
       select gen_random_uuid(), 'bulk-' || n, 'bulk-' || n || '-notify@example.com', true, now(), 'active'
         from generate_series(1, 1200) as n`,
    )
    const active = await count(`select count(*) as n from users where status = 'active' and deidentified_at is null`)
    const receipt = await publishAnnouncement('public', true)
    expect(receipt.notifiedCount).toBe(active)

    const summary = await projector().runOnce()
    expect(summary).toMatchObject({ done: 1, failed: 0 })
    expect(await count(`select count(*) as n from notifications where source_ref->>'id' = $1`, [receipt.itemId])).toBe(active)
    expect(
      await count(
        `select count(*) as n from (select recipient_user_id from notifications where source_ref->>'id' = $1
                                     group by recipient_user_id having count(*) > 1) d`,
        [receipt.itemId],
      ),
    ).toBe(0)
  })
})

describe('下架與重新發布', () => {
  it('下架不刪已發通知，連結照樣指向前台內容頁（那一頁顯示「已下架」）；重新發布只有勾重要才再通知', async () => {
    const published = await publishAnnouncement('signed_in', true, '下架測試')
    await drain()
    const before = await notifiedUsers(published.itemId)
    expect(before.length).toBeGreaterThan(0)

    const archived = await items.changeStatus(admin(), published.itemId, published.revision, 'archive', randomUUID())
    if (!archived.ok) throw new Error(archived.message)
    expect(await notifiedUsers(published.itemId)).toEqual(before)
    const page = await inbox.list(reader(ids.teacher!), { kind: 'all' }, null)
    const old = page.items.find((i) => i.title === '下架測試')
    expect(old?.source).toEqual({ state: 'ok', href: `/news/${published.itemId}` })

    // 重新發布、不勾重要：只留紀錄。
    const quiet = await items.changeStatus(admin(), published.itemId, archived.receipt.revision, 'republish', randomUUID())
    if (!quiet.ok) throw new Error(quiet.message)
    expect(quiet.receipt.notifiedCount).toBe(0)
    expect(await count(`select count(*) as n from domain_events where source_id = $1 and type = 'item.announced'`, [published.itemId])).toBe(1)

    // 再下架、重新發布並勾重要：另發一個事件，受眾每人再收一則。
    const again = await items.changeStatus(admin(), published.itemId, quiet.receipt.revision, 'archive', randomUUID())
    if (!again.ok) throw new Error(again.message)
    const loud = await items.changeStatus(admin(), published.itemId, again.receipt.revision, 'republish', randomUUID(), { notify: true })
    if (!loud.ok) throw new Error(loud.message)
    expect(loud.receipt.notifiedCount).toBe(before.length)
    expect(await count(`select count(*) as n from domain_events where source_id = $1 and type = 'item.announced'`, [published.itemId])).toBe(2)
    expect(
      (await owner.sql(`select notify from item_publications where item_id = $1 and action = 'republish' order by real_at`, [published.itemId])).rows,
    ).toEqual([{ notify: false }, { notify: true }])
  })
})
