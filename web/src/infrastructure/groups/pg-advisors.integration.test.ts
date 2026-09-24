import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { assertTestDatabaseReachable, createIsolatedDatabase, poolAsRole, type IsolatedDatabase } from '../../../test/db'
import { createBarrier } from '../../../test/barrier'
import { enableFaultInjection, injectFault } from '../../../test/fault-injection'
import { migratedSchema } from '../../../test/migrations'
import type { ResolvedActor } from '@/application/accounts'
import { PgAdvisorCommand } from '@/infrastructure/groups/pg-advisors'
import { PgGroupCommand, PgGroupQuery } from '@/infrastructure/groups/pg-groups'
import { PgDueWorkScheduler } from '@/infrastructure/notifications/pg-due-work-scheduler'
import { PgEventPublisher } from '@/infrastructure/notifications/pg-event-publisher'
import { PgAuditWriter } from '@/infrastructure/ops/audit-writer'
import { FsFileStorage } from '@/infrastructure/ops/file-storage'
import { PgOperationLedger } from '@/infrastructure/ops/operation-ledger'

/**
 * 票 19：指導老師指派、認領與重派（產品模組 03 §4「5.4 指導老師規則」「行政指派的輸入」；
 * GRP-07、GRP-09、GRP-10、GRP-11、GRP-17）。
 *
 * 全部以正式執行角色 `fju_app` 連線（主指導列只能改結束欄，寫錯的話這裡直接紅）。
 * 每案結束都核對不變量「每組最多一位有效主指導」。並發用同步屏障與故障注入點會合，不用 sleep。
 */

let owner: IsolatedDatabase
let app: Pool
let root: string
let adminId: string
let storage: FsFileStorage
let businessNow = new Date('2026-09-25T02:00:00Z')
const businessClock = { now: async () => new Date(businessNow.getTime()) }

let advisors: PgAdvisorCommand
let groups: PgGroupCommand
let query: PgGroupQuery

function actor(userId: string, roles: ('admin' | 'teacher' | 'student')[]): ResolvedActor {
  return { kind: 'authenticated', userId, roles, status: 'active', mustChangePassword: false, cohortMemberships: [] }
}
const adminActor = () => actor(adminId, ['admin'])

function newAdvisorCommand(pool: () => Pick<Pool, 'connect'> = () => app) {
  return new PgAdvisorCommand({
    audit: new PgAuditWriter(),
    ledger: new PgOperationLedger(() => app),
    events: new PgEventPublisher(),
    files: storage,
    businessClock,
    pool,
  })
}

let seq = 0
async function newUser(name: string, email = `${name}-${(seq += 1)}-${randomUUID().slice(0, 8)}@example.com`): Promise<string> {
  const row = await owner.sql(
    `insert into users (id, name, email, email_verified, updated_at, status)
     values (gen_random_uuid(), $1, $2, true, now(), 'active') returning id`,
    [name, email],
  )
  return String(row.rows[0]!.id)
}

type Teacher = { id: string; name: string; email: string }
async function newTeacher(name: string, options: { contactEmail?: string } = {}): Promise<Teacher> {
  const email = `t${(seq += 1)}-${randomUUID().slice(0, 8)}@fju.edu.tw`
  const id = await newUser(name, email)
  await owner.sql(
    `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at)
     values (gen_random_uuid(), $1, 'teacher', $2, now())`,
    [id, adminId],
  )
  await owner.sql(
    `insert into user_profiles (user_id, display_name, name_normalized, contact_email, profile_completed_at)
     values ($1, $2, $2, $3, now())`,
    [id, name, options.contactEmail ?? email],
  )
  return { id, name, email }
}

async function newCohort(): Promise<string> {
  const row = await owner.sql(
    `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
     values (gen_random_uuid(), $1, $1, 'active', '2027-06-30', 'system') returning id`,
    [`T19-${(seq += 1)}`],
  )
  return String(row.rows[0]!.id)
}

type Student = { id: string; studentNo: string; name: string }
async function newStudent(cohortId: string): Promise<Student> {
  seq += 1
  const studentNo = `41419${String(seq).padStart(4, '0')}`
  const name = `學生${seq}`
  const id = await newUser(name)
  await owner.sql(
    `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at)
     values (gen_random_uuid(), $1, 'student', $2, now())`,
    [id, adminId],
  )
  await owner.sql(
    `insert into user_profiles (user_id, display_name, name_normalized, student_no, cohort_id, phone, contact_email)
     values ($1, $2, $2, $3, $4, '0912345678', $5)`,
    [id, name, studentNo, cohortId, `c${seq}@example.com`],
  )
  await owner.sql(`insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)`, [cohortId, studentNo, id])
  return { id, studentNo, name }
}

type Group = { id: string; code: string; members: Student[] }
/** 已成立的組別（成組流程是票 13 的事，這裡直接寫好成立後的樣子：組員、組長）。 */
async function newGroup(cohortId: string, code: string, type: 'general' | 'industry', size = 3): Promise<Group> {
  const members: Student[] = []
  for (let i = 0; i < size; i += 1) members.push(await newStudent(cohortId))
  const row = await owner.sql(
    `insert into groups (id, cohort_id, code, group_type, established_real_at, established_business_at, created_by_kind)
     values (gen_random_uuid(), $1, $2, $3, now(), $4, 'system') returning id`,
    [cohortId, code, type, businessNow],
  )
  const id = String(row.rows[0]!.id)
  for (const m of members) {
    await owner.sql(
      `insert into group_memberships (id, group_id, cohort_id, user_id, valid_from, added_by_kind)
       values (gen_random_uuid(), $1, $2, $3, $4, 'system')`,
      [id, cohortId, m.id, businessNow],
    )
  }
  await owner.sql(
    `insert into group_leaders (id, group_id, user_id, valid_from, changed_by_user_id) values (gen_random_uuid(), $1, $2, $3, $2)`,
    [id, members[0]!.id, businessNow],
  )
  return { id, code, members }
}

async function revisionOf(groupId: string): Promise<number> {
  return Number((await owner.sql('select revision from groups where id = $1', [groupId])).rows[0]!.revision)
}

async function advisorRows(groupId: string) {
  const rows = await owner.sql(
    `select id, teacher_user_id, source, valid_to, ended_real_at, ended_by_user_id, end_reason, reason, previous_assignment_id
       from advisor_assignments where group_id = $1 order by created_at, id`,
    [groupId],
  )
  return rows.rows
}

async function eventsOf(type: string, groupId: string) {
  const rows = await owner.sql(
    `select recipients, payload from domain_events where type = $1 and source_id = $2 order by occurred_real_at, id`,
    [type, groupId],
  )
  return rows.rows.map((r) => ({ recipients: [...(r.recipients as string[])].sort(), payload: r.payload as Record<string, unknown> }))
}

const ids = (...lists: ({ id: string } | { id: string }[])[]) =>
  lists.flatMap((l) => (Array.isArray(l) ? l.map((x) => x.id) : [l.id])).sort()

/** 不變量：每組最多一位有效主指導（部分唯一保證；這裡再數一次）。 */
async function expectAtMostOneActiveAdvisorPerGroup(): Promise<void> {
  const rows = await owner.sql(
    `select group_id from advisor_assignments where valid_to is null group by group_id having count(*) > 1`,
  )
  expect(rows.rows).toEqual([])
}

beforeAll(async () => {
  await assertTestDatabaseReachable()
  owner = await createIsolatedDatabase({ label: 'advisors', setup: migratedSchema })
  app = await poolAsRole(owner, 'fju_app')
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'fju-advisors-'))
  storage = new FsFileStorage({
    root: () => root,
    environmentMaxBytes: () => 100 * 1024 * 1024,
    ticketSecret: () => 'integration-secret-integration-secret',
    policies: {},
    db: () => app,
  })
  adminId = await newUser('A1')
  advisors = newAdvisorCommand()
  groups = new PgGroupCommand({
    audit: new PgAuditWriter(),
    ledger: new PgOperationLedger(() => app),
    events: new PgEventPublisher(),
    dueWork: new PgDueWorkScheduler({ testKindsEnabled: false }),
    businessClock,
    pool: () => app,
  })
  query = new PgGroupQuery(() => app)
})

afterAll(async () => {
  await app?.end()
  await owner?.close()
  if (root) await fs.rm(root, { recursive: true, force: true })
})

afterEach(async () => {
  businessNow = new Date('2026-09-25T02:00:00Z')
  await expectAtMostOneActiveAdvisorPerGroup()
})

describe('老師認領產學組（GRP-09、GRP-07）', () => {
  it('認領尚未指派的產學組：一列有效主指導、組別版本加一、全組與老師收到通知、學生與老師看到同一位', async () => {
    const cohortId = await newCohort()
    const group = await newGroup(cohortId, 'G01', 'industry')
    const t2 = await newTeacher('王老師')
    const before = await revisionOf(group.id)

    const result = await advisors.claim(actor(t2.id, ['teacher']), { groupId: group.id }, randomUUID())
    expect(result).toMatchObject({ ok: true, receipt: { change: 'claimed', groupCode: 'G01', teacherName: '王老師' } })

    const rows = await advisorRows(group.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ teacher_user_id: t2.id, source: 'claim', valid_to: null, reason: null })
    expect(await revisionOf(group.id)).toBe(before + 1)
    const [event] = await eventsOf('advisor.assigned', group.id)
    expect(event!.recipients).toEqual(ids(group.members, t2))
    const audit = await owner.sql(`select role, actor_user_id from audit_events where action = 'advisor.claim' and target_id = $1`, [
      group.id,
    ])
    expect(audit.rows[0]).toMatchObject({ role: 'teacher', actor_user_id: t2.id })

    const student = await query.studentView(group.members[1]!.id, cohortId)
    expect(student.group?.advisor).toMatchObject({ teacherUserId: t2.id, teacherName: '王老師', source: 'claim' })
    const teacherSees = (await query.cohortGroups(cohortId)).find((g) => g.id === group.id)!
    expect(teacherSees.advisor?.teacherUserId).toBe(t2.id)
    // 認領不自動建立或連結合作案。
    expect(Number((await owner.sql('select count(*) as n from opportunity_links')).rows[0]!.n)).toBe(0)
    expect(await query.advisedGroupCount(t2.id)).toBe(1)
  })

  it('一般組不能認領（由系辦指派）；不是老師不能認領；已經是自己的組再按一次說清楚', async () => {
    const cohortId = await newCohort()
    const general = await newGroup(cohortId, 'G01', 'general')
    const industry = await newGroup(cohortId, 'G02', 'industry')
    const t3 = await newTeacher('李老師')

    const denied = await advisors.claim(actor(t3.id, ['teacher']), { groupId: general.id }, randomUUID())
    expect(denied).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(denied.ok ? '' : denied.message).toContain('系辦依抽籤結果指派')
    const student = await advisors.claim(actor(general.members[0]!.id, ['student']), { groupId: industry.id }, randomUUID())
    expect(student).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(await advisorRows(general.id)).toHaveLength(0)

    await advisors.claim(actor(t3.id, ['teacher']), { groupId: industry.id }, randomUUID())
    const again = await advisors.claim(actor(t3.id, ['teacher']), { groupId: industry.id }, randomUUID())
    expect(again).toMatchObject({ ok: false, code: 'ALREADY_CLAIMED' })
    expect(again.ok ? '' : again.message).toContain('你已經是')
  })

  it('同一個請求編號重送：回同一張回執，不重複寫也不重複通知', async () => {
    const cohortId = await newCohort()
    const group = await newGroup(cohortId, 'G01', 'industry')
    const t2 = await newTeacher('王老師')
    const requestId = randomUUID()
    const first = await advisors.claim(actor(t2.id, ['teacher']), { groupId: group.id }, requestId)
    const second = await advisors.claim(actor(t2.id, ['teacher']), { groupId: group.id }, requestId)
    expect(second).toEqual(first)
    expect(await advisorRows(group.id)).toHaveLength(1)
    expect(await eventsOf('advisor.assigned', group.id)).toHaveLength(1)
  })
})

describe('並發認領（GRP-10）', () => {
  it('兩位老師同時按：恰一位成功，另一位 ALREADY_CLAIMED 而且訊息點名誰先認領；只有一列有效', async () => {
    const cohortId = await newCohort()
    const group = await newGroup(cohortId, 'G01', 'industry')
    const t2 = await newTeacher('王老師')
    const t3 = await newTeacher('李老師')

    // 兩筆交易都 BEGIN 了才一起往下搶組別列的鎖。
    const barrier = createBarrier(2)
    const racing = newAdvisorCommand(() => ({
      connect: async () => {
        const client = await app.connect()
        const original = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>
        let first = true
        ;(client as unknown as { query: (...args: unknown[]) => Promise<unknown> }).query = async (...args: unknown[]) => {
          const result = await original(...args)
          if (first && args[0] === 'begin') {
            first = false
            await barrier.arrive()
          }
          return result
        }
        const release = client.release.bind(client)
        client.release = (...args: Parameters<typeof release>) => {
          ;(client as unknown as { query: unknown }).query = original
          return release(...args)
        }
        return client
      },
    }))

    const results = await Promise.all([
      racing.claim(actor(t2.id, ['teacher']), { groupId: group.id }, randomUUID()),
      racing.claim(actor(t3.id, ['teacher']), { groupId: group.id }, randomUUID()),
    ])
    const winners = results.filter((r) => r.ok)
    const losers = results.filter((r) => !r.ok)
    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(1)
    expect(losers[0]).toMatchObject({ code: 'ALREADY_CLAIMED' })
    const winnerName = winners[0]!.ok ? winners[0]!.receipt.teacherName! : ''
    expect(losers[0]!.ok ? '' : losers[0]!.message).toContain(winnerName)

    const active = (await advisorRows(group.id)).filter((r) => r.valid_to === null)
    expect(active).toHaveLength(1)
    expect(await eventsOf('advisor.assigned', group.id)).toHaveLength(1)
  })

  it('後備防線：就算查完「還沒有」之後另一筆先寫進去，資料庫部分唯一也只讓一列成功，晚到的收到同一句衝突', async () => {
    const cohortId = await newCohort()
    const group = await newGroup(cohortId, 'G01', 'industry')
    const t2 = await newTeacher('王老師')
    const t3 = await newTeacher('李老師')

    const disable = enableFaultInjection()
    try {
      // 王老師的交易查完、還沒寫的那一刻，李老師的列（繞過鎖，直接以 owner 寫）先 commit。
      injectFault('advisor.claim.before-insert', async () => {
        await owner.sql(
          `insert into advisor_assignments (id, group_id, teacher_user_id, source, valid_from, assigned_by_user_id)
           values (gen_random_uuid(), $1, $2, 'claim', now(), $2)`,
          [group.id, t3.id],
        )
      })
      const result = await advisors.claim(actor(t2.id, ['teacher']), { groupId: group.id }, randomUUID())
      expect(result).toMatchObject({ ok: false, code: 'ALREADY_CLAIMED' })
    } finally {
      disable()
    }
    const active = (await advisorRows(group.id)).filter((r) => r.valid_to === null)
    expect(active.map((r) => r.teacher_user_id)).toEqual([t3.id])
    // 王老師那筆整個回滾：沒有他的事件、帳本、稽核。
    expect(await eventsOf('advisor.assigned', group.id)).toHaveLength(0)
    expect(
      Number((await owner.sql(`select count(*) as n from operation_records where operation_kind = 'advisor.claim' and actor_user_id = $1`, [t2.id])).rows[0]!.n),
    ).toBe(0)
  })
})

describe('管理員逐組指派、重派、解除（GRP-07、GRP-11）', () => {
  it('一般組指派：理由必填、帶版本；指派後學生看到同一位老師；歷程記理由（學生看不到）', async () => {
    const cohortId = await newCohort()
    const group = await newGroup(cohortId, 'G01', 'general')
    const t1 = await newTeacher('陳老師')
    const revision = await revisionOf(group.id)

    const noReason = await advisors.assign(
      adminActor(),
      { groupId: group.id, revision, teacherUserId: t1.id, reason: ' ', gradingSelections: [] },
      randomUUID(),
    )
    expect(noReason).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    const notAdmin = await advisors.assign(
      actor(t1.id, ['teacher']),
      { groupId: group.id, revision, teacherUserId: t1.id, reason: '抽籤', gradingSelections: [] },
      randomUUID(),
    )
    expect(notAdmin).toMatchObject({ ok: false, code: 'FORBIDDEN' })

    const done = await advisors.assign(
      adminActor(),
      { groupId: group.id, revision, teacherUserId: t1.id, reason: '115 抽籤結果', gradingSelections: [] },
      randomUUID(),
    )
    expect(done).toMatchObject({ ok: true, receipt: { change: 'assigned', teacherName: '陳老師', previousTeacherName: null } })
    expect((await advisorRows(group.id))[0]).toMatchObject({ source: 'admin', reason: '115 抽籤結果', teacher_user_id: t1.id })
    const [event] = await eventsOf('advisor.assigned', group.id)
    expect(event!.recipients).toEqual(ids(group.members, t1))
    expect(JSON.stringify(event!.payload)).not.toContain('抽籤')

    const admin = (await query.overview(cohortId)).groups.find((g) => g.id === group.id)!
    expect(admin.history).toEqual([
      expect.objectContaining({ kind: 'advisor_assigned', userName: '陳老師', byName: 'A1', reason: '115 抽籤結果' }),
    ])
    const student = await query.studentView(group.members[0]!.id, cohortId)
    expect(student.group?.advisor?.teacherName).toBe('陳老師')
    expect(student.group?.history).toEqual([expect.objectContaining({ kind: 'advisor_assigned', byName: null, reason: null })])
  })

  it('重派：舊列結束（誰、何時、理由）、新列指回舊列；全組與新老師一則、原老師另一則；評分指派不動；歷史保留', async () => {
    const cohortId = await newCohort()
    const group = await newGroup(cohortId, 'G03', 'industry')
    const t2 = await newTeacher('王老師')
    const t3 = await newTeacher('李老師')
    await advisors.claim(actor(t2.id, ['teacher']), { groupId: group.id }, randomUUID())
    const revision = await revisionOf(group.id)

    const stale = await advisors.assign(
      adminActor(),
      { groupId: group.id, revision: revision - 1, teacherUserId: t3.id, reason: '換老師', gradingSelections: [] },
      randomUUID(),
    )
    expect(stale).toMatchObject({ ok: false, code: 'CONFLICT' })
    const same = await advisors.assign(
      adminActor(),
      { groupId: group.id, revision, teacherUserId: t2.id, reason: '換老師', gradingSelections: [] },
      randomUUID(),
    )
    expect(same).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    const grading = await advisors.assign(
      adminActor(),
      { groupId: group.id, revision, teacherUserId: t3.id, reason: '換老師', gradingSelections: [randomUUID()] },
      randomUUID(),
    )
    expect(grading).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })

    businessNow = new Date('2026-10-01T02:00:00Z')
    const done = await advisors.assign(
      adminActor(),
      { groupId: group.id, revision, teacherUserId: t3.id, reason: '王老師休假', gradingSelections: [] },
      randomUUID(),
    )
    expect(done).toMatchObject({ ok: true, receipt: { change: 'reassigned', teacherName: '李老師', previousTeacherName: '王老師' } })

    const [old, current] = await advisorRows(group.id)
    expect(old).toMatchObject({ teacher_user_id: t2.id, ended_by_user_id: adminId, end_reason: '王老師休假' })
    expect(old!.valid_to).toEqual(businessNow)
    expect(old!.ended_real_at).not.toBeNull()
    expect(current).toMatchObject({ teacher_user_id: t3.id, source: 'admin', valid_to: null, previous_assignment_id: old!.id })

    const assigned = await eventsOf('advisor.assigned', group.id)
    expect(assigned.at(-1)!.recipients).toEqual(ids(group.members, t3))
    const [replaced] = await eventsOf('advisor.replaced', group.id)
    expect(replaced!.recipients).toEqual([t2.id])
    expect(JSON.stringify(replaced!.payload)).not.toContain('休假')
    expect(await owner.sql(`select 1 from audit_events where action = 'advisor.reassign' and target_id = $1`, [group.id])).toMatchObject({
      rowCount: 1,
    })

    const history = (await query.overview(cohortId)).groups.find((g) => g.id === group.id)!.history
    expect(history.map((h) => [h.kind, h.userName, h.previousAdvisorName])).toEqual([
      ['advisor_assigned', '王老師', null],
      ['advisor_assigned', '李老師', '王老師'],
    ])
    expect(await query.advisedGroupCount(t2.id)).toBe(0)
  })

  it('解除：舊列結束、組別變回尚未指派；全組與原老師收到通知；之後可以再指派（不算重派）', async () => {
    const cohortId = await newCohort()
    const group = await newGroup(cohortId, 'G01', 'general')
    const t1 = await newTeacher('陳老師')
    const t2 = await newTeacher('王老師')
    await advisors.assign(
      adminActor(),
      { groupId: group.id, revision: await revisionOf(group.id), teacherUserId: t1.id, reason: '抽籤', gradingSelections: [] },
      randomUUID(),
    )
    const none = await advisors.unassign(adminActor(), { groupId: group.id, revision: await revisionOf(group.id), reason: '' }, randomUUID())
    expect(none).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })

    const done = await advisors.unassign(
      adminActor(),
      { groupId: group.id, revision: await revisionOf(group.id), reason: '抽籤更正' },
      randomUUID(),
    )
    expect(done).toMatchObject({ ok: true, receipt: { change: 'unassigned', teacherName: null, previousTeacherName: '陳老師' } })
    expect((await advisorRows(group.id)).filter((r) => r.valid_to === null)).toHaveLength(0)
    const [event] = await eventsOf('advisor.unassigned', group.id)
    expect(event!.recipients).toEqual(ids(group.members, t1))
    const twice = await advisors.unassign(
      adminActor(),
      { groupId: group.id, revision: await revisionOf(group.id), reason: '再解除' },
      randomUUID(),
    )
    expect(twice).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })

    await advisors.assign(
      adminActor(),
      { groupId: group.id, revision: await revisionOf(group.id), teacherUserId: t2.id, reason: '重新抽籤', gradingSelections: [] },
      randomUUID(),
    )
    expect(await eventsOf('advisor.replaced', group.id)).toHaveLength(0)
    const history = (await query.overview(cohortId)).groups.find((g) => g.id === group.id)!.history
    expect(history.map((h) => [h.kind, h.userName, h.previousAdvisorName, h.reason])).toEqual([
      ['advisor_assigned', '陳老師', null, '抽籤'],
      ['advisor_removed', '陳老師', null, '抽籤更正'],
      ['advisor_assigned', '王老師', null, '重新抽籤'],
    ])
  })

  it('停用或不是老師的帳號不能被指派；老師選項只列有效老師', async () => {
    const cohortId = await newCohort()
    const group = await newGroup(cohortId, 'G01', 'general')
    const off = await newTeacher('離職老師')
    await owner.sql(`update users set status = 'disabled' where id = $1`, [off.id])
    const student = group.members[0]!
    for (const teacherUserId of [off.id, student.id]) {
      const result = await advisors.assign(
        adminActor(),
        { groupId: group.id, revision: await revisionOf(group.id), teacherUserId, reason: '抽籤', gradingSelections: [] },
        randomUUID(),
      )
      expect(result).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    }
    const options = await query.teacherOptions()
    expect(options.map((o) => o.userId)).not.toContain(off.id)
    expect(options.map((o) => o.userId)).not.toContain(student.id)
  })

  it('老師剛認領之後，管理員用舊畫面（舊版本）指派：CONFLICT，不會覆蓋認領', async () => {
    const cohortId = await newCohort()
    const group = await newGroup(cohortId, 'G01', 'industry')
    const t2 = await newTeacher('王老師')
    const t3 = await newTeacher('李老師')
    const seen = await revisionOf(group.id)
    await advisors.claim(actor(t2.id, ['teacher']), { groupId: group.id }, randomUUID())
    const result = await advisors.assign(
      adminActor(),
      { groupId: group.id, revision: seen, teacherUserId: t3.id, reason: '抽籤', gradingSelections: [] },
      randomUUID(),
    )
    expect(result).toMatchObject({ ok: false, code: 'CONFLICT' })
    expect((await advisorRows(group.id)).map((r) => r.teacher_user_id)).toEqual([t2.id])
  })
})

describe('票 14 遺留：成員異動通知補上主指導', () => {
  it('加入、移出組員時 group.members_changed 的收件人含目前主指導；被移出的人另收本人那一則', async () => {
    const cohortId = await newCohort()
    const group = await newGroup(cohortId, 'G01', 'general')
    const t1 = await newTeacher('陳老師')
    await advisors.assign(
      adminActor(),
      { groupId: group.id, revision: await revisionOf(group.id), teacherUserId: t1.id, reason: '抽籤', gradingSelections: [] },
      randomUUID(),
    )
    const newcomer = await newStudent(cohortId)
    const added = await groups.addMember(
      adminActor(),
      { groupId: group.id, revision: await revisionOf(group.id), studentNo: newcomer.studentNo, reason: '轉學生' },
      randomUUID(),
    )
    expect(added.ok).toBe(true)
    const removed = await groups.removeMember(
      adminActor(),
      { groupId: group.id, revision: await revisionOf(group.id), userId: group.members[2]!.id, reason: '休學', successorLeaderUserId: null },
      randomUUID(),
    )
    expect(removed.ok).toBe(true)

    const [afterAdd, afterRemove] = await eventsOf('group.members_changed', group.id)
    expect(afterAdd!.recipients).toEqual(ids(group.members, newcomer, t1))
    expect(afterRemove!.recipients).toEqual(ids(group.members.slice(0, 2), newcomer, t1))
    const [self] = await eventsOf('group.member_removed', group.id)
    expect(self!.recipients).toEqual([group.members[2]!.id])
  })
})

describe('批次指派 CSV（GRP-17）', () => {
  async function upload(text: string, name = 'advisors.csv'): Promise<string> {
    const bytes = new TextEncoder().encode(text)
    const ticket = await advisors.startBatchUpload(adminActor(), { fileName: name, declaredMime: 'text/csv', declaredSize: bytes.length })
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

  it('只有管理員能上傳、預覽、執行', async () => {
    const t = await newTeacher('王老師')
    expect(await advisors.startBatchUpload(actor(t.id, ['teacher']), { fileName: 'a.csv', declaredMime: 'text/csv', declaredSize: 10 })).toMatchObject({
      ok: false,
      code: 'FORBIDDEN',
    })
    expect(await advisors.previewBatch(actor(t.id, ['teacher']), { fileId: randomUUID(), cohortId: randomUUID() })).toMatchObject({
      ok: false,
      code: 'FORBIDDEN',
    })
  })

  it('六類預覽；有錯不能執行；修正後逐列執行、預覽後被改的那一組 CONFLICT；通知只發真的變更；重送不重複', async () => {
    const cohortId = await newCohort()
    const g1 = await newGroup(cohortId, 'G01', 'general')
    const g2 = await newGroup(cohortId, 'G02', 'general')
    const g3 = await newGroup(cohortId, 'G03', 'industry')
    const g5 = await newGroup(cohortId, 'G05', 'general')
    const g6 = await newGroup(cohortId, 'G06', 'general')
    const dissolved = await newGroup(cohortId, 'G04', 'general')
    await owner.sql(`update groups set status = 'dissolved', dissolved_real_at = now(), dissolve_reason = '測試' where id = $1`, [
      dissolved.id,
    ])
    const wang = await newTeacher('王老師', { contactEmail: 'wang.personal@gmail.com' })
    const lee = await newTeacher('李老師')
    const off = await newTeacher('離職老師')
    await owner.sql(`update users set status = 'disabled' where id = $1`, [off.id])
    // G02 已是王老師、G03 是李老師。
    for (const [g, t] of [
      [g2, wang],
      [g3, lee],
    ] as const) {
      const r = await advisors.assign(
        adminActor(),
        { groupId: g.id, revision: await revisionOf(g.id), teacherUserId: t.id, reason: '抽籤', gradingSelections: [] },
        randomUUID(),
      )
      expect(r.ok).toBe(true)
    }

    const messy = await upload(
      [
        'group_code,teacher_login_email',
        `G01,${wang.email}`,
        `G02,${wang.email}`,
        `G03,${wang.email}`,
        `G99,${wang.email}`,
        `G04,${wang.email}`,
        `G05,${off.email}`,
        'G06,wang.personal@gmail.com',
        `G05,${lee.email}`,
      ].join('\n'),
    )
    const preview = await advisors.previewBatch(adminActor(), { fileId: messy, cohortId })
    if (!preview.ok) throw new Error(preview.message)
    expect(preview.receipt.rows.map((r) => [r.groupCode, r.kind])).toEqual([
      ['G01', 'new'],
      ['G02', 'unchanged'],
      ['G03', 'reassign'],
      ['G99', 'group_missing'],
      ['G04', 'group_missing'],
      ['G05', 'duplicate'],
      ['G06', 'teacher_missing'],
      ['G05', 'duplicate'],
    ])
    const revisionsOf = (rows: typeof preview.receipt.rows) =>
      Object.fromEntries(rows.filter((r) => r.groupId).map((r) => [r.groupId!, r.groupRevision!]))
    const blocked = await advisors.executeBatch(
      adminActor(),
      { fileId: messy, cohortId, reason: '抽籤', confirmReassign: true, revisions: revisionsOf(preview.receipt.rows) },
      randomUUID(),
    )
    expect(blocked).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    expect(await advisorRows(g1.id)).toHaveLength(0)

    // 修正後重新上傳。
    const fixed = await upload(
      ['group_code,teacher_login_email', `G01,${wang.email}`, `G02,${wang.email}`, `G03,${wang.email}`, `G05,${lee.email}`, `G06,${lee.email}`].join(
        '\n',
      ),
    )
    const clean = await advisors.previewBatch(adminActor(), { fileId: fixed, cohortId })
    if (!clean.ok) throw new Error(clean.message)
    expect(clean.receipt.counts).toMatchObject({ new: 3, unchanged: 1, reassign: 1, group_missing: 0, teacher_missing: 0, duplicate: 0 })
    const revisions = revisionsOf(clean.receipt.rows)

    const unconfirmed = await advisors.executeBatch(
      adminActor(),
      { fileId: fixed, cohortId, reason: '115 抽籤', confirmReassign: false, revisions },
      randomUUID(),
    )
    expect(unconfirmed).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })

    // 預覽之後、執行之前，另一位管理員先把 G06 指派給王老師。
    const other = await advisors.assign(
      adminActor(),
      { groupId: g6.id, revision: await revisionOf(g6.id), teacherUserId: wang.id, reason: '臨時', gradingSelections: [] },
      randomUUID(),
    )
    expect(other.ok).toBe(true)

    const requestId = randomUUID()
    const run = await advisors.executeBatch(
      adminActor(),
      { fileId: fixed, cohortId, reason: '115 抽籤', confirmReassign: true, revisions },
      requestId,
    )
    if (!run.ok) throw new Error(run.message)
    expect(run.receipt.results.map((r) => [r.groupCode, r.outcome])).toEqual([
      ['G01', 'assigned'],
      ['G02', 'unchanged'],
      ['G03', 'reassigned'],
      ['G05', 'assigned'],
      ['G06', 'conflict'],
    ])
    expect(run.receipt.counts).toMatchObject({ assigned: 2, reassigned: 1, unchanged: 1, conflict: 1 })

    // G06 沒被舊預覽覆蓋。
    expect((await advisorRows(g6.id)).filter((r) => r.valid_to === null).map((r) => r.teacher_user_id)).toEqual([wang.id])
    expect((await advisorRows(g1.id))[0]).toMatchObject({ source: 'csv', reason: '115 抽籤', teacher_user_id: wang.id })
    // 通知只發真的變更：G02 沒有新事件；G03 的原老師另收一則。
    expect(await eventsOf('advisor.assigned', g2.id)).toHaveLength(1)
    expect((await eventsOf('advisor.assigned', g1.id))[0]!.recipients).toEqual(ids(g1.members, wang))
    expect((await eventsOf('advisor.replaced', g3.id))[0]!.recipients).toEqual([lee.id])
    const rowAudits = await owner.sql(`select count(*) as n from audit_events where action in ('advisor.assign','advisor.reassign') and payload->>'batchRequestId' = $1`, [
      requestId,
    ])
    expect(Number(rowAudits.rows[0]!.n)).toBe(3)
    expect(
      Number((await owner.sql(`select count(*) as n from audit_events where action = 'advisor.batch' and payload->>'requestId' = $1`, [requestId])).rows[0]!.n),
    ).toBe(1)

    // 同一個請求重送：每一列重播，不重複指派或通知（G06 仍是衝突）。
    const retry = await advisors.executeBatch(
      adminActor(),
      { fileId: fixed, cohortId, reason: '115 抽籤', confirmReassign: true, revisions },
      requestId,
    )
    if (!retry.ok) throw new Error(retry.message)
    expect(retry.receipt.results.map((r) => r.outcome)).toEqual(['assigned', 'unchanged', 'reassigned', 'assigned', 'conflict'])
    expect(await eventsOf('advisor.assigned', g1.id)).toHaveLength(1)
    expect(await eventsOf('advisor.assigned', g5.id)).toHaveLength(1)
    expect(await advisorRows(g5.id)).toHaveLength(1)
    expect(
      Number((await owner.sql(`select count(*) as n from audit_events where action = 'advisor.batch' and payload->>'requestId' = $1`, [requestId])).rows[0]!.n),
    ).toBe(1)
  })

  it('不是 UTF-8、別人的檔案、封存的屆別都拒絕', async () => {
    const cohortId = await newCohort()
    await newGroup(cohortId, 'G01', 'general')
    const big5 = await (async () => {
      const bytes = new Uint8Array([0x67, 0x72, 0x6f, 0x75, 0x70, 0x0a, 0xa4, 0xa4])
      const ticket = await advisors.startBatchUpload(adminActor(), { fileName: 'big5.csv', declaredMime: 'text/csv', declaredSize: bytes.length })
      if (!ticket.ok) throw new Error(ticket.message)
      const uploaded = await storage.upload(
        adminId,
        ticket.receipt.ticket,
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(bytes)
            c.close()
          },
        }),
        bytes.length,
      )
      return uploaded.ok ? uploaded.receipt.fileId : null
    })()
    if (big5) {
      const result = await advisors.previewBatch(adminActor(), { fileId: big5, cohortId })
      expect(result).toMatchObject({ ok: false })
    }

    const fileId = await upload('group_code,teacher_login_email\nG01,x@fju.edu.tw')
    const otherAdmin = await newUser('A2')
    expect(await advisors.previewBatch(actor(otherAdmin, ['admin']), { fileId, cohortId })).toMatchObject({ ok: false })
    await owner.sql(`update cohorts set status = 'archived' where id = $1`, [cohortId])
    expect(await advisors.previewBatch(adminActor(), { fileId, cohortId })).toMatchObject({ ok: false, code: 'COHORT_ARCHIVED' })
  })
})
