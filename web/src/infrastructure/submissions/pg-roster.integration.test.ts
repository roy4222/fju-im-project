import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assertTestDatabaseReachable, createIsolatedDatabase, poolAsRole, type IsolatedDatabase } from '../../../test/db'
import { migratedSchema } from '../../../test/migrations'
import type { ResolvedActor } from '@/application/accounts'
import { collectsResponses, type ItemInput } from '@/application/items'
import { completionOf, overdueReceiverIds, type ItemRoster } from '@/application/submissions'
import { PgItemCommand, PgItemQuery } from '@/infrastructure/items/pg-items'
import { PgDueWorkScheduler } from '@/infrastructure/notifications/pg-due-work-scheduler'
import { PgEventPublisher } from '@/infrastructure/notifications/pg-event-publisher'
import { PgAuditWriter } from '@/infrastructure/ops/audit-writer'
import { FsFileStorage } from '@/infrastructure/ops/file-storage'
import { PgOperationLedger } from '@/infrastructure/ops/operation-ledger'
import { PgSubmissionLateFlags } from '@/infrastructure/ops/submission-late-flags'
import { PgResponsePresence, responsePresenceReader } from '@/infrastructure/submissions/pg-response-presence'
import { PgRosterQuery } from '@/infrastructure/submissions/pg-roster'
import { PgSubmissionCommand } from '@/infrastructure/submissions/pg-submissions'

/**
 * AD-19：系辦首頁的聚合名單查詢 `completionFacts`（AC-AD-35）。
 *
 * - SQL 句數：測試連線外包一層計數（數 `query()` 呼叫），呼叫一次前後相減；1、8、80 份作業三屆一樣多。不靠 mock。
 * - 結果：把 `completionFacts()` 餵進既有的 `completionOf`／`overdueReceiverIds`，跟首頁原本「逐份 `roster()` 再算」完全相同；
 *   8 份那屆種了免繳、移出、補交期限未到、兩份都逾期的人與逾期的組，規則都靠同一份程式，不會分歧。
 *
 * 全部以正式執行角色 `fju_app` 連線；項目用真用例建立與發布，名單就是發布時展開的那一份；業務鐘是可以撥的假鐘。
 */

let owner: IsolatedDatabase
let app: Pool
let adminId: string
let teacherId: string
let businessNow = new Date('2026-10-01T02:00:00Z')
const businessClock = { now: async () => new Date(businessNow.getTime()) }

let items: PgItemCommand
let itemQuery: PgItemQuery
let submissions: PgSubmissionCommand
let lateFlags: PgSubmissionLateFlags

/** 數 `query()` 呼叫的連線；`completionFacts` 的句數從這裡讀。 */
let queries = 0
const counting = {
  query: ((text: string, values?: unknown[]) => {
    queries += 1
    return app.query(text, values)
  }) as Pool['query'],
}
let facts: PgRosterQuery
/** 首頁原本的做法（逐份 `roster()`）用不計數的連線，跟上面分開。 */
let roster: PgRosterQuery

type Person = { id: string; cohortId: string }

/** 截止 11/15 23:59（臺灣）；「現在」是 11/16 10:00（臺灣），補交到 11/17 17:00。 */
const PAST_DUE = '2026-11-15T23:59'
const FUTURE_DUE = '2026-12-31T23:59'
const AFTER = new Date('2026-11-16T02:00:00Z')
const REOPEN_DUE = '2026-11-17T17:00'

const FIELDS = [{ key: 'topic', type: 'text', label: '題目', required: true }]
const COMPLETE = { topic: '智慧校園導覽' }

function adminActor(): ResolvedActor {
  return { kind: 'authenticated', userId: adminId, roles: ['admin'], status: 'active', mustChangePassword: false, cohortMemberships: [] }
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

let seq = 0
async function newCohort(): Promise<{ cohortId: string; stageId: string }> {
  seq += 1
  const cohort = await owner.sql(
    `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
     values (gen_random_uuid(), $1, $1, 'active', '2027-06-30', 'system') returning id`,
    [`R19-${seq}`],
  )
  const cohortId = String(cohort.rows[0]!.id)
  const stage = await owner.sql(
    `insert into cohort_stages (id, cohort_id, seq, name, start_date, created_by_kind)
     values (gen_random_uuid(), $1, 1, '成組期', '2026-09-15', 'system') returning id`,
    [cohortId],
  )
  return { cohortId, stageId: String(stage.rows[0]!.id) }
}

async function newStudent(cohortId: string): Promise<Person> {
  seq += 1
  const studentNo = `41900${String(seq).padStart(4, '0')}`
  const user = await owner.sql(
    `insert into users (id, name, email, email_verified, updated_at, status)
     values (gen_random_uuid(), $1, $2, true, now(), 'active') returning id`,
    [`學生${seq}`, `s${seq}-r19@example.com`],
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
    [id, `學生${seq}`, studentNo, cohortId, `s${seq}@contact.example.com`],
  )
  await owner.sql('insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)', [cohortId, studentNo, id])
  return { id, cohortId }
}

async function newGroup(cohortId: string, code: string, members: Person[]): Promise<string> {
  const g = await owner.sql(
    `insert into groups (id, cohort_id, code, group_type, established_real_at, established_business_at, created_by_kind)
     values (gen_random_uuid(), $1, $2, 'general', now(), now(), 'system') returning id`,
    [cohortId, code],
  )
  const id = String(g.rows[0]!.id)
  for (const m of members) {
    await owner.sql(
      `insert into group_memberships (id, group_id, cohort_id, user_id, valid_from, added_by_kind)
       values (gen_random_uuid(), $1, $2, $3, now(), 'system')`,
      [id, cohortId, m.id],
    )
  }
  return id
}

function input(cohortId: string, stageId: string, patch: Partial<ItemInput> = {}): ItemInput {
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
    dueAt: FUTURE_DUE,
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

async function submit(s: Person, itemId: string): Promise<void> {
  const saved = await submissions.saveDraft(studentActor(s), itemId, 0, COMPLETE, randomUUID())
  if (!saved.ok) throw new Error(`${saved.code} ${saved.message}`)
  const sent = await submissions.submit(studentActor(s), itemId, saved.receipt.revision, randomUUID())
  if (!sent.ok) throw new Error(`${sent.code} ${sent.message}`)
}

/** 一屆＋兩位學生＋n 份發布中的個人收件。 */
async function cohortWithItems(n: number): Promise<string> {
  const { cohortId, stageId } = await newCohort()
  await newStudent(cohortId)
  await newStudent(cohortId)
  for (let i = 0; i < n; i += 1) await published(cohortId, stageId, { title: `作業 ${i + 1}` })
  return cohortId
}

/** 首頁原本的做法：本屆發布中、會收件的項目逐份 `roster()`（`admin/page.tsx` 的 `publishedIntake`）。 */
async function rostersOneByOne(cohortId: string): Promise<ItemRoster[]> {
  const intake = (await itemQuery.list(cohortId)).filter((i) => collectsResponses(i.placement) && i.status === 'published')
  return (await Promise.all(intake.map((i) => roster.roster(adminActor(), i.id)))).filter((r) => r !== null)
}

async function countedFacts(cohortId: string) {
  const before = queries
  const result = await facts.completionFacts(adminActor(), cohortId)
  return { result, sql: queries - before }
}

beforeAll(async () => {
  await assertTestDatabaseReachable()
  owner = await createIsolatedDatabase({ label: 'roster_facts', setup: migratedSchema })
  app = await poolAsRole(owner, 'fju_app')

  const staff = await owner.sql(
    `insert into users (id, name, email, email_verified, updated_at, status)
     values (gen_random_uuid(), 'A1', 'a1-r19@example.com', true, now(), 'active'),
            (gen_random_uuid(), 'T1', 't1-r19@example.com', true, now(), 'active')
     returning id, name`,
  )
  adminId = String(staff.rows.find((r) => r.name === 'A1')!.id)
  teacherId = String(staff.rows.find((r) => r.name === 'T1')!.id)
  await owner.sql(
    `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at)
     values (gen_random_uuid(), $1, 'admin', $1, now()), (gen_random_uuid(), $2, 'teacher', $1, now())`,
    [adminId, teacherId],
  )

  const storage = new FsFileStorage({
    root: () => '/tmp/fju-roster-facts-unused',
    environmentMaxBytes: () => 1024,
    ticketSecret: () => 'roster-facts-integration-secret-roster',
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
  itemQuery = new PgItemQuery(() => app, responsePresenceReader(() => app))
  submissions = new PgSubmissionCommand({
    audit: new PgAuditWriter(),
    ledger: new PgOperationLedger(() => app),
    businessClock,
    files: storage,
    events: new PgEventPublisher(),
    pool: () => app,
  })
  lateFlags = new PgSubmissionLateFlags(() => app)
  facts = new PgRosterQuery(() => counting, lateFlags)
  roster = new PgRosterQuery(() => app, lateFlags)
}, 120_000)

afterAll(async () => {
  await app?.end()
  await owner?.close()
})

describe('AC-AD-35：SQL 句數不隨作業數增加', () => {
  it('1、8、80 份發布中作業，呼叫一次 completionFacts 的 SQL 句數完全相同（設計是 2 句）', async () => {
    const counts: Record<number, number> = {}
    for (const n of [1, 8, 80]) {
      const cohortId = await cohortWithItems(n)
      const { result, sql } = await countedFacts(cohortId)
      expect(result).toHaveLength(n)
      expect(result.every((f) => f.entries.length === 2)).toBe(true)
      counts[n] = sql
    }
    expect(counts).toEqual({ 1: 2, 8: 2, 80: 2 })
  }, 180_000)
})

describe('AC-AD-35：結果與逐份 roster() 再算完全相同', () => {
  async function eightItemCohort() {
    businessNow = new Date('2026-10-01T02:00:00Z')
    const { cohortId, stageId } = await newCohort()
    const twice = await newStudent(cohortId) // 兩份都逾期：欠繳只算 1 次
    const exempted = await newStudent(cohortId) // I1 免繳
    const removed = await newStudent(cohortId) // I1、I2 已移出
    const reopened = await newStudent(cohortId) // I1 逾期但補交期限在未來
    const done = await newStudent(cohortId) // 都交了
    const lateGroup = await newGroup(cohortId, `LA-${seq}`, [twice, exempted])
    const okGroup = await newGroup(cohortId, `OK-${seq}`, [reopened, done])

    const i1 = await published(cohortId, stageId, { title: 'I1 已截止', dueAt: PAST_DUE })
    const i2 = await published(cohortId, stageId, { title: 'I2 已截止', dueAt: PAST_DUE })
    const g1 = await published(cohortId, stageId, { title: 'G1 整組已截止', dueAt: PAST_DUE, receiverUnit: 'group' })
    const g2 = await published(cohortId, stageId, { title: 'G2 整組未截止', receiverUnit: 'group' })
    const open: string[] = []
    for (const n of [3, 4, 5, 6]) open.push(await published(cohortId, stageId, { title: `I${n} 未截止` }))

    // 不該出現的：草稿、已下架、已下架再刪除、別屆、公告（不收件）。
    await items.create(adminActor(), input(cohortId, stageId, { title: '還是草稿' }), randomUUID())
    const archived = await published(cohortId, stageId, { title: '已下架', dueAt: PAST_DUE })
    const deleted = await published(cohortId, stageId, { title: '已刪除', dueAt: PAST_DUE })
    await owner.sql(`update managed_items set status = 'archived' where id = any($1::uuid[])`, [[archived, deleted]])
    await owner.sql('update managed_items set deleted_at = now(), deleted_by_user_id = $2 where id = $1', [deleted, adminId])
    const news = await published(cohortId, stageId, { title: '改成公告', dueAt: PAST_DUE })
    await owner.sql(`update managed_items set placement = 'news', receiver_unit = 'none' where id = $1`, [news])
    const other = await newCohort()
    await newStudent(other.cohortId)
    await published(other.cohortId, other.stageId, { title: '別屆', dueAt: PAST_DUE })

    // 截止前：交件、草稿。
    for (const s of [done, exempted, reopened]) await submit(s, i2)
    await submit(done, i1)
    await submit(done, g1)
    await submissions.saveDraft(studentActor(done), open[0]!, 0, { topic: '還在想' }, randomUUID())
    await submit(done, open[1]!)

    await owner.sql(`update response_rosters set exempt = true, exempt_reason = '休學' where item_id = $1 and receiver_id = $2`, [
      i1,
      exempted.id,
    ])
    await owner.sql(
      `update response_rosters set eligible_to_business_at = eligible_from_business_at + interval '1 day', removed_reason = '退出專題'
        where item_id = any($1::uuid[]) and receiver_id = $2`,
      [[i1, i2], removed.id],
    )

    businessNow = AFTER
    const opened = await submissions.reopen(adminActor(), i1, reopened.id, { dueAt: REOPEN_DUE, reason: '住院請假' }, randomUUID())
    if (!opened.ok) throw new Error(`${opened.code} ${opened.message}`)

    return { cohortId, i1, i2, g1, g2, open, twice, exempted, removed, reopened, done, lateGroup, okGroup }
  }

  it('免繳不在分母、移出不計、補交期限未到不算逾期、兩份都逾期只算 1 次、逾期的組算進「組」', async () => {
    const s = await eightItemCohort()
    const { result, sql } = await countedFacts(s.cohortId)
    expect(sql).toBe(2)
    const rosters = await rostersOneByOne(s.cohortId)
    expect(rosters).toHaveLength(8)

    // 同一批項目、同一個順序（首頁完成率列表取前幾份，順序要跟原本一樣）。
    expect(result.map((f) => f.item.itemId)).toEqual(rosters.map((r) => r.item.itemId))
    for (const [index, f] of result.entries()) {
      const r = rosters[index]!
      expect(f.item).toEqual({ itemId: r.item.itemId, title: r.item.title, receiverUnit: r.item.receiverUnit, opensAt: r.item.opensAt, dueAt: r.item.dueAt })
      expect(completionOf(f.item, f.entries, businessNow)).toEqual(completionOf(r.item, r.entries, businessNow))
    }
    const overdue = overdueReceiverIds(result, businessNow)
    expect(overdue).toEqual(overdueReceiverIds(rosters, businessNow))
    const individual = <T extends { item: { receiverUnit: string } }>(list: readonly T[]) => list.filter((x) => x.item.receiverUnit === 'individual')
    expect(overdueReceiverIds(individual(result), businessNow)).toEqual(overdueReceiverIds(individual(rosters), businessNow))

    // 規則本身（防兩邊一起錯）：欠繳的是 twice 一人（兩份只算 1 次）＋ lateGroup 一組。
    expect([...overdue].sort()).toEqual([s.twice.id, s.lateGroup].sort())
    expect(overdueReceiverIds(individual(result), businessNow).size).toBe(1)
    const i1 = result.find((f) => f.item.itemId === s.i1)!
    // I1：分母 twice、reopened、done；done 交了；twice 逾期；reopened 補交中不算逾期；exempted 免繳；removed 移出。
    expect(completionOf(i1.item, i1.entries, businessNow)).toMatchObject({ required: 3, done: 1, overdue: 1, pending: 1, exempt: 1, removed: 1 })
    const g1 = result.find((f) => f.item.itemId === s.g1)!
    expect(completionOf(g1.item, g1.entries, businessNow)).toMatchObject({ required: 2, done: 1, overdue: 1 })
  })

  it('回傳的 entries 不含姓名、學號、組別代碼', async () => {
    const s = await eightItemCohort()
    const { result } = await countedFacts(s.cohortId)
    for (const f of result) {
      for (const entry of f.entries) {
        expect(Object.keys(entry).sort()).toEqual(['eligibleTo', 'exempt', 'hasDraft', 'latestVersionNo', 'receiverId', 'reopenUntil'])
      }
    }
    const open3 = result.find((f) => f.item.itemId === s.open[0])!
    expect(open3.entries.find((e) => e.receiverId === s.done.id)).toMatchObject({ hasDraft: true, latestVersionNo: null })
    const i1 = result.find((f) => f.item.itemId === s.i1)!
    expect(i1.entries.find((e) => e.receiverId === s.reopened.id)?.reopenUntil).toBeInstanceOf(Date)
  })

  it('只有系辦拿得到：老師、學生、未登入、錯的屆別 id 都是空陣列', async () => {
    const cohortId = await cohortWithItems(1)
    const student = (await owner.sql('select user_id from student_identities where cohort_id = $1 limit 1', [cohortId])).rows[0]!
    const teacher: ResolvedActor = { kind: 'authenticated', userId: teacherId, roles: ['teacher'], status: 'active', mustChangePassword: false, cohortMemberships: [] }
    const anonymous: ResolvedActor = { kind: 'anonymous' }
    for (const actor of [teacher, studentActor({ id: String(student.user_id), cohortId }), anonymous]) {
      expect(await facts.completionFacts(actor, cohortId)).toEqual([])
    }
    expect(await facts.completionFacts(adminActor(), 'not-a-uuid')).toEqual([])
    expect(await facts.completionFacts(adminActor(), randomUUID())).toEqual([])
  })
})
