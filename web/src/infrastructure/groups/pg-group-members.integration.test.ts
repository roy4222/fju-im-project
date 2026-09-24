import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import {
  assertTestDatabaseReachable,
  createIsolatedDatabase,
  poolAsRole,
  type IsolatedDatabase,
} from '../../../test/db'
import { createBarrier } from '../../../test/barrier'
import { enableFaultInjection, injectFault } from '../../../test/fault-injection'
import { migratedSchema } from '../../../test/migrations'
import type { ResolvedActor } from '@/application/accounts'
import { PgGroupCommand, PgGroupQuery } from '@/infrastructure/groups/pg-groups'
import { PgDueWorkScheduler } from '@/infrastructure/notifications/pg-due-work-scheduler'
import { PgEventPublisher } from '@/infrastructure/notifications/pg-event-publisher'
import { PgAuditWriter } from '@/infrastructure/ops/audit-writer'
import { PgOperationLedger } from '@/infrastructure/ops/operation-ledger'

/**
 * 票 14：每組人數設定、管理員調整組員與換組長（產品模組 03 §5.2 的 2026-09-24 定案、「組長」、§5.5；GRP-13(a)、GRP-18）。
 *
 * 全部以正式執行角色 `fju_app` 連線（組員／組長列只能改結束欄，寫錯的話這裡直接紅）。
 * 兩條不變量每案都核對：「占用列 ⇔ 提案 open」「每組恰一位有效組長、而且是有效成員」。
 * 並發用同步屏障與故障注入點會合，不用 sleep。
 */

let owner: IsolatedDatabase
let app: Pool
let adminId: string
let businessNow = new Date('2026-09-20T02:00:00Z')
const businessClock = { now: async () => new Date(businessNow.getTime()) }

let groups: PgGroupCommand
let query: PgGroupQuery

type Student = { id: string; studentNo: string; name: string; cohortId: string }

function studentActor(s: Student): ResolvedActor {
  return {
    kind: 'authenticated',
    userId: s.id,
    roles: ['student'],
    status: 'active',
    mustChangePassword: false,
    cohortMemberships: [{ cohortId: s.cohortId, role: 'student' }],
  }
}

function adminActor(): ResolvedActor {
  return { kind: 'authenticated', userId: adminId, roles: ['admin'], status: 'active', mustChangePassword: false, cohortMemberships: [] }
}

let cohortSeq = 0
async function newCohort(size = { min: 5, max: 5 }): Promise<string> {
  cohortSeq += 1
  const cohort = await owner.sql(
    `insert into cohorts (id, code, name, status, year_end_date, group_size_min, group_size_max, proposal_default_days, created_by_kind)
     values (gen_random_uuid(), $1, $1, 'active', '2027-06-30', $2, $3, 7, 'system') returning id`,
    [`G14-${cohortSeq}`, size.min, size.max],
  )
  const cohortId = String(cohort.rows[0]!.id)
  for (const [i, [name, date]] of [
    ['成組期', '2026-09-15'],
    ['期中', '2026-11-01'],
    ['期末', '2027-01-10'],
    ['成果', '2027-03-01'],
  ].entries()) {
    await owner.sql(
      `insert into cohort_stages (id, cohort_id, seq, name, start_date, created_by_kind)
       values (gen_random_uuid(), $1, $2, $3, $4, 'system')`,
      [cohortId, i + 1, name, date],
    )
  }
  return cohortId
}

let studentSeq = 0
async function newStudent(cohortId: string, options: { status?: string; displayName?: string } = {}): Promise<Student> {
  studentSeq += 1
  const studentNo = `41400${String(studentSeq).padStart(4, '0')}`
  const name = `組員${studentSeq}`
  const email = `m${studentSeq}-members@example.com`
  const user = await owner.sql(
    `insert into users (id, name, email, email_verified, updated_at, status)
     values (gen_random_uuid(), $1, $2, true, now(), $3) returning id`,
    [name, email, options.status ?? 'active'],
  )
  const id = String(user.rows[0]!.id)
  await owner.sql(
    `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at)
     values (gen_random_uuid(), $1, 'student', $2, now())`,
    [id, adminId],
  )
  await owner.sql(
    `insert into user_profiles (user_id, display_name, name_normalized, student_no, cohort_id, phone, contact_email)
     values ($1, $2, $3, $4, $5, '0912345678', $6)`,
    [id, options.displayName ?? name, name, studentNo, cohortId, `contact-${email}`],
  )
  await owner.sql(`insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)`, [cohortId, studentNo, id])
  return { id, studentNo, name, cohortId }
}

async function students(cohortId: string, n: number): Promise<Student[]> {
  const list: Student[] = []
  for (let i = 0; i < n; i += 1) list.push(await newStudent(cohortId))
  return list
}

async function mustPropose(proposer: Student, others: Student[]): Promise<string> {
  const result = await groups.propose(
    studentActor(proposer),
    { groupType: 'general', memberStudentNos: others.map((s) => s.studentNo) },
    randomUUID(),
  )
  if (!result.ok) throw new Error(`${result.code} ${result.message}`)
  return result.receipt.proposalId
}

/** 走一次真的提案＋全員確認，成立一組；第一位是提案人＝組長。 */
async function establishGroup(members: Student[]): Promise<{ groupId: string; code: string }> {
  const proposalId = await mustPropose(members[0]!, members.slice(1))
  for (const m of members) {
    const confirmed = await groups.confirm(studentActor(m), proposalId, randomUUID())
    if (!confirmed.ok) throw new Error(`${confirmed.code} ${confirmed.message}`)
  }
  const row = await owner.sql(
    `select g.id, g.code from group_proposals p join groups g on g.id = p.established_group_id where p.id = $1`,
    [proposalId],
  )
  return { groupId: String(row.rows[0]!.id), code: String(row.rows[0]!.code) }
}

async function revisionOf(groupId: string): Promise<number> {
  return Number((await owner.sql('select revision from groups where id = $1', [groupId])).rows[0]!.revision)
}

async function count(sql: string, values: unknown[] = []): Promise<number> {
  return Number((await owner.sql(sql, values)).rows[0]!.n)
}

async function activeMemberIds(groupId: string): Promise<string[]> {
  const rows = await owner.sql('select user_id from group_memberships where group_id = $1 and valid_to is null order by user_id', [groupId])
  return rows.rows.map((r) => String(r.user_id))
}

/** 不變量：每組恰一位有效組長，而且是有效成員。 */
async function expectOneLeaderWhoIsMember(groupId: string): Promise<string> {
  const leaders = await owner.sql('select user_id from group_leaders where group_id = $1 and valid_to is null', [groupId])
  expect(leaders.rows).toHaveLength(1)
  const leaderId = String(leaders.rows[0]!.user_id)
  expect(await activeMemberIds(groupId)).toContain(leaderId)
  return leaderId
}

/** 不變量：占用列 ⇔ 提案 open（占用列都指向 open 提案；open 提案的每位受邀者都被它占著）。 */
async function expectOccupancyMatchesOpenProposals(): Promise<void> {
  expect(
    await count(`select count(*) as n from proposal_occupancy o join group_proposals p on p.id = o.proposal_id where p.state <> 'open'`),
  ).toBe(0)
  expect(
    await count(`select count(*) as n from proposal_invitations i join group_proposals p on p.id = i.proposal_id
                  where p.state = 'open'
                    and not exists (select 1 from proposal_occupancy o where o.user_id = i.user_id and o.proposal_id = p.id)`),
  ).toBe(0)
}

async function eventsOf(type: string, groupId: string) {
  const rows = await owner.sql(
    `select recipients, payload from domain_events where type = $1 and source_id = $2 order by occurred_real_at, id`,
    [type, groupId],
  )
  return rows.rows.map((r) => ({ recipients: [...(r.recipients as string[])].sort(), payload: r.payload as Record<string, unknown> }))
}

function addMember(groupId: string, revision: number, student: Student, reason = '系上安排加入', requestId = randomUUID()) {
  return groups.addMember(adminActor(), { groupId, revision, studentNo: student.studentNo, reason }, requestId)
}

beforeAll(async () => {
  await assertTestDatabaseReachable()
  owner = await createIsolatedDatabase({ label: 'group_members', setup: migratedSchema })
  app = await poolAsRole(owner, 'fju_app')
  groups = new PgGroupCommand({
    audit: new PgAuditWriter(),
    ledger: new PgOperationLedger(() => app),
    events: new PgEventPublisher(),
    dueWork: new PgDueWorkScheduler({ testKindsEnabled: false }),
    businessClock,
    pool: () => app,
  })
  query = new PgGroupQuery(() => app)
  const staff = await owner.sql(
    `insert into users (id, name, email, email_verified, updated_at, status)
     values (gen_random_uuid(), 'A1', 'a1-members@example.com', true, now(), 'active') returning id`,
  )
  adminId = String(staff.rows[0]!.id)
})

afterAll(async () => {
  await app?.end()
  await owner?.close()
})

afterEach(async () => {
  businessNow = new Date('2026-09-20T02:00:00Z')
  await expectOccupancyMatchesOpenProposals()
})

describe('加入組員', () => {
  it('把未分組學生加入五人組：成功但提醒「人數與設定不符」；全組（含新成員）收到異動事件；理由進稽核與歷程', async () => {
    const cohortId = await newCohort()
    const members = await students(cohortId, 5)
    const { groupId, code } = await establishGroup(members)
    const newcomer = await newStudent(cohortId)
    const before = await revisionOf(groupId)

    const result = await addMember(groupId, before, newcomer, '轉學生，系上安排')
    expect(result).toMatchObject({
      ok: true,
      receipt: { groupCode: code, change: 'added', memberCount: 6, sizeWarning: '人數與設定不符：6 人，超過本屆每組最多 5 人' },
    })
    expect(await activeMemberIds(groupId)).toContain(newcomer.id)
    expect(await revisionOf(groupId)).toBe(before + 1)
    const membership = await owner.sql(
      `select added_by_kind, added_by_user_id from group_memberships where group_id = $1 and user_id = $2`,
      [groupId, newcomer.id],
    )
    expect(membership.rows[0]).toMatchObject({ added_by_kind: 'user', added_by_user_id: adminId })

    const [event] = await eventsOf('group.members_changed', groupId)
    expect(event!.recipients).toEqual([...members, newcomer].map((s) => s.id).sort())
    expect(JSON.stringify(event!.payload)).not.toContain('轉學生')
    const audit = await owner.sql(`select reason, role from audit_events where action = 'group.member.add' and target_id = $1`, [groupId])
    expect(audit.rows[0]).toMatchObject({ reason: '轉學生，系上安排', role: 'admin' })

    const overview = await query.overview(cohortId)
    const group = overview.groups.find((g) => g.id === groupId)!
    expect(group.members).toHaveLength(6)
    expect(group.history).toEqual([
      expect.objectContaining({ kind: 'member_added', userName: newcomer.name, byName: 'A1', reason: '轉學生，系上安排' }),
    ])
    expect(overview.ungrouped.map((u) => u.studentNo)).not.toContain(newcomer.studentNo)
    // 學生看得到歷程，但看不到理由與操作者。
    const view = await query.studentView(newcomer.id, cohortId)
    expect(view.group?.history).toEqual([expect.objectContaining({ kind: 'member_added', byName: null, reason: null })])
    await expectOneLeaderWhoIsMember(groupId)
  })

  it('資格：他屆、停用、學號不存在 → VALIDATION_FAILED；已在別組／本組 → ALREADY_MEMBER；都不留任何寫入', async () => {
    const cohortId = await newCohort({ min: 2, max: 5 })
    const g1 = await establishGroup(await students(cohortId, 2))
    const g2Members = await students(cohortId, 2)
    await establishGroup(g2Members)
    const otherCohort = await newCohort()
    const outsider = await newStudent(otherCohort)
    const disabled = await newStudent(cohortId, { status: 'disabled' })
    const revision = await revisionOf(g1.groupId)

    for (const who of [outsider, disabled]) {
      expect(await addMember(g1.groupId, revision, who)).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    }
    expect(
      await groups.addMember(adminActor(), { groupId: g1.groupId, revision, studentNo: '999999999', reason: '測試' }, randomUUID()),
    ).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    const elsewhere = await addMember(g1.groupId, revision, g2Members[1]!)
    expect(elsewhere).toMatchObject({ ok: false, code: 'ALREADY_MEMBER' })
    if (!elsewhere.ok) expect(elsewhere.message).toContain('一人同屆只能在一組')
    const g1Members = await activeMemberIds(g1.groupId)
    expect(
      await groups.addMember(adminActor(), { groupId: g1.groupId, revision, studentNo: (await studentNoOf(g1Members[0]!))!, reason: '測試' }, randomUUID()),
    ).toMatchObject({ ok: false, code: 'ALREADY_MEMBER' })

    expect(await revisionOf(g1.groupId)).toBe(revision)
    expect(await count(`select count(*) as n from audit_events where action = 'group.member.add' and target_id = $1`, [g1.groupId])).toBe(0)
  })

  it('授權與輸入：非管理員 FORBIDDEN、理由空白 VALIDATION_FAILED、舊版本 CONFLICT；同一請求編號重送只加一次', async () => {
    const cohortId = await newCohort()
    const members = await students(cohortId, 5)
    const { groupId } = await establishGroup(members)
    const newcomer = await newStudent(cohortId)
    const revision = await revisionOf(groupId)

    expect(
      await groups.addMember(studentActor(members[0]!), { groupId, revision, studentNo: newcomer.studentNo, reason: '想加' }, randomUUID()),
    ).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(await addMember(groupId, revision, newcomer, '  ')).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    expect(await addMember(groupId, revision - 1, newcomer)).toMatchObject({ ok: false, code: 'CONFLICT' })

    const requestId = randomUUID()
    const first = await addMember(groupId, revision, newcomer, '系上安排', requestId)
    const again = await addMember(groupId, revision, newcomer, '系上安排', requestId)
    expect(first.ok && again.ok).toBe(true)
    expect(await count('select count(*) as n from group_memberships where user_id = $1', [newcomer.id])).toBe(1)
  })

  it('學生正在某份進行中提案：拒絕（INVITED_ELSEWHERE）、不替他終止提案；管理員作廢那份提案之後就能加入', async () => {
    const cohortId = await newCohort()
    const { groupId } = await establishGroup(await students(cohortId, 5))
    const others = await students(cohortId, 5)
    const proposalId = await mustPropose(others[0]!, others.slice(1))
    const revision = await revisionOf(groupId)

    const refused = await addMember(groupId, revision, others[2]!)
    expect(refused).toMatchObject({ ok: false, code: 'INVITED_ELSEWHERE' })
    if (!refused.ok) expect(refused.message).toContain('作廢')
    const proposal = await owner.sql('select state from group_proposals where id = $1', [proposalId])
    expect(proposal.rows[0]!.state).toBe('open')
    expect(await count('select count(*) as n from proposal_occupancy where proposal_id = $1', [proposalId])).toBe(5)

    const voided = await groups.voidProposal(adminActor(), proposalId, '要把其中一人調到別組', randomUUID())
    expect(voided.ok).toBe(true)
    expect(await addMember(groupId, revision, others[2]!)).toMatchObject({ ok: true, receipt: { memberCount: 6 } })
  })

  it('被一份已過期、背景工作還沒收的提案占著：先把它以逾期終止，再加入', async () => {
    const cohortId = await newCohort()
    const { groupId } = await establishGroup(await students(cohortId, 5))
    const others = await students(cohortId, 5)
    const proposalId = await mustPropose(others[0]!, others.slice(1))
    businessNow = new Date(businessNow.getTime() + 8 * 24 * 3600_000)

    expect(await addMember(groupId, await revisionOf(groupId), others[1]!)).toMatchObject({ ok: true })
    const proposal = await owner.sql('select state, termination_kind from group_proposals where id = $1', [proposalId])
    expect(proposal.rows[0]).toMatchObject({ state: 'terminated', termination_kind: 'expired' })
  })
})

async function studentNoOf(userId: string): Promise<string | undefined> {
  const rows = await owner.sql('select student_no from user_profiles where user_id = $1', [userId])
  return rows.rows[0]?.student_no as string | undefined
}

describe('移出組員', () => {
  it('移出普通成員：組員資格結束（留理由）、回到未分組；留下的人收異動事件，被移出的人只收本人說明；成員改變 → 重簽掛點事件', async () => {
    const cohortId = await newCohort()
    const members = await students(cohortId, 5)
    const { groupId, code } = await establishGroup(members)
    const target = members[3]!

    const result = await groups.removeMember(
      adminActor(),
      { groupId, revision: await revisionOf(groupId), userId: target.id, reason: '休學', successorLeaderUserId: null },
      randomUUID(),
    )
    expect(result).toMatchObject({
      ok: true,
      receipt: { groupCode: code, change: 'removed', memberCount: 4, sizeWarning: '人數與設定不符：4 人，少於本屆每組最少 5 人', newLeaderName: null },
    })
    const row = await owner.sql(
      `select valid_to, removal_reason from group_memberships where group_id = $1 and user_id = $2`,
      [groupId, target.id],
    )
    expect(row.rows[0]!.valid_to).not.toBeNull()
    expect(row.rows[0]!.removal_reason).toBe('休學')

    const [changed] = await eventsOf('group.members_changed', groupId)
    expect(changed!.recipients).toEqual(members.filter((m) => m !== target).map((m) => m.id).sort())
    const [removed] = await eventsOf('group.member_removed', groupId)
    expect(removed!.recipients).toEqual([target.id])
    expect(JSON.stringify([changed!.payload, removed!.payload])).not.toContain('休學')

    const overview = await query.overview(cohortId)
    expect(overview.ungrouped.map((u) => u.studentNo)).toContain(target.studentNo)
    expect(overview.groups.find((g) => g.id === groupId)!.history).toEqual([
      expect.objectContaining({ kind: 'member_removed', userName: target.name, byName: 'A1', reason: '休學' }),
    ])
    // 被移出的人回到沒有組的樣子。
    expect((await query.studentView(target.id, cohortId)).group).toBeNull()
    await expectOneLeaderWhoIsMember(groupId)
  })

  it('移出組長：沒指定接任被拒；指定接任就同一交易換組長，全程恰一位有效組長而且是成員', async () => {
    const cohortId = await newCohort()
    const members = await students(cohortId, 5)
    const { groupId } = await establishGroup(members)
    const [leader, successor] = [members[0]!, members[2]!]
    const revision = await revisionOf(groupId)

    const missing = await groups.removeMember(
      adminActor(),
      { groupId, revision, userId: leader.id, reason: '轉系', successorLeaderUserId: null },
      randomUUID(),
    )
    expect(missing).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    expect(await activeMemberIds(groupId)).toContain(leader.id)

    const done = await groups.removeMember(
      adminActor(),
      { groupId, revision, userId: leader.id, reason: '轉系', successorLeaderUserId: successor.id },
      randomUUID(),
    )
    expect(done).toMatchObject({ ok: true, receipt: { newLeaderName: successor.name, memberCount: 4 } })
    expect(await expectOneLeaderWhoIsMember(groupId)).toBe(successor.id)
    const history = (await query.overview(cohortId)).groups.find((g) => g.id === groupId)!.history
    expect(history.map((h) => h.kind).sort()).toEqual(['leader_changed', 'member_removed'])
    expect(history.find((h) => h.kind === 'leader_changed')).toMatchObject({ previousLeaderName: leader.name, userName: successor.name })
  })

  it('移出最後一人：要走解散（之後才開放），先擋下，組員與組長都不動', async () => {
    const cohortId = await newCohort({ min: 2, max: 5 })
    const [a, b] = await students(cohortId, 2)
    const { groupId } = await establishGroup([a!, b!])
    const first = await groups.removeMember(
      adminActor(),
      { groupId, revision: await revisionOf(groupId), userId: b!.id, reason: '休學', successorLeaderUserId: null },
      randomUUID(),
    )
    expect(first).toMatchObject({ ok: true, receipt: { memberCount: 1, sizeWarning: '人數與設定不符：1 人，少於本屆每組最少 2 人' } })

    const last = await groups.removeMember(
      adminActor(),
      { groupId, revision: await revisionOf(groupId), userId: a!.id, reason: '休學', successorLeaderUserId: null },
      randomUUID(),
    )
    expect(last).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    if (!last.ok) expect(last.message).toContain('解散')
    expect(await activeMemberIds(groupId)).toEqual([a!.id])
    expect(await expectOneLeaderWhoIsMember(groupId)).toBe(a!.id)
  })
})

describe('換組長', () => {
  it('換成另一位成員：舊列結束、新列帶理由；全組收到換組長事件；不發成員異動事件（不重簽）；歷程看得到', async () => {
    const cohortId = await newCohort()
    const members = await students(cohortId, 5)
    const { groupId, code } = await establishGroup(members)
    const revision = await revisionOf(groupId)

    const result = await groups.changeLeader(
      adminActor(),
      { groupId, revision, newLeaderUserId: members[1]!.id, reason: '原組長請辭，全組同意' },
      randomUUID(),
    )
    expect(result).toMatchObject({ ok: true, receipt: { groupCode: code, previousLeaderName: members[0]!.name, leaderName: members[1]!.name } })
    expect(await expectOneLeaderWhoIsMember(groupId)).toBe(members[1]!.id)
    expect(await revisionOf(groupId)).toBe(revision + 1)
    const rows = await owner.sql(
      `select user_id, valid_to is not null as ended, reason, changed_by_user_id from group_leaders where group_id = $1 order by created_at`,
      [groupId],
    )
    expect(rows.rows).toMatchObject([
      { user_id: members[0]!.id, ended: true, reason: null },
      { user_id: members[1]!.id, ended: false, reason: '原組長請辭，全組同意', changed_by_user_id: adminId },
    ])

    const [event] = await eventsOf('group.leader_changed', groupId)
    expect(event!.recipients).toEqual(members.map((m) => m.id).sort())
    expect(String(event!.payload.title)).toContain(members[1]!.name)
    expect(JSON.stringify(event!.payload)).not.toContain('請辭')
    expect(await eventsOf('group.members_changed', groupId)).toHaveLength(0)
    expect(await activeMemberIds(groupId)).toEqual(members.map((m) => m.id).sort())

    const history = (await query.overview(cohortId)).groups.find((g) => g.id === groupId)!.history
    expect(history).toEqual([
      expect.objectContaining({ kind: 'leader_changed', previousLeaderName: members[0]!.name, userName: members[1]!.name, reason: '原組長請辭，全組同意' }),
    ])
    const studentHistory = (await query.studentView(members[2]!.id, cohortId)).group!.history
    expect(studentHistory).toEqual([expect.objectContaining({ kind: 'leader_changed', userName: members[1]!.name, reason: null, byName: null })])
  })

  it('換成組外的人或現任組長被拒；非管理員 FORBIDDEN；理由必填', async () => {
    const cohortId = await newCohort()
    const members = await students(cohortId, 5)
    const { groupId } = await establishGroup(members)
    const outsider = await newStudent(cohortId)
    const revision = await revisionOf(groupId)
    const change = (actor: ResolvedActor, newLeaderUserId: string, reason = '測試') =>
      groups.changeLeader(actor, { groupId, revision, newLeaderUserId, reason }, randomUUID())

    expect(await change(adminActor(), outsider.id)).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    expect(await change(adminActor(), members[0]!.id)).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    expect(await change(studentActor(members[0]!), members[1]!.id)).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(await change(adminActor(), members[1]!.id, '')).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    expect(await expectOneLeaderWhoIsMember(groupId)).toBe(members[0]!.id)
  })
})

describe('屆別封存（含票 13 審查：確認、作廢也要檢查）', () => {
  it('封存後加入、移出、換組長、確認提案、作廢提案都回 COHORT_ARCHIVED，什麼都沒寫', async () => {
    const cohortId = await newCohort()
    const members = await students(cohortId, 5)
    const { groupId } = await establishGroup(members)
    const others = await students(cohortId, 5)
    const proposalId = await mustPropose(others[0]!, others.slice(1))
    const newcomer = await newStudent(cohortId)
    const revision = await revisionOf(groupId)
    await owner.sql(`update cohorts set status = 'archived' where id = $1`, [cohortId])

    const results = [
      await addMember(groupId, revision, newcomer),
      await groups.removeMember(adminActor(), { groupId, revision, userId: members[4]!.id, reason: '休學', successorLeaderUserId: null }, randomUUID()),
      await groups.changeLeader(adminActor(), { groupId, revision, newLeaderUserId: members[1]!.id, reason: '換人' }, randomUUID()),
      await groups.confirm(studentActor(others[1]!), proposalId, randomUUID()),
      await groups.voidProposal(adminActor(), proposalId, '封存後清理', randomUUID()),
    ]
    expect(results.map((r) => (r.ok ? 'ok' : r.code))).toEqual(Array(5).fill('COHORT_ARCHIVED'))
    expect(await revisionOf(groupId)).toBe(revision)
    const invitation = await owner.sql('select state from proposal_invitations where proposal_id = $1 and user_id = $2', [proposalId, others[1]!.id])
    expect(invitation.rows[0]!.state).toBe('pending')
    await owner.sql(`update cohorts set status = 'active' where id = $1`, [cohortId])
  })
})

describe('找組員名單（票 13 審查：顯示名稱空白時退回帳號名稱）', () => {
  it('display_name 是空字串 → 名單顯示帳號名稱，不會是空的', async () => {
    const cohortId = await newCohort()
    const viewer = await newStudent(cohortId)
    const blank = await newStudent(cohortId, { displayName: '  ' })
    await groups.setOpenToJoin(studentActor(blank), true, randomUUID())
    const listing = await query.teammates(studentActor(viewer), cohortId)
    expect(listing.find((t) => t.studentNo === blank.studentNo)?.name).toBe(blank.name)
  })

  it('成員列、歷程、事件標題也一樣（票 14 審查建議：統一走 personName）', async () => {
    const cohortId = await newCohort()
    const members = await students(cohortId, 5)
    const { groupId } = await establishGroup(members)
    const newcomer = await newStudent(cohortId, { displayName: '' })
    expect((await addMember(groupId, await revisionOf(groupId), newcomer)).ok).toBe(true)
    // 組員的顯示名稱事後被清成空白（例如資料修正）也一樣。
    const leader = members[1]!
    await owner.sql(`update user_profiles set display_name = '   ' where user_id = $1`, [leader.id])
    expect((await groups.changeLeader(adminActor(), { groupId, revision: await revisionOf(groupId), newLeaderUserId: leader.id, reason: '換人' }, randomUUID())).ok).toBe(true)

    const [added] = await eventsOf('group.members_changed', groupId)
    expect(String(added!.payload.title)).toContain(newcomer.name)
    const [changed] = await eventsOf('group.leader_changed', groupId)
    expect(String(changed!.payload.title)).toBe(`組別 ${(await query.overview(cohortId)).groups.find((g) => g.id === groupId)!.code} 的組長換成 ${leader.name}`)

    const group = (await query.overview(cohortId)).groups.find((g) => g.id === groupId)!
    const names = group.members.map((m) => m.name)
    expect(names).toContain(newcomer.name)
    expect(names).toContain(leader.name)
    expect(names.every((n) => n.trim().length > 0)).toBe(true)
    expect(group.history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'member_added', userName: newcomer.name }),
        expect.objectContaining({ kind: 'leader_changed', userName: leader.name }),
      ]),
    )
    const mine = (await query.studentView(newcomer.id, cohortId)).group!
    expect(mine.members.map((m) => m.name).every((n) => n.trim().length > 0)).toBe(true)
    expect(mine.history.map((h) => h.userName)).toEqual(expect.arrayContaining([newcomer.name, leader.name]))
  })
})

describe('並發', () => {
  function commandWith(pool: () => { connect: () => ReturnType<Pool['connect']> }) {
    return new PgGroupCommand({
      audit: new PgAuditWriter(),
      ledger: new PgOperationLedger(() => app),
      events: new PgEventPublisher(),
      dueWork: new PgDueWorkScheduler({ testKindsEnabled: false }),
      businessClock,
      pool: pool as never,
    })
  }

  /** 讓兩筆交易都開始了才一起往下走：借連線、BEGIN 之後在屏障會合。 */
  function barrierPool(parties: number) {
    const barrier = createBarrier(parties)
    return () => ({
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
    })
  }

  /** 等到有交易卡在某種鎖上（pg_locks 對所有角色都看得到）。 */
  async function waitForLockWait(locktype: string): Promise<void> {
    for (let i = 0; i < 300; i += 1) {
      const waiting = await owner.sql(`select count(*) as n from pg_locks where not granted and locktype = $1`, [locktype])
      if (Number(waiting.rows[0]!.n) > 0) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`等不到 ${locktype} 鎖的等待`)
  }

  function hold(point: 'group.establish.after-release' | 'group.member.add.before-insert') {
    let reached!: () => void
    const arrived = new Promise<void>((resolve) => (reached = resolve))
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    injectFault(point, async () => {
      reached()
      await held
    })
    return { arrived, release }
  }

  it('學生最後一位確認、組別成立中，管理員同時把其中一人加到別組：加人被拒（他還被提案占著），成立照常，他只有一個有效組', async () => {
    const cohortId = await newCohort()
    const { groupId: otherGroup } = await establishGroup(await students(cohortId, 5))
    const proposers = await students(cohortId, 5)
    const proposalId = await mustPropose(proposers[0]!, proposers.slice(1))
    for (const m of proposers.slice(0, 4)) await groups.confirm(studentActor(m), proposalId, randomUUID())
    const revision = await revisionOf(otherGroup)

    const disable = enableFaultInjection()
    try {
      const establishing = hold('group.establish.after-release')
      const confirming = groups.confirm(studentActor(proposers[4]!), proposalId, randomUUID())
      await establishing.arrived
      // 成立那筆交易已寫好組員、刪了占用，但還沒 commit：別人看到的仍是「被提案占著」。
      const adding = await addMember(otherGroup, revision, proposers[2]!)
      establishing.release()
      expect(adding).toMatchObject({ ok: false, code: 'INVITED_ELSEWHERE' })
      expect(await confirming).toMatchObject({ ok: true, receipt: { outcome: 'established' } })
    } finally {
      disable()
    }
    expect(await count(`select count(*) as n from group_memberships where user_id = $1 and valid_to is null`, [proposers[2]!.id])).toBe(1)
    expect(await activeMemberIds(otherGroup)).not.toContain(proposers[2]!.id)
    expect(await revisionOf(otherGroup)).toBe(revision)

    // 成立之後再加：他已有組 → ALREADY_MEMBER。
    expect(await addMember(otherGroup, revision, proposers[2]!)).toMatchObject({ ok: false, code: 'ALREADY_MEMBER' })
  })

  it('管理員加人寫到一半、學生同時發起提案邀同一人：發起那邊等加人 commit 後看到他已有組 → ALREADY_MEMBER，不留一份註定衝突的提案', async () => {
    const cohortId = await newCohort()
    const { groupId } = await establishGroup(await students(cohortId, 5))
    const target = await newStudent(cohortId)
    const proposers = await students(cohortId, 4)
    const revision = await revisionOf(groupId)

    const disable = enableFaultInjection()
    try {
      const adding = hold('group.member.add.before-insert')
      const addResult = addMember(groupId, revision, target)
      await adding.arrived
      const proposing = groups.propose(
        studentActor(proposers[0]!),
        { groupType: 'general', memberStudentNos: [...proposers.slice(1), target].map((s) => s.studentNo) },
        randomUUID(),
      )
      await waitForLockWait('advisory')
      adding.release()
      expect(await addResult).toMatchObject({ ok: true, receipt: { memberCount: 6 } })
      expect(await proposing).toMatchObject({ ok: false, code: 'ALREADY_MEMBER' })
    } finally {
      disable()
    }
    expect(await count(`select count(*) as n from group_proposals where proposer_user_id = $1`, [proposers[0]!.id])).toBe(0)
    expect(await count(`select count(*) as n from proposal_occupancy where user_id = $1`, [target.id])).toBe(0)
  })

  it('兩位管理員同時把同一人加到兩個組：恰一個成功，另一個 ALREADY_MEMBER', async () => {
    const cohortId = await newCohort()
    const g1 = await establishGroup(await students(cohortId, 5))
    const g2 = await establishGroup(await students(cohortId, 5))
    const target = await newStudent(cohortId)
    const racing = commandWith(barrierPool(2))
    const add = (groupId: string, revision: number) =>
      racing.addMember(adminActor(), { groupId, revision, studentNo: target.studentNo, reason: '系上安排' }, randomUUID())
    const results = await Promise.all([add(g1.groupId, await revisionOf(g1.groupId)), add(g2.groupId, await revisionOf(g2.groupId))])
    expect(results.map((r) => (r.ok ? 'ok' : r.code)).sort()).toEqual(['ALREADY_MEMBER', 'ok'])
    expect(await count(`select count(*) as n from group_memberships where user_id = $1 and valid_to is null`, [target.id])).toBe(1)
  })

  it('兩位管理員拿同一版同時換組長：恰一個成功，另一個 CONFLICT；仍恰一位有效組長', async () => {
    const cohortId = await newCohort()
    const members = await students(cohortId, 5)
    const { groupId } = await establishGroup(members)
    const revision = await revisionOf(groupId)
    const racing = commandWith(barrierPool(2))
    const results = await Promise.all(
      [members[1]!, members[2]!].map((m) =>
        racing.changeLeader(adminActor(), { groupId, revision, newLeaderUserId: m.id, reason: '換人' }, randomUUID()),
      ),
    )
    expect(results.map((r) => (r.ok ? 'ok' : r.code)).sort()).toEqual(['CONFLICT', 'ok'])
    await expectOneLeaderWhoIsMember(groupId)
  })
})
