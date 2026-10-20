import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool, PoolClient } from 'pg'
import { assertTestDatabaseReachable, createIsolatedDatabase, poolAsRole, type IsolatedDatabase } from '../../../test/db'
import { migratedSchema } from '../../../test/migrations'
import type { ResolvedActor } from '@/application/accounts'
import { describeUnassignedStatus, summarizeUnassigned } from '@/application/groups'
import type { SignoffParticipantHook } from '@/application/signoff'
import { PgGroupCommand } from '@/infrastructure/groups/pg-groups'
import { PgUnassignedQuery } from '@/infrastructure/groups/pg-unassigned'
import { PgDueWorkScheduler } from '@/infrastructure/notifications/pg-due-work-scheduler'
import { PgEventPublisher } from '@/infrastructure/notifications/pg-event-publisher'
import { PgAuditWriter } from '@/infrastructure/ops/audit-writer'
import { PgOperationLedger } from '@/infrastructure/ops/operation-ledger'

/**
 * C3-15：系辦「未分組學生」一句 SQL（設計方案③ §6.3；AC-C3-19）。
 *
 * 以正式執行角色 `fju_app` 連線。建立中的組別走真的 `PgGroupCommand.propose`，終止走既有 `voidProposal`（理由留空）。
 */

let owner: IsolatedDatabase
let app: Pool
let adminId: string
const businessClock = { now: async () => new Date('2026-09-20T02:00:00Z') }

let groups: PgGroupCommand
let query: PgUnassignedQuery
const signoffHook: SignoffParticipantHook<PoolClient> = {
  async supersedeForParticipantChange() {
    return { supersededVersionIds: [] }
  },
  async voidForDissolution() {
    return { voidedVersionIds: [] }
  },
}

type Student = { id: string; studentNo: string; cohortId: string; name: string }

function actor(userId: string, roles: ('admin' | 'student')[], cohortId?: string): ResolvedActor {
  return {
    kind: 'authenticated',
    userId,
    roles,
    status: 'active',
    mustChangePassword: false,
    cohortMemberships: cohortId ? [{ cohortId, role: 'student' }] : [],
  }
}
const adminActor = () => actor(adminId, ['admin'])
const studentActor = (s: Student) => actor(s.id, ['student'], s.cohortId)

let seq = 0
async function newCohort(): Promise<string> {
  seq += 1
  const row = await owner.sql(
    `insert into cohorts (id, code, name, status, year_end_date, group_size_min, group_size_max, proposal_default_days, created_by_kind)
     values (gen_random_uuid(), $1, $1, 'active', '2027-06-30', 2, 5, 7, 'system') returning id`,
    [`UNA-${seq}`],
  )
  const cohortId = String(row.rows[0]!.id)
  for (const [i, [name, date]] of [
    ['成組期', '2026-09-15'],
    ['期中', '2026-11-01'],
    ['期末', '2027-01-10'],
    ['成果', '2027-03-01'],
  ].entries()) {
    await owner.sql(
      `insert into cohort_stages (id, cohort_id, seq, name, start_date, created_by_kind) values (gen_random_uuid(), $1, $2, $3, $4, 'system')`,
      [cohortId, i + 1, name, date],
    )
  }
  return cohortId
}

async function newUser(name: string): Promise<string> {
  seq += 1
  const row = await owner.sql(
    `insert into users (id, name, email, email_verified, updated_at, status)
     values (gen_random_uuid(), $1, $2, true, now(), 'active') returning id`,
    [name, `una-${seq}@example.com`],
  )
  return String(row.rows[0]!.id)
}

async function newStudent(
  cohortId: string,
  patch: { openToJoin?: boolean; skills?: string[]; departmentClass?: string; avatarPreset?: number } = {},
): Promise<Student> {
  seq += 1
  const studentNo = `41600${String(seq).padStart(4, '0')}`
  const name = `未分${seq}`
  const id = await newUser(name)
  await owner.sql(
    `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at) values (gen_random_uuid(), $1, 'student', $2, now())`,
    [id, adminId],
  )
  await owner.sql(
    `insert into user_profiles (user_id, display_name, name_normalized, student_no, cohort_id, phone, contact_email,
                                open_to_join, skills, department_class, avatar_preset)
     values ($1, $2, $2, $3, $4, '0912345678', $5, $6, $7::jsonb, $8, $9)`,
    [
      id,
      name,
      studentNo,
      cohortId,
      `u-${seq}@example.com`,
      patch.openToJoin ?? false,
      JSON.stringify(patch.skills ?? []),
      patch.departmentClass ?? null,
      patch.avatarPreset ?? null,
    ],
  )
  await owner.sql(`insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)`, [cohortId, studentNo, id])
  return { id, studentNo, cohortId, name }
}

async function propose(proposer: Student, others: Student[]): Promise<string> {
  const r = await groups.propose(studentActor(proposer), { groupType: 'general', memberStudentNos: others.map((s) => s.studentNo) }, randomUUID())
  if (!r.ok) throw new Error(`${r.code} ${r.message}`)
  return r.receipt.proposalId
}

async function establish(members: Student[]): Promise<void> {
  const proposalId = await propose(members[0]!, members.slice(1))
  for (const m of members) {
    const r = await groups.confirm(studentActor(m), proposalId, randomUUID())
    if (!r.ok) throw new Error(`${r.code} ${r.message}`)
  }
}

beforeAll(async () => {
  await assertTestDatabaseReachable()
  owner = await createIsolatedDatabase({ label: 'unassigned', setup: migratedSchema })
  app = await poolAsRole(owner, 'fju_app')
  adminId = await newUser('A1')
  groups = new PgGroupCommand({
    audit: new PgAuditWriter(),
    ledger: new PgOperationLedger(() => app),
    events: new PgEventPublisher(),
    dueWork: new PgDueWorkScheduler({ testKindsEnabled: false }),
    businessClock,
    signoff: signoffHook,
    pool: () => app,
  })
  query = new PgUnassignedQuery(() => app)
})

afterAll(async () => {
  await app?.end()
  await owner?.close()
})

describe('未分組學生名單', () => {
  it('AC-C3-19：N 可加入、P 公開找隊員（技能、系級、頭像）、E 與 Q 在建立中；已分組、別屆、停用的不列；組別帶人數', async () => {
    const cohortId = await newCohort()
    const other = await newCohort()
    const n = await newStudent(cohortId)
    const p = await newStudent(cohortId, { openToJoin: true, skills: ['前端', 'AI'], departmentClass: '資管三甲', avatarPreset: 7 })
    const e = await newStudent(cohortId)
    const q = await newStudent(cohortId, { openToJoin: true })
    const grouped = await Promise.all([newStudent(cohortId), newStudent(cohortId)])
    await establish(grouped)
    await newStudent(other)
    const disabled = await newStudent(cohortId)
    await owner.sql(`update users set status = 'disabled' where id = $1`, [disabled.id])
    const proposalId = await propose(e, [q])

    const roster = await query.roster(cohortId)
    expect(roster.students.map((s) => s.studentNo)).toEqual([n, p, e, q].map((s) => s.studentNo))
    const byNo = new Map(roster.students.map((s) => [s.studentNo, s]))
    expect(byNo.get(p.studentNo)).toEqual({
      userId: p.id,
      name: p.name,
      studentNo: p.studentNo,
      departmentClass: '資管三甲',
      avatarPreset: 7,
      avatarFileId: null,
      skills: ['前端', 'AI'],
      openToJoin: true,
      proposal: null,
    })
    expect(byNo.get(n.studentNo)).toMatchObject({ departmentClass: null, skills: [], openToJoin: false, proposal: null })
    // 發起人與受邀者都看得到同一份建立中，帶發起人名字與到期（業務時間）。
    const expires = await owner.sql('select expires_business_at from group_proposals where id = $1', [proposalId])
    for (const s of [e, q]) {
      expect(byNo.get(s.studentNo)!.proposal).toEqual({
        id: proposalId,
        proposerName: e.name,
        expiresBusinessAt: expires.rows[0]!.expires_business_at,
      })
    }
    expect(describeUnassignedStatus(byNo.get(n.studentNo)!)).toBe('可加入')
    expect(describeUnassignedStatus(byNo.get(p.studentNo)!)).toBe('公開找隊員')
    expect(describeUnassignedStatus(byNo.get(q.studentNo)!)).toMatch(new RegExp(`^建立中（發起人 ${e.name}，到期 \\d+/\\d+）$`))
    expect(summarizeUnassigned(roster.students)).toBe('4 人未分組・2 人公開找隊員・1 份建立中')

    expect(roster.groups).toEqual([{ id: expect.any(String), code: 'G01', revision: expect.any(Number), memberCount: 2 }])
  })

  it('終止建立（理由留空）後，E 與 Q 都變可加入', async () => {
    const cohortId = await newCohort()
    const e = await newStudent(cohortId)
    const q = await newStudent(cohortId)
    const proposalId = await propose(e, [q])
    const voided = await groups.voidProposal(adminActor(), proposalId, '', randomUUID())
    expect(voided).toMatchObject({ ok: true })

    const roster = await query.roster(cohortId)
    expect(roster.students.map((s) => [s.studentNo, s.proposal, describeUnassignedStatus(s)])).toEqual([
      [e.studentNo, null, '可加入'],
      [q.studentNo, null, '可加入'],
    ])
    expect(summarizeUnassigned(roster.students)).toBe('2 人未分組・0 人公開找隊員・0 份建立中')
  })

  it('不是 uuid 的屆別回空的', async () => {
    expect(await query.roster('nope')).toEqual({ students: [], groups: [] })
  })
})
