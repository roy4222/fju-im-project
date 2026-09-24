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
import { enableFaultInjection, failAt, injectFault } from '../../../test/fault-injection'
import { migratedSchema } from '../../../test/migrations'
import type { ResolvedActor } from '@/application/accounts'
import type { GroupType } from '@/application/groups'
import { PgCohortCommand, PgCohortStatusQuery } from '@/infrastructure/cohorts/pg-cohorts'
import { PgGroupCommand, PgGroupQuery } from '@/infrastructure/groups/pg-groups'
import { proposalExpiryDueWorkHandler } from '@/infrastructure/notifications/due-work-handlers'
import { PgDueWorkRunner } from '@/infrastructure/notifications/pg-due-work-runner'
import { PgDueWorkScheduler } from '@/infrastructure/notifications/pg-due-work-scheduler'
import { PgEventPublisher } from '@/infrastructure/notifications/pg-event-publisher'
import { PgAuditWriter } from '@/infrastructure/ops/audit-writer'
import { PgOperationLedger } from '@/infrastructure/ops/operation-ledger'

/**
 * 票 13：找組員、提案與成組（模組實作設計 03 §3、§6、§10；GRP-01、03、04、12）。
 *
 * 全部以正式執行角色 `fju_app` 連線：欄級 UPDATE 權限（邀請列只能改 state／decided_real_at、
 * 組員只能改結束欄）寫錯的話，這裡會直接紅。業務鐘是可以撥的假鐘。
 *
 * 並發用同步屏障與故障注入點會合，不用 sleep。
 */

let owner: IsolatedDatabase
let app: Pool
let adminId: string
let teacherId: string
let businessNow = new Date('2026-09-20T02:00:00Z')
const businessClock = { now: async () => new Date(businessNow.getTime()) }

let groups: PgGroupCommand
let query: PgGroupQuery
let cohorts: PgCohortCommand
let cohortQuery: PgCohortStatusQuery

// 成組期（第 1 階段）2026-09-15 起；第 2 階段 2026-11-01 開始 → 成組截止＝2026-11-01 00:00（臺灣）。
const GROUPING_DEADLINE = new Date('2026-10-31T16:00:00Z')
const DAY = 24 * 60 * 60 * 1000

type Student = { id: string; studentNo: string; name: string; email: string; cohortId: string }

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

function staffActor(userId: string, role: 'admin' | 'teacher'): ResolvedActor {
  return { kind: 'authenticated', userId, roles: [role], status: 'active', mustChangePassword: false, cohortMemberships: [] }
}

let cohortSeq = 0
async function newCohort(size = { min: 5, max: 5 }, days = 7): Promise<string> {
  cohortSeq += 1
  const cohort = await owner.sql(
    `insert into cohorts (id, code, name, status, year_end_date, group_size_min, group_size_max, proposal_default_days, created_by_kind)
     values (gen_random_uuid(), $1, $1, 'active', '2027-06-30', $2, $3, $4, 'system') returning id`,
    [`G13-${cohortSeq}`, size.min, size.max, days],
  )
  const cohortId = String(cohort.rows[0]!.id)
  const stages = [
    ['成組期', '2026-09-15'],
    ['期中', '2026-11-01'],
    ['期末', '2027-01-10'],
    ['成果', '2027-03-01'],
  ]
  for (const [i, [name, date]] of stages.entries()) {
    await owner.sql(
      `insert into cohort_stages (id, cohort_id, seq, name, start_date, created_by_kind)
       values (gen_random_uuid(), $1, $2, $3, $4, 'system')`,
      [cohortId, i + 1, name, date],
    )
  }
  return cohortId
}

let studentSeq = 0
async function newStudent(cohortId: string, options: { status?: string } = {}): Promise<Student> {
  studentSeq += 1
  const studentNo = `41300${String(studentSeq).padStart(4, '0')}`
  const name = `學生${studentSeq}`
  const email = `s${studentSeq}-groups@example.com`
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
     values ($1, $2, $2, $3, $4, '0912345678', $5)`,
    [id, name, studentNo, cohortId, `contact-${email}`],
  )
  await owner.sql(`insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)`, [
    cohortId,
    studentNo,
    id,
  ])
  return { id, studentNo, name, email: `contact-${email}`, cohortId }
}

async function students(cohortId: string, n: number): Promise<Student[]> {
  const list: Student[] = []
  for (let i = 0; i < n; i += 1) list.push(await newStudent(cohortId))
  return list
}

async function propose(proposer: Student, others: Student[], groupType: GroupType = 'general') {
  return groups.propose(
    studentActor(proposer),
    { groupType, memberStudentNos: others.map((s) => s.studentNo) },
    randomUUID(),
  )
}

async function mustPropose(proposer: Student, others: Student[]): Promise<string> {
  const result = await propose(proposer, others)
  if (!result.ok) throw new Error(`${result.code} ${result.message}`)
  return result.receipt.proposalId
}

async function count(sql: string, values: unknown[] = []): Promise<number> {
  return Number((await owner.sql(sql, values)).rows[0]!.n)
}

async function proposalRow(id: string) {
  return (
    await owner.sql(
      `select state, termination_kind, reason, closed_by_kind, established_group_id, expires_business_at
         from group_proposals where id = $1`,
      [id],
    )
  ).rows[0]!
}

async function invitationStates(proposalId: string): Promise<Record<string, string>> {
  const rows = await owner.sql('select user_id, state from proposal_invitations where proposal_id = $1', [proposalId])
  return Object.fromEntries(rows.rows.map((r) => [String(r.user_id), String(r.state)]))
}

async function dueWorkState(proposalId: string): Promise<string | undefined> {
  const rows = await owner.sql(
    `select state from due_work where kind = 'proposal_expiry' and subject_type = 'group_proposal' and subject_id = $1`,
    [proposalId],
  )
  return rows.rows[0]?.state as string | undefined
}

async function confirmAll(proposalId: string, members: Student[]) {
  let last
  for (const member of members) {
    last = await groups.confirm(studentActor(member), proposalId, randomUUID())
    if (!last.ok) throw new Error(`${last.code} ${last.message}`)
  }
  return last!
}

beforeAll(async () => {
  await assertTestDatabaseReachable()
  owner = await createIsolatedDatabase({ label: 'groups', setup: migratedSchema })
  app = await poolAsRole(owner, 'fju_app')

  const deps = {
    audit: new PgAuditWriter(),
    ledger: new PgOperationLedger(() => app),
    events: new PgEventPublisher(),
    dueWork: new PgDueWorkScheduler({ testKindsEnabled: false }),
    businessClock,
    pool: () => app,
  }
  groups = new PgGroupCommand(deps)
  query = new PgGroupQuery(() => app)
  cohorts = new PgCohortCommand(deps)
  cohortQuery = new PgCohortStatusQuery(() => app)

  const staff = await owner.sql(
    `insert into users (id, name, email, email_verified, updated_at, status)
     values (gen_random_uuid(), 'A1', 'a1-groups@example.com', true, now(), 'active'),
            (gen_random_uuid(), 'T1', 't1-groups@example.com', true, now(), 'active')
     returning id, name`,
  )
  adminId = String(staff.rows.find((r) => r.name === 'A1')!.id)
  teacherId = String(staff.rows.find((r) => r.name === 'T1')!.id)
})

afterAll(async () => {
  await app?.end()
  await owner?.close()
})

afterEach(() => {
  businessNow = new Date('2026-09-20T02:00:00Z')
})

describe('發起提案', () => {
  it('五人提案：全員占住、各一筆待確認邀請、排一件到期工作、全員收到邀請事件；到期＝發起＋7 天', async () => {
    const cohortId = await newCohort()
    const [s1, ...others] = await students(cohortId, 5)
    const result = await propose(s1!, others)
    expect(result).toMatchObject({ ok: true, receipt: { memberCount: 5 } })
    if (!result.ok) return
    const { proposalId, expiresBusinessAt } = result.receipt
    expect(expiresBusinessAt).toBe(new Date(businessNow.getTime() + 7 * DAY).toISOString())

    expect((await proposalRow(proposalId)).state).toBe('open')
    expect(Object.values(await invitationStates(proposalId))).toEqual(Array(5).fill('pending'))
    expect(await count('select count(*) as n from proposal_occupancy where proposal_id = $1', [proposalId])).toBe(5)
    expect(await dueWorkState(proposalId)).toBe('pending')

    const event = await owner.sql(
      `select recipients, payload from domain_events where type = 'proposal.invited' and source_id = $1`,
      [proposalId],
    )
    expect([...(event.rows[0]!.recipients as string[])].sort()).toEqual([s1!, ...others].map((s) => s.id).sort())
    expect(await count(`select count(*) as n from event_projections p join domain_events e on e.id = p.event_id
                         where e.source_id = $1 and p.consumer = 'notifications'`, [proposalId])).toBe(1)
  })

  it('同一個請求編號重送：回同一份回執，不會多一份提案', async () => {
    const cohortId = await newCohort()
    const [s1, ...others] = await students(cohortId, 5)
    const requestId = randomUUID()
    const input = { groupType: 'general', memberStudentNos: others.map((s) => s.studentNo) }
    const first = await groups.propose(studentActor(s1!), input, requestId)
    const second = await groups.propose(studentActor(s1!), input, requestId)
    expect(first.ok && second.ok && first.receipt.proposalId === second.receipt.proposalId).toBe(true)
    expect(await count('select count(*) as n from group_proposals where cohort_id = $1', [cohortId])).toBe(1)
  })

  it('人數依屆別設定：預設 5 人時四人被拒；管理員改成 3–5 人後四人可以', async () => {
    const cohortId = await newCohort()
    const [s1, ...others] = await students(cohortId, 4)
    const tooFew = await propose(s1!, others)
    expect(tooFew).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    if (!tooFew.ok) expect(tooFew.message).toContain('本屆每組 5 人')

    const cohort = (await cohortQuery.get(cohortId))!
    const saved = await cohorts.setGroupingSettings(
      staffActor(adminId, 'admin'),
      cohortId,
      { groupSizeMin: 3, groupSizeMax: 5, proposalDefaultDays: 7 },
      cohort.revision,
      randomUUID(),
    )
    expect(saved.ok).toBe(true)
    expect(await propose(s1!, others)).toMatchObject({ ok: true, receipt: { memberCount: 4 } })
  })

  it('到期取早：預設天數超過成組截止時，到期＝成組截止', async () => {
    const cohortId = await newCohort({ min: 5, max: 5 }, 7)
    businessNow = new Date(GROUPING_DEADLINE.getTime() - 3 * DAY)
    const [s1, ...others] = await students(cohortId, 5)
    const result = await propose(s1!, others)
    expect(result).toMatchObject({ ok: true, receipt: { expiresBusinessAt: GROUPING_DEADLINE.toISOString() } })
  })

  it('成組期已過：DEADLINE_PASSED；成組期還沒開始：VALIDATION_FAILED；兩者都沒有留下提案', async () => {
    const cohortId = await newCohort()
    const [s1, ...others] = await students(cohortId, 5)
    businessNow = new Date(GROUPING_DEADLINE.getTime())
    expect(await propose(s1!, others)).toMatchObject({ ok: false, code: 'DEADLINE_PASSED' })
    businessNow = new Date('2026-09-01T00:00:00Z')
    expect(await propose(s1!, others)).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    expect(await count('select count(*) as n from group_proposals where cohort_id = $1', [cohortId])).toBe(0)
  })

  it('學號找不到、他屆學生、停用帳號都被拒；老師不能發起', async () => {
    const cohortId = await newCohort()
    const otherCohort = await newCohort()
    const [s1, s2, s3, s4] = await students(cohortId, 4)
    const outsider = await newStudent(otherCohort)
    const disabled = await newStudent(cohortId, { status: 'disabled' })

    const unknown = await groups.propose(
      studentActor(s1!),
      { groupType: 'general', memberStudentNos: [s2!.studentNo, s3!.studentNo, s4!.studentNo, '999999999'] },
      randomUUID(),
    )
    expect(unknown).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    if (!unknown.ok) expect(unknown.message).toContain('999999999')
    expect(await propose(s1!, [s2!, s3!, s4!, outsider])).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    expect(await propose(s1!, [s2!, s3!, s4!, disabled])).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })

    const teacher = await groups.propose(staffActor(teacherId, 'teacher'), { groupType: 'general', memberStudentNos: [] }, randomUUID())
    expect(teacher).toMatchObject({ ok: false, code: 'FORBIDDEN' })
  })

  it('同一人同時只能在一個進行中提案：被占住的人再被邀請 → INVITED_ELSEWHERE，第二份不留任何列', async () => {
    const cohortId = await newCohort()
    const five = await students(cohortId, 5)
    const more = await students(cohortId, 4)
    await mustPropose(five[0]!, five.slice(1))
    const second = await propose(more[0]!, [...more.slice(1), five[2]!])
    expect(second).toMatchObject({ ok: false, code: 'INVITED_ELSEWHERE' })
    if (!second.ok) expect(second.message).toContain(five[2]!.name)
    expect(await count('select count(*) as n from group_proposals where cohort_id = $1', [cohortId])).toBe(1)
    expect(await count('select count(*) as n from proposal_occupancy o join group_proposals p on p.id = o.proposal_id where p.cohort_id = $1', [cohortId])).toBe(5)
  })
})

describe('確認與成立', () => {
  it('逐人確認 1/5…4/5；最後一位確認的那一刻成立：代碼、五位成員、組長是提案人，占用釋放、到期工作取消、全員成立事件', async () => {
    const cohortId = await newCohort()
    const members = await students(cohortId, 5)
    const proposalId = await mustPropose(members[0]!, members.slice(1))

    for (const [i, member] of members.slice(0, 4).entries()) {
      const result = await groups.confirm(studentActor(member), proposalId, randomUUID())
      expect(result).toMatchObject({ ok: true, receipt: { outcome: 'confirmed', confirmedCount: i + 1, memberCount: 5 } })
    }
    expect(await count('select count(*) as n from groups where cohort_id = $1', [cohortId])).toBe(0)

    const last = await groups.confirm(studentActor(members[4]!), proposalId, randomUUID())
    expect(last).toMatchObject({ ok: true, receipt: { outcome: 'established', groupCode: 'G01', confirmedCount: 5 } })

    const proposal = await proposalRow(proposalId)
    expect(proposal.state).toBe('established')
    const groupId = String(proposal.established_group_id)
    const memberships = await owner.sql(
      `select user_id from group_memberships where group_id = $1 and valid_to is null`,
      [groupId],
    )
    expect(memberships.rows.map((r) => r.user_id).sort()).toEqual(members.map((m) => m.id).sort())
    const leaders = await owner.sql('select user_id from group_leaders where group_id = $1 and valid_to is null', [groupId])
    expect(leaders.rows).toEqual([{ user_id: members[0]!.id }])
    expect(await count('select count(*) as n from proposal_occupancy where proposal_id = $1', [proposalId])).toBe(0)
    expect(await dueWorkState(proposalId)).toBe('cancelled')
    const event = await owner.sql(`select recipients from domain_events where type = 'group.established' and source_id = $1`, [groupId])
    expect([...(event.rows[0]!.recipients as string[])].sort()).toEqual(members.map((m) => m.id).sort())

    // 學生頁看到的一樣：組別、五人、組長標示。
    const view = await query.studentView(members[2]!.id, cohortId)
    expect(view.group?.code).toBe('G01')
    expect(view.group?.members.find((m) => m.isLeader)?.userId).toBe(members[0]!.id)
    expect(view.openProposal).toBeNull()

    // 第二組拿到 G02。
    const next = await students(cohortId, 5)
    const second = await mustPropose(next[0]!, next.slice(1))
    expect(await confirmAll(second, next)).toMatchObject({ receipt: { outcome: 'established', groupCode: 'G02' } })
  })

  it('不在名單的人確認 → FORBIDDEN；已經確認過再按 → already_confirmed，不是錯誤；成立後已拒絕的操作 → PROPOSAL_NOT_OPEN', async () => {
    const cohortId = await newCohort()
    const members = await students(cohortId, 5)
    const stranger = await newStudent(cohortId)
    const proposalId = await mustPropose(members[0]!, members.slice(1))

    expect(await groups.confirm(studentActor(stranger), proposalId, randomUUID())).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    await groups.confirm(studentActor(members[1]!), proposalId, randomUUID())
    expect(await groups.confirm(studentActor(members[1]!), proposalId, randomUUID())).toMatchObject({
      ok: true,
      receipt: { outcome: 'already_confirmed', confirmedCount: 1 },
    })

    await confirmAll(proposalId, [members[0]!, members[2]!, members[3]!, members[4]!])
    // 最後一人重複確認：不會多一組。
    expect(await groups.confirm(studentActor(members[4]!), proposalId, randomUUID())).toMatchObject({
      ok: true,
      receipt: { outcome: 'already_confirmed', groupCode: 'G01' },
    })
    expect(await count('select count(*) as n from groups where cohort_id = $1', [cohortId])).toBe(1)
    // 成立後不能再用撤回拆組。
    expect(await groups.withdrawProposal(studentActor(members[0]!), proposalId, randomUUID())).toMatchObject({
      ok: false,
      code: 'PROPOSAL_NOT_OPEN',
    })
  })

  it('已經有組的人：被邀請 → ALREADY_MEMBER；也不能打開公開找組員', async () => {
    const cohortId = await newCohort()
    const members = await students(cohortId, 5)
    await confirmAll(await mustPropose(members[0]!, members.slice(1)), members)
    const others = await students(cohortId, 4)
    expect(await propose(others[0]!, [...others.slice(1), members[3]!])).toMatchObject({ ok: false, code: 'ALREADY_MEMBER' })
    expect(await groups.setOpenToJoin(studentActor(members[3]!), true, randomUUID())).toMatchObject({
      ok: false,
      code: 'ALREADY_MEMBER',
    })
  })

  it('成立是單一交易：組別、成員、組長寫完、占用刪掉之後出錯，全部不留，占用還在、最後一位仍是待確認', async () => {
    const cohortId = await newCohort()
    const members = await students(cohortId, 5)
    const proposalId = await mustPropose(members[0]!, members.slice(1))
    await confirmAll(proposalId, members.slice(0, 4))

    const disable = enableFaultInjection()
    try {
      failAt('group.establish.after-release')
      expect(await groups.confirm(studentActor(members[4]!), proposalId, randomUUID())).toMatchObject({ ok: false, code: 'INTERNAL' })
    } finally {
      disable()
    }
    expect(await count('select count(*) as n from groups where cohort_id = $1', [cohortId])).toBe(0)
    expect(await count('select count(*) as n from group_memberships where cohort_id = $1', [cohortId])).toBe(0)
    expect(await count('select count(*) as n from proposal_occupancy where proposal_id = $1', [proposalId])).toBe(5)
    expect((await invitationStates(proposalId))[members[4]!.id]).toBe('pending')
    expect((await proposalRow(proposalId)).state).toBe('open')

    // 故障排除後同一個人再按一次就成立。
    expect(await groups.confirm(studentActor(members[4]!), proposalId, randomUUID())).toMatchObject({
      ok: true,
      receipt: { outcome: 'established' },
    })
  })
})

describe('終止與釋放', () => {
  it('拒絕：整份終止（被拒絕），全員釋放、到期工作取消、終止事件給全員；原班人馬可以重新發起新提案，所有人重新確認', async () => {
    const cohortId = await newCohort()
    const members = await students(cohortId, 5)
    const proposalId = await mustPropose(members[0]!, members.slice(1))
    await groups.confirm(studentActor(members[1]!), proposalId, randomUUID())

    const declined = await groups.decline(studentActor(members[2]!), proposalId, randomUUID())
    expect(declined).toMatchObject({ ok: true, receipt: { terminationKind: 'declined' } })
    expect(await proposalRow(proposalId)).toMatchObject({ state: 'terminated', termination_kind: 'declined', closed_by_kind: 'user' })
    const states = await invitationStates(proposalId)
    expect(states[members[2]!.id]).toBe('declined')
    expect(Object.values(states).filter((s) => s === 'released')).toHaveLength(4)
    expect(await count('select count(*) as n from proposal_occupancy where proposal_id = $1', [proposalId])).toBe(0)
    expect(await dueWorkState(proposalId)).toBe('cancelled')
    const event = await owner.sql(
      `select recipients, payload from domain_events where type = 'proposal.terminated' and source_id = $1`,
      [proposalId],
    )
    // 提案人同時是被邀請者：事件層去重，只一則。
    expect(event.rows[0]!.recipients as string[]).toHaveLength(5)

    // 終止後再確認 → PROPOSAL_NOT_OPEN。
    expect(await groups.confirm(studentActor(members[3]!), proposalId, randomUUID())).toMatchObject({
      ok: false,
      code: 'PROPOSAL_NOT_OPEN',
    })

    // 重新發起是新提案：原先確認過的人也要重新確認。
    const again = await mustPropose(members[0]!, members.slice(1))
    expect(again).not.toBe(proposalId)
    expect(Object.values(await invitationStates(again))).toEqual(Array(5).fill('pending'))
  })

  it('已確認的普通成員撤回同意 → 成員撤回同意；提案人不能用這個、也不能拒絕', async () => {
    const cohortId = await newCohort()
    const members = await students(cohortId, 5)
    const proposalId = await mustPropose(members[0]!, members.slice(1))
    expect(await groups.withdrawConfirmation(studentActor(members[1]!), proposalId, randomUUID())).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
    })
    expect(await groups.decline(studentActor(members[0]!), proposalId, randomUUID())).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
    })
    await groups.confirm(studentActor(members[1]!), proposalId, randomUUID())
    expect(await groups.withdrawConfirmation(studentActor(members[1]!), proposalId, randomUUID())).toMatchObject({
      ok: true,
      receipt: { terminationKind: 'member_withdrew' },
    })
    expect((await invitationStates(proposalId))[members[1]!.id]).toBe('withdrawn')
  })

  it('提案人撤回 → 提案人撤回；別人不能撤回整份', async () => {
    const cohortId = await newCohort()
    const members = await students(cohortId, 5)
    const proposalId = await mustPropose(members[0]!, members.slice(1))
    expect(await groups.withdrawProposal(studentActor(members[1]!), proposalId, randomUUID())).toMatchObject({
      ok: false,
      code: 'FORBIDDEN',
    })
    expect(await groups.withdrawProposal(studentActor(members[0]!), proposalId, randomUUID())).toMatchObject({
      ok: true,
      receipt: { terminationKind: 'proposer_withdrew' },
    })
    expect(await count('select count(*) as n from proposal_occupancy where proposal_id = $1', [proposalId])).toBe(0)
  })

  it('管理員作廢：非管理員被拒、理由必填；作廢後理由存在提案上，但通知事件不帶理由', async () => {
    const cohortId = await newCohort()
    const members = await students(cohortId, 5)
    const proposalId = await mustPropose(members[0]!, members.slice(1))
    expect(await groups.voidProposal(studentActor(members[0]!), proposalId, '理由', randomUUID())).toMatchObject({
      ok: false,
      code: 'FORBIDDEN',
    })
    expect(await groups.voidProposal(staffActor(adminId, 'admin'), proposalId, '   ', randomUUID())).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
    })
    expect((await proposalRow(proposalId)).state).toBe('open')

    const voided = await groups.voidProposal(staffActor(adminId, 'admin'), proposalId, '組員名單有誤（系辦內部備註）', randomUUID())
    expect(voided).toMatchObject({ ok: true, receipt: { terminationKind: 'admin_voided' } })
    expect(await proposalRow(proposalId)).toMatchObject({ termination_kind: 'admin_voided', reason: '組員名單有誤（系辦內部備註）' })
    const event = await owner.sql(`select payload from domain_events where type = 'proposal.terminated' and source_id = $1`, [proposalId])
    expect(JSON.stringify(event.rows[0]!.payload)).not.toContain('內部備註')

    // 學生的查詢也不帶理由。
    const view = await query.studentView(members[1]!.id, cohortId)
    expect(view.history[0]).toMatchObject({ terminationKind: 'admin_voided', reason: null })
  })

  it('到期處理器：推過到期時間 → 逾期終止並釋放；重跑、舊版本、還沒到期、已成立都不做事', async () => {
    const cohortId = await newCohort()
    const members = await students(cohortId, 5)
    const proposalId = await mustPropose(members[0]!, members.slice(1))

    expect(await groups.expire(proposalId, 1)).toBe('not_due')
    businessNow = new Date(businessNow.getTime() + 8 * DAY)
    expect(await groups.expire(proposalId, 2)).toBe('stale_version')
    // 過了到期時間、背景工作還沒跑：確認被擋。
    expect(await groups.confirm(studentActor(members[1]!), proposalId, randomUUID())).toMatchObject({
      ok: false,
      code: 'PROPOSAL_NOT_OPEN',
    })
    expect(await groups.expire(proposalId, 1)).toBe('expired')
    expect(await proposalRow(proposalId)).toMatchObject({ state: 'terminated', termination_kind: 'expired', closed_by_kind: 'worker' })
    expect(await count('select count(*) as n from proposal_occupancy where proposal_id = $1', [proposalId])).toBe(0)
    expect(await dueWorkState(proposalId)).toBe('cancelled')
    expect(await groups.expire(proposalId, 1)).toBe('not_open')

    businessNow = new Date('2026-09-20T02:00:00Z')
    const established = await mustPropose(members[0]!, members.slice(1))
    await confirmAll(established, members)
    businessNow = new Date(businessNow.getTime() + 8 * DAY)
    expect(await groups.expire(established, 1)).toBe('not_open')
    expect(await groups.expire(randomUUID(), 1)).toBe('not_found')
  })

  it('背景工作的到期迴圈（票 12）：業務鐘推過到期時間，下一輪恰好終止一次；工作維持 cancelled；還沒到期的留著重試', async () => {
    const runner = new PgDueWorkRunner({
      pool: () => app,
      handlers: { proposal_expiry: proposalExpiryDueWorkHandler(groups) },
      events: new PgEventPublisher(),
      businessClock,
      log: () => undefined,
    })
    const cohortId = await newCohort()
    const members = await students(cohortId, 5)
    const proposalId = await mustPropose(members[0]!, members.slice(1))

    await runner.runOnce() // 還沒到期：迴圈不會撿
    expect(await proposalRow(proposalId)).toMatchObject({ state: 'open' })
    expect(await dueWorkState(proposalId)).toBe('pending')

    businessNow = new Date(businessNow.getTime() + 8 * DAY)
    await runner.runOnce()
    await runner.runOnce()
    expect(await proposalRow(proposalId)).toMatchObject({ state: 'terminated', termination_kind: 'expired', closed_by_kind: 'worker' })
    expect(await dueWorkState(proposalId)).toBe('cancelled') // 處理器自己收尾，迴圈不蓋成 done
    expect(
      await count(`select count(*) as n from domain_events where type = 'proposal.terminated' and source_id = $1`, [proposalId]),
    ).toBe(1)

    // 模擬鐘被往回撥的情況：工作的到期時間已過，但提案本身還沒到期 → not_due → 保持 pending、次數不累計。
    businessNow = new Date('2026-09-20T02:00:00Z')
    const early = await mustPropose(members[0]!, members.slice(1))
    await owner.sql(`update due_work set due_business_at = $2 where subject_id = $1`, [early, new Date(businessNow.getTime() - DAY)])
    await runner.runOnce()
    expect(await proposalRow(early)).toMatchObject({ state: 'open' })
    const row = await owner.sql('select state, attempts, next_attempt_at from due_work where subject_id = $1', [early])
    expect(row.rows[0]).toMatchObject({ state: 'pending', attempts: 0 })
    expect(row.rows[0]!.next_attempt_at).not.toBeNull()
  })

  it('過期但背景工作還沒收的提案不會卡住人：發起新提案時先把它以逾期終止', async () => {
    const cohortId = await newCohort()
    const members = await students(cohortId, 5)
    const stale = await mustPropose(members[0]!, members.slice(1))
    businessNow = new Date(businessNow.getTime() + 8 * DAY)
    const fresh = await propose(members[1]!, [members[0]!, ...members.slice(2)])
    expect(fresh.ok).toBe(true)
    expect(await proposalRow(stale)).toMatchObject({ state: 'terminated', termination_kind: 'expired', closed_by_kind: 'system' })
  })
})

describe('並發', () => {
  /** 讓兩筆交易都開始了才一起往下走：借連線、BEGIN 之後在屏障會合。 */
  function barrierPool(parties: number) {
    const barrier = createBarrier(parties)
    return {
      barrier,
      pool: () => ({
        connect: async () => {
          const client = await app.connect()
          const original = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>
          let first = true
          ;(client as unknown as { query: (...args: unknown[]) => Promise<unknown> }).query = async (...args: unknown[]) => {
            const result = await original(...args)
            if (first && typeof args[0] === 'string' && args[0] === 'begin') {
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
      }),
    }
  }

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

  it('最後兩位同時按確認：只成立一組、五筆有效成員、占用清空', async () => {
    const cohortId = await newCohort()
    const members = await students(cohortId, 5)
    const proposalId = await mustPropose(members[0]!, members.slice(1))
    await confirmAll(proposalId, members.slice(0, 3))

    const { pool } = barrierPool(2)
    const racing = commandWith(pool)
    const results = await Promise.all([
      racing.confirm(studentActor(members[3]!), proposalId, randomUUID()),
      racing.confirm(studentActor(members[4]!), proposalId, randomUUID()),
    ])
    expect(results.every((r) => r.ok)).toBe(true)
    expect(results.map((r) => (r.ok ? r.receipt.outcome : r.code)).sort()).toEqual(['confirmed', 'established'])
    expect(await count('select count(*) as n from groups where cohort_id = $1', [cohortId])).toBe(1)
    expect(await count('select count(*) as n from group_memberships where cohort_id = $1 and valid_to is null', [cohortId])).toBe(5)
    expect(await count('select count(*) as n from proposal_occupancy where proposal_id = $1', [proposalId])).toBe(0)
  })

  it('同一人用兩個請求編號同時按確認：一次 confirmed、一次 already_confirmed', async () => {
    const cohortId = await newCohort()
    const members = await students(cohortId, 5)
    const proposalId = await mustPropose(members[0]!, members.slice(1))
    const { pool } = barrierPool(2)
    const racing = commandWith(pool)
    const results = await Promise.all([
      racing.confirm(studentActor(members[1]!), proposalId, randomUUID()),
      racing.confirm(studentActor(members[1]!), proposalId, randomUUID()),
    ])
    expect(results.map((r) => (r.ok ? r.receipt.outcome : r.code)).sort()).toEqual(['already_confirmed', 'confirmed'])
  })

  it('兩份提案同時邀同一人：恰一份成立，另一份 INVITED_ELSEWHERE，沒有人被兩份占住', async () => {
    const cohortId = await newCohort()
    const shared = await newStudent(cohortId)
    const a = await students(cohortId, 4)
    const b = await students(cohortId, 4)
    const { pool } = barrierPool(2)
    const racing = commandWith(pool)
    const results = await Promise.all([
      racing.propose(studentActor(a[0]!), { groupType: 'general', memberStudentNos: [...a.slice(1), shared].map((s) => s.studentNo) }, randomUUID()),
      racing.propose(studentActor(b[0]!), { groupType: 'industry', memberStudentNos: [...b.slice(1), shared].map((s) => s.studentNo) }, randomUUID()),
    ])
    expect(results.map((r) => (r.ok ? 'ok' : r.code)).sort()).toEqual(['INVITED_ELSEWHERE', 'ok'])
    expect(await count(`select count(*) as n from group_proposals where cohort_id = $1`, [cohortId])).toBe(1)
    expect(await count('select count(*) as n from proposal_occupancy where user_id = $1', [shared.id])).toBe(1)
  })

  it('一邊成立中、一邊發起邀同一人：發起那邊等成立結束後看到他已有組 → ALREADY_MEMBER，不留一份註定衝突的提案', async () => {
    const cohortId = await newCohort({ min: 2, max: 5 })
    const [x, y] = await students(cohortId, 2)
    const z = await newStudent(cohortId)
    const proposalId = await mustPropose(x!, [y!])
    await groups.confirm(studentActor(x!), proposalId, randomUUID())

    const disable = enableFaultInjection()
    try {
      let reached!: () => void
      const establishing = new Promise<void>((resolve) => (reached = resolve))
      let release!: () => void
      const held = new Promise<void>((resolve) => (release = resolve))
      injectFault('group.establish.after-release', async () => {
        reached()
        await held
      })

      const confirming = groups.confirm(studentActor(y!), proposalId, randomUUID())
      await establishing
      const proposing = propose(z, [x!])

      // 等「發起」那筆交易真的卡在占用列上（它要插的占用列正被成立中的交易刪除）。
      for (let i = 0; i < 200; i += 1) {
        // pg_locks 對所有角色都看得到（pg_stat_activity 的查詢文字別的角色看不到）。
        const waiting = await owner.sql(`select count(*) as n from pg_locks where not granted and locktype = 'transactionid'`)
        if (Number(waiting.rows[0]!.n) > 0) break
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      release()

      expect(await confirming).toMatchObject({ ok: true, receipt: { outcome: 'established' } })
      expect(await proposing).toMatchObject({ ok: false, code: 'ALREADY_MEMBER' })
    } finally {
      disable()
    }
    expect(await count(`select count(*) as n from group_proposals where proposer_user_id = $1`, [z.id])).toBe(0)
  })
})

describe('公開找組員', () => {
  it('開啟後同屆學生、老師看到姓名、學號、聯絡 Email（沒有電話）；他屆學生、未登入看不到；關掉就消失', async () => {
    const cohortId = await newCohort()
    const otherCohort = await newCohort()
    const [seeker, viewer] = await students(cohortId, 2)
    const outsider = await newStudent(otherCohort)

    expect(await query.teammates(studentActor(viewer!), cohortId)).toEqual([])
    expect(await groups.setOpenToJoin(studentActor(seeker!), true, randomUUID())).toMatchObject({ ok: true })

    const seen = await query.teammates(studentActor(viewer!), cohortId)
    expect(seen).toEqual([{ name: seeker!.name, studentNo: seeker!.studentNo, contactEmail: seeker!.email }])
    expect(JSON.stringify(seen)).not.toContain('0912345678')
    expect(await query.teammates(staffActor(teacherId, 'teacher'), cohortId)).toHaveLength(1)
    expect(await query.teammates(studentActor(outsider), cohortId)).toEqual([])
    expect(await query.teammates({ kind: 'anonymous' }, cohortId)).toEqual([])
    // 自己不列在自己的名單裡。
    expect(await query.teammates(studentActor(seeker!), cohortId)).toEqual([])

    expect(await groups.setOpenToJoin(studentActor(seeker!), false, randomUUID())).toMatchObject({ ok: true })
    expect(await query.teammates(studentActor(viewer!), cohortId)).toEqual([])
  })

  it('成組或停用後自動不列，即使開關還開著；別人不能替他開（用例只改本人）', async () => {
    const cohortId = await newCohort({ min: 2, max: 5 })
    const [a, b, viewer] = await students(cohortId, 3)
    await groups.setOpenToJoin(studentActor(a!), true, randomUUID())
    await groups.setOpenToJoin(studentActor(b!), true, randomUUID())
    expect(await query.teammates(studentActor(viewer!), cohortId)).toHaveLength(2)

    await confirmAll(await mustPropose(a!, [b!]), [a!, b!])
    expect(await query.teammates(studentActor(viewer!), cohortId)).toEqual([])

    const c = await newStudent(cohortId)
    await groups.setOpenToJoin(studentActor(c), true, randomUUID())
    await owner.sql(`update users set status = 'disabled' where id = $1`, [c.id])
    expect(await query.teammates(studentActor(viewer!), cohortId)).toEqual([])

    // setOpenToJoin 沒有「替誰改」的參數：只會改 actor 自己那一列。
    await groups.setOpenToJoin(studentActor(viewer!), true, randomUUID())
    const flags = await owner.sql('select user_id, open_to_join from user_profiles where user_id = any($1::uuid[])', [[viewer!.id, a!.id]])
    expect(Object.fromEntries(flags.rows.map((r) => [r.user_id, r.open_to_join]))).toEqual({ [viewer!.id]: true, [a!.id]: true })
  })
})

describe('分組設定（管理員）', () => {
  it('非管理員被拒、最少大於最多被拒、舊版本 CONFLICT；成功後讀回新值並留稽核', async () => {
    const cohortId = await newCohort()
    const cohort = (await cohortQuery.get(cohortId))!
    expect(cohort).toMatchObject({ groupSizeMin: 5, groupSizeMax: 5, proposalDefaultDays: 7 })

    const input = { groupSizeMin: 4, groupSizeMax: 6, proposalDefaultDays: 5 }
    expect(await cohorts.setGroupingSettings(staffActor(teacherId, 'teacher'), cohortId, input, cohort.revision, randomUUID())).toMatchObject({
      ok: false,
      code: 'FORBIDDEN',
    })
    expect(
      await cohorts.setGroupingSettings(staffActor(adminId, 'admin'), cohortId, { ...input, groupSizeMin: 7 }, cohort.revision, randomUUID()),
    ).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    expect(
      await cohorts.setGroupingSettings(staffActor(adminId, 'admin'), cohortId, { ...input, proposalDefaultDays: 0 }, cohort.revision, randomUUID()),
    ).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    expect(await cohorts.setGroupingSettings(staffActor(adminId, 'admin'), cohortId, input, cohort.revision, randomUUID())).toMatchObject({
      ok: true,
    })
    expect(await cohorts.setGroupingSettings(staffActor(adminId, 'admin'), cohortId, input, cohort.revision, randomUUID())).toMatchObject({
      ok: false,
      code: 'CONFLICT',
    })
    expect(await cohortQuery.get(cohortId)).toMatchObject(input)
    expect(await count(`select count(*) as n from audit_events where action = 'cohort.set_grouping_settings' and cohort_id = $1`, [cohortId])).toBe(1)
  })
})

describe('管理員分組總覽', () => {
  it('列出組別、進行中提案（含到期時間）、終止紀錄（含作廢理由）與未分組學生', async () => {
    const cohortId = await newCohort({ min: 2, max: 5 })
    const [a, b, c, d, e] = await students(cohortId, 5)
    await confirmAll(await mustPropose(a!, [b!]), [a!, b!])
    await mustPropose(c!, [d!])
    const voided = await mustPropose(e!, [(await newStudent(cohortId))])
    await groups.voidProposal(staffActor(adminId, 'admin'), voided, '測試作廢', randomUUID())

    const overview = await query.overview(cohortId)
    expect(overview.groups.map((g) => [g.code, g.members.length])).toEqual([['G01', 2]])
    expect(overview.openProposals).toHaveLength(1)
    expect(overview.openProposals[0]!.invitations.map((i) => i.state)).toEqual(['pending', 'pending'])
    expect(overview.closedProposals[0]).toMatchObject({ terminationKind: 'admin_voided', reason: '測試作廢' })
    const ungrouped = overview.ungrouped.map((u) => [u.studentNo, u.inProposal])
    expect(ungrouped).toContainEqual([c!.studentNo, true])
    expect(ungrouped).toContainEqual([e!.studentNo, false])
    expect(ungrouped.map(([no]) => no)).not.toContain(a!.studentNo)
  })
})
