import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Pool } from 'pg'
import { assertTestDatabaseReachable, createIsolatedDatabase, poolAsRole, type IsolatedDatabase } from '../../../test/db'
import { enableFaultInjection, failAt, injectFault } from '../../../test/fault-injection'
import { migratedSchema } from '../../../test/migrations'
import type { ResolvedActor } from '@/application/accounts'
import type { SchemeStageInput } from '@/application/grading'
import { PgGradingDissolution } from '@/infrastructure/grading/pg-grading-dissolution'
import { PgGradingCommand } from '@/infrastructure/grading/pg-grading'
import { PgGradebookQuery } from '@/infrastructure/grading/pg-grading-results'
import { PgGroupCommand, PgGroupQuery } from '@/infrastructure/groups/pg-groups'
import { PgDueWorkScheduler } from '@/infrastructure/notifications/pg-due-work-scheduler'
import { PgEventPublisher } from '@/infrastructure/notifications/pg-event-publisher'
import { PgAuditWriter } from '@/infrastructure/ops/audit-writer'
import { FsFileStorage } from '@/infrastructure/ops/file-storage'
import { PgOperationLedger } from '@/infrastructure/ops/operation-ledger'
import { createPosterPolicy } from '@/infrastructure/showcase/poster-policy'
import { PgSignoffCommand } from '@/infrastructure/signoff/pg-signoff'

/**
 * 開站後：系辦解散組別（最小版；產品模組 03 §4「換成員與解散」、08 §4「組別解散」；模組實作設計 03 §6）。
 *
 * 全部以正式執行角色 `fju_app` 連線（組員／組長／評分指派只能改結束欄，寫錯這裡直接紅）。驗：
 * - 權限：只有系辦；理由必填；版本過舊 CONFLICT；封存屆 COHORT_ARCHIVED；已解散再解散 GROUP_DISSOLVED；同請求重送同一張回執。
 * - 同一筆交易：組員資格、組長列、評分指派、暫存、簽核、組別、事件、稽核、帳本——中途失敗全部不動。
 * - 組員快照與方案版本記在稽核；成績表照快照列組員（解散前一刻被移出的人不列，即使時間戳記相同）。
 * - 凍結：之後調整組員、換組長、指派評分、老師送分、建簽核版本都被拒；已送出的分數照舊採計、不標「已改派」。
 * - 通知：解散前有效成員 ∪ 主指導 ∪ 評分工作停止的老師，一則、去重、不帶理由。
 * - 並發：解散寫到一半時老師送分 → 等解散 commit 後被拒，不會多一份分數。
 */

let owner: IsolatedDatabase
let app: Pool
let root: string
let adminId: string
const businessClock = { now: async () => new Date('2026-12-01T02:00:00Z') }

let groups: PgGroupCommand
let groupQuery: PgGroupQuery
let grading: PgGradingCommand
let book: PgGradebookQuery
let signoff: PgSignoffCommand

function actor(userId: string, roles: ('admin' | 'teacher' | 'student')[]): ResolvedActor {
  return { kind: 'authenticated', userId, roles, status: 'active', mustChangePassword: false, cohortMemberships: [] }
}
const admin = () => actor(adminId, ['admin'])

let seq = 0
async function newUser(name: string, role: 'admin' | 'teacher' | 'student', cohortId: string | null = null): Promise<string> {
  seq += 1
  const email = `dis${seq}-${randomUUID().slice(0, 8)}@example.com`
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
    [id, name, studentNo, cohortId, `c-${email}`],
  )
  if (studentNo && cohortId) {
    await owner.sql(`insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)`, [cohortId, studentNo, id])
  }
  return id
}

const STAGES: SchemeStageInput[] = [
  { key: 'mid', name: '期中', weight: 60, items: [{ key: 'i1', name: '總分', type: 'number', max: 100, weight: 100 }] },
  { key: 'fin', name: '期末', weight: 40, items: [{ key: 'i1', name: '總分', type: 'number', max: 100, weight: 100 }] },
]

async function must<T>(p: Promise<{ ok: true; receipt: T } | { ok: false; code: string; message: string }>): Promise<T> {
  const r = await p
  if (!r.ok) throw new Error(`${r.code} ${r.message}`)
  return r.receipt
}

/**
 * 三人組 G01（S1 組長）、主指導 T0；方案期中兩份、期末一份：T1 期中已送出 80、T2 期中只存暫存、T3 期末還沒動；
 * 一個進行中的簽核版本。
 */
async function scenario() {
  seq += 1
  const cohort = await owner.sql(
    `insert into cohorts (id, code, name, status, year_end_date, group_size_min, group_size_max, created_by_kind)
     values (gen_random_uuid(), $1, $1, 'active', '2027-06-30', 3, 5, 'system') returning id`,
    [`DIS-${seq}`],
  )
  const cohortId = String(cohort.rows[0]!.id)
  const [s1, s2, s3] = [await newUser('學生甲', 'student', cohortId), await newUser('學生乙', 'student', cohortId), await newUser('學生丙', 'student', cohortId)]
  const [t0, t1, t2, t3] = [
    await newUser('主指導', 'teacher'),
    await newUser('評分一', 'teacher'),
    await newUser('評分二', 'teacher'),
    await newUser('評分三', 'teacher'),
  ]
  const group = await owner.sql(
    `insert into groups (id, cohort_id, code, group_type, established_real_at, established_business_at, created_by_kind)
     values (gen_random_uuid(), $1, 'G01', 'general', now(), now() - interval '30 days', 'system') returning id`,
    [cohortId],
  )
  const groupId = String(group.rows[0]!.id)
  for (const m of [s1, s2, s3]) {
    await owner.sql(
      `insert into group_memberships (id, group_id, cohort_id, user_id, valid_from, added_by_kind)
       values (gen_random_uuid(), $1, $2, $3, now() - interval '30 days', 'system')`,
      [groupId, cohortId, m],
    )
  }
  await owner.sql(
    `insert into group_leaders (id, group_id, user_id, valid_from, changed_by_user_id) values (gen_random_uuid(), $1, $2, now() - interval '30 days', $3)`,
    [groupId, s1, adminId],
  )
  await owner.sql(
    `insert into advisor_assignments (id, group_id, teacher_user_id, source, valid_from, assigned_by_user_id, reason)
     values (gen_random_uuid(), $1, $2, 'admin', now() - interval '30 days', $3, '指派')`,
    [groupId, t0, adminId],
  )

  const created = await must(grading.createSchemeVersion(admin(), { cohortId, stages: STAGES }, randomUUID()))
  await must(grading.publishScheme(admin(), { versionId: created.versionId }, randomUUID()))
  await must(grading.setRequirement(admin(), { groupId, stageKey: 'mid', requiredCount: 2, revision: 0 }, randomUUID()))
  await must(grading.setRequirement(admin(), { groupId, stageKey: 'fin', requiredCount: 1, revision: 0 }, randomUUID()))
  const a1 = (await must(grading.assign(admin(), { groupId, stageKey: 'mid', teacherUserId: t1 }, randomUUID()))).assignmentId
  const a2 = (await must(grading.assign(admin(), { groupId, stageKey: 'mid', teacherUserId: t2 }, randomUUID()))).assignmentId
  const a3 = (await must(grading.assign(admin(), { groupId, stageKey: 'fin', teacherUserId: t3 }, randomUUID()))).assignmentId
  const counted = (await must(grading.submitFinal(actor(t1, ['teacher']), { assignmentId: a1, scores: { i1: '80' } }, randomUUID()))).evaluationId
  const draft = (await must(grading.saveDraft(actor(t2, ['teacher']), { assignmentId: a2, scores: { i1: '70' } }, randomUUID()))).evaluationId
  const version = await must(
    signoff.createVersion(
      admin(),
      { groupId, purpose: 'result_confirmation', content: '本組確認期中結果。', attachmentFileIds: [], showcaseEntryId: null },
      randomUUID(),
    ),
  )
  return { cohortId, groupId, s1, s2, s3, t0, t1, t2, t3, a1, a2, a3, counted, draft, schemeVersionId: created.versionId, signoffVersionId: version.versionId }
}

type Scenario = Awaited<ReturnType<typeof scenario>>

async function revisionOf(groupId: string): Promise<number> {
  return Number((await owner.sql('select revision from groups where id = $1', [groupId])).rows[0]!.revision)
}

async function count(sql: string, values: unknown[] = []): Promise<number> {
  return Number((await owner.sql(sql, values)).rows[0]!.n)
}

function dissolve(s: Scenario, overrides: { revision?: number; reason?: string; requestId?: string; as?: ResolvedActor } = {}) {
  return (async () =>
    groups.dissolveGroup(
      overrides.as ?? admin(),
      { groupId: s.groupId, revision: overrides.revision ?? (await revisionOf(s.groupId)), reason: overrides.reason ?? '全組休學' },
      overrides.requestId ?? randomUUID(),
    ))()
}

/** 被拒或回滾時「完全沒動」的證據。 */
async function footprint(s: Scenario) {
  const q = async (sql: string) => (await owner.sql(sql, [s.groupId])).rows
  return {
    group: await q('select status, dissolved_real_at, dissolve_reason, revision from groups where id = $1'),
    members: await q('select id, valid_to, removal_reason, updated_at from group_memberships where group_id = $1 order by id'),
    leaders: await q('select id, valid_to from group_leaders where group_id = $1 order by id'),
    assignments: await q('select id, valid_to, removal_choice, revision from evaluator_assignments where group_id = $1 order by id'),
    evaluations: await q(
      `select s.evaluation_id, s.state from evaluation_status s join evaluator_assignments a on a.id = s.assignment_id
        where a.group_id = $1 order by s.evaluation_id`,
    ),
    signoff: await q(
      `select s.version_id, s.state from signoff_version_status s join signoff_package_versions v on v.id = s.version_id
         join signoff_packages p on p.id = v.package_id where p.group_id = $1 order by s.version_id`,
    ),
    events: await count(`select count(*) as n from domain_events where type = 'group.dissolved' and source_id = $1`, [s.groupId]),
    audits: await count(`select count(*) as n from audit_events where action = 'group.dissolve' and target_id = $1`, [s.groupId]),
    ledger: await count(`select count(*) as n from operation_records where operation_kind = 'group.dissolve' and actor_user_id = $1`, [adminId]),
  }
}

beforeAll(async () => {
  await assertTestDatabaseReachable()
  owner = await createIsolatedDatabase({ label: 'dissolve', setup: migratedSchema })
  app = await poolAsRole(owner, 'fju_app')
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'fju-dissolve-files-'))
  const a = await owner.sql(
    `insert into users (id, name, email, email_verified, updated_at, status) values (gen_random_uuid(), '系辦', 'dis-admin@example.com', true, now(), 'active') returning id`,
  )
  adminId = String(a.rows[0]!.id)
  await owner.sql(
    `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at) values (gen_random_uuid(), $1, 'admin', $1, now())`,
    [adminId],
  )
  const storage = new FsFileStorage({
    root: () => root,
    environmentMaxBytes: () => 100 * 1024 * 1024,
    ticketSecret: () => 'dissolve-secret-dissolve-secret-dissolve-secret',
    policies: { poster: createPosterPolicy(() => app) },
    db: () => app,
  })
  const common = { audit: new PgAuditWriter(), ledger: new PgOperationLedger(() => app), businessClock, pool: () => app }
  signoff = new PgSignoffCommand({ ...common, events: new PgEventPublisher(), files: storage })
  grading = new PgGradingCommand({ ...common, events: new PgEventPublisher() })
  book = new PgGradebookQuery(() => app)
  groups = new PgGroupCommand({
    ...common,
    events: new PgEventPublisher(),
    dueWork: new PgDueWorkScheduler({ testKindsEnabled: false }),
    signoff,
    grading: new PgGradingDissolution(),
  })
  groupQuery = new PgGroupQuery(() => app)
})

afterAll(async () => {
  await app?.end()
  await owner?.close()
  await fs.rm(root, { recursive: true, force: true })
})

describe('權限與拒絕', () => {
  it('學生、老師不能解散；理由空白、版本過舊被拒；全部不動', async () => {
    const s = await scenario()
    const before = await footprint(s)
    expect(await dissolve(s, { as: actor(s.s1, ['student']) })).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(await dissolve(s, { as: actor(s.t0, ['teacher']) })).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(await dissolve(s, { reason: '   ' })).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', details: { field: 'reason' } })
    expect(await dissolve(s, { revision: (await revisionOf(s.groupId)) - 1 })).toMatchObject({ ok: false, code: 'CONFLICT' })
    expect(await footprint(s)).toEqual(before)
  })

  it('封存屆別的組不能解散', async () => {
    const s = await scenario()
    await owner.sql(`update cohorts set status = 'archived' where id = $1`, [s.cohortId])
    expect(await dissolve(s)).toMatchObject({ ok: false, code: 'COHORT_ARCHIVED' })
    expect((await owner.sql('select status from groups where id = $1', [s.groupId])).rows[0]!.status).toBe('active')
  })

  it('已解散再解散 → GROUP_DISSOLVED；同一請求重送拿同一張回執、只有一筆', async () => {
    const s = await scenario()
    const requestId = randomUUID()
    const revision = await revisionOf(s.groupId)
    const first = await dissolve(s, { requestId, revision })
    expect(first).toMatchObject({ ok: true })
    expect(await dissolve(s, { requestId, revision })).toEqual(first)
    const after = await footprint(s)
    expect(await dissolve(s)).toMatchObject({ ok: false, code: 'GROUP_DISSOLVED' })
    expect(await footprint(s)).toEqual(after)
    expect(after.events).toBe(1)
    expect(after.audits).toBe(1)
  })
})

describe('同一筆交易', () => {
  it('寫到最後一步失敗 → 組員、組長、評分、簽核、組別、事件、稽核、帳本全部回到原樣', async () => {
    const s = await scenario()
    const before = await footprint(s)
    const disable = enableFaultInjection()
    try {
      failAt('group.dissolve.after-writes')
      expect(await dissolve(s)).toMatchObject({ ok: false, code: 'INTERNAL' })
    } finally {
      disable()
    }
    expect(await footprint(s)).toEqual(before)
  })

  it('成功：組員資格與組長列結束、評分指派結束、暫存失效、簽核作廢、組別凍結；快照與方案版本記在稽核', async () => {
    const s = await scenario()
    // 解散前先移出丙（一般移出）：之後的快照、通知都不該有他。
    const removed = await groups.removeMember(
      admin(),
      { groupId: s.groupId, revision: await revisionOf(s.groupId), userId: s.s3, reason: '轉系', successorLeaderUserId: null },
      randomUUID(),
    )
    expect(removed).toMatchObject({ ok: true })
    // 移出讓原簽核版本失效（票 25）；系辦重建一版給剩下兩人——解散要作廢的是這一版。
    const fresh = await must(
      signoff.createVersion(
        admin(),
        { groupId: s.groupId, purpose: 'result_confirmation', content: '本組確認期中結果（兩人）。', attachmentFileIds: [], showcaseEntryId: null },
        randomUUID(),
      ),
    )
    const revision = await revisionOf(s.groupId)

    const result = await dissolve(s, { revision, reason: '全組休學' })
    expect(result).toMatchObject({
      ok: true,
      receipt: { groupCode: 'G01', memberNames: ['學生甲', '學生乙'], endedAssignments: 3, invalidatedDrafts: 1, voidedSignoffs: 1, notified: 6 },
    })

    const head = (await owner.sql('select status, dissolved_real_at, dissolve_reason, revision from groups where id = $1', [s.groupId])).rows[0]!
    expect(head).toMatchObject({ status: 'dissolved', dissolve_reason: '全組休學', revision: revision + 1 })
    const at = (head.dissolved_real_at as Date).getTime()

    const members = (await owner.sql('select user_id, valid_to, removal_reason, updated_at from group_memberships where group_id = $1', [s.groupId]))
      .rows
    expect(members.every((m) => m.valid_to !== null)).toBe(true)
    for (const m of members.filter((m) => m.user_id !== s.s3)) {
      expect(m).toMatchObject({ removal_reason: '組別解散：全組休學' })
      expect((m.updated_at as Date).getTime()).toBe(at)
    }
    expect(await count('select count(*) as n from group_leaders where group_id = $1 and valid_to is null', [s.groupId])).toBe(0)

    const assignments = (await owner.sql('select valid_to, removal_choice, ended_real_at, reason from evaluator_assignments where group_id = $1', [s.groupId]))
      .rows
    expect(assignments).toHaveLength(3)
    for (const a of assignments) {
      expect(a).toMatchObject({ removal_choice: null, reason: '組別解散：全組休學' })
      expect((a.ended_real_at as Date).getTime()).toBe(at)
    }
    expect((await owner.sql('select state from evaluation_status where evaluation_id = $1', [s.draft])).rows[0]!.state).toBe('invalidated')
    expect((await owner.sql('select state from evaluation_status where evaluation_id = $1', [s.counted])).rows[0]!.state).toBe('counted')
    expect(
      await count(`select count(*) as n from evaluation_status_events where evaluation_id = $1 and to_state = 'invalidated'`, [s.draft]),
    ).toBe(1)
    expect((await owner.sql('select state, cause from signoff_version_status where version_id = $1', [fresh.versionId])).rows[0]).toEqual({
      state: 'void',
      cause: '組別解散：全組休學',
    })
    // 已失效的舊版不動（失效原因寫了就不能改）。
    expect((await owner.sql('select state from signoff_version_status where version_id = $1', [s.signoffVersionId])).rows[0]!.state).toBe('superseded')

    const audit = (await owner.sql(`select reason, payload from audit_events where action = 'group.dissolve' and target_id = $1`, [s.groupId])).rows[0]!
    expect(audit.reason).toBe('全組休學')
    const payload = audit.payload as { members: { userId: string; isLeader: boolean }[]; schemeVersionId: string; leaderUserId: string }
    expect(payload.members.map((m) => m.userId).sort()).toEqual([s.s1, s.s2].sort())
    expect(payload.members.find((m) => m.userId === s.s1)?.isLeader).toBe(true)
    expect(payload).toMatchObject({ schemeVersionId: s.schemeVersionId, leaderUserId: s.s1 })
    // 稽核只記 id：姓名、學號不進不可變的稽核（去識別化要清得掉）。
    expect(JSON.stringify(payload)).not.toContain('學生甲')
  })
})

describe('通知', () => {
  it('解散前有效成員、主指導、評分工作停止的老師各一則；被移出的、系辦不收；不帶理由', async () => {
    const s = await scenario()
    await groups.removeMember(
      admin(),
      { groupId: s.groupId, revision: await revisionOf(s.groupId), userId: s.s3, reason: '轉系', successorLeaderUserId: null },
      randomUUID(),
    )
    // 主指導也是期中評分老師：只收一則。
    await must(grading.assign(admin(), { groupId: s.groupId, stageKey: 'fin', teacherUserId: s.t0 }, randomUUID()))
    expect(await dissolve(s, { reason: '機密理由不外流' })).toMatchObject({ ok: true })

    const events = (
      await owner.sql(`select recipients::text[] as recipients, payload from domain_events where type = 'group.dissolved' and source_id = $1`, [
        s.groupId,
      ])
    ).rows
    expect(events).toHaveLength(1)
    expect(JSON.stringify(events[0]!.payload)).not.toContain('機密理由')
    expect((events[0]!.recipients as string[]).sort()).toEqual([s.s1, s.s2, s.t0, s.t1, s.t2, s.t3].sort())
  })
})

describe('解散後：凍結、可查、可匯出', () => {
  it('調整組員、換組長、指派評分、老師送分、建簽核版本全部被拒', async () => {
    const s = await scenario()
    expect(await dissolve(s)).toMatchObject({ ok: true })
    const revision = await revisionOf(s.groupId)
    const other = await newUser('新同學', 'student', s.cohortId)
    const studentNo = String((await owner.sql('select student_no from user_profiles where user_id = $1', [other])).rows[0]!.student_no)

    expect(await groups.addMember(admin(), { groupId: s.groupId, revision, studentNo, reason: '加入' }, randomUUID())).toMatchObject({
      code: 'GROUP_DISSOLVED',
    })
    expect(
      await groups.removeMember(admin(), { groupId: s.groupId, revision, userId: s.s2, reason: '移出', successorLeaderUserId: null }, randomUUID()),
    ).toMatchObject({ code: 'GROUP_DISSOLVED' })
    expect(await groups.changeLeader(admin(), { groupId: s.groupId, revision, newLeaderUserId: s.s2, reason: '換' }, randomUUID())).toMatchObject({
      code: 'GROUP_DISSOLVED',
    })
    expect(await grading.assign(admin(), { groupId: s.groupId, stageKey: 'fin', teacherUserId: s.t1 }, randomUUID())).toMatchObject({
      code: 'GROUP_DISSOLVED',
    })
    // 指派已結束：老師送分被拒（不透露組別狀態，回「沒有指派」）。
    expect(await grading.submitFinal(actor(s.t2, ['teacher']), { assignmentId: s.a2, scores: { i1: '75' } }, randomUUID())).toMatchObject({
      ok: false,
    })
    expect(
      await signoff.createVersion(
        admin(),
        { groupId: s.groupId, purpose: 'result_confirmation', content: '再建一版', attachmentFileIds: [], showcaseEntryId: null },
        randomUUID(),
      ),
    ).toMatchObject({ code: 'GROUP_DISSOLVED' })
    expect(await count(`select count(*) as n from evaluations e join evaluator_assignments a on a.id = e.assignment_id where a.group_id = $1`, [s.groupId])).toBe(2)
  })

  it('成績表照快照列組員（解散前一刻被移出、時間戳記相同的人也不列）；已送出分數照舊、不標已改派；方案版本釘在解散當下', async () => {
    const s = await scenario()
    await groups.removeMember(
      admin(),
      { groupId: s.groupId, revision: await revisionOf(s.groupId), userId: s.s3, reason: '轉系', successorLeaderUserId: null },
      randomUUID(),
    )
    expect(await dissolve(s)).toMatchObject({ ok: true })
    // 模擬 Codex 4102689444：移出與解散拿到同一毫秒的時間 → 舊的時間比對會把丙誤收進快照。
    await owner.sql(
      `update group_memberships m set updated_at = g.dissolved_real_at from groups g where g.id = m.group_id and m.group_id = $1 and m.user_id = $2`,
      [s.groupId, s.s3],
    )
    // 解散後另發布一個新版本：解散的組仍照解散當下那一版。
    const next = await must(grading.createSchemeVersion(admin(), { cohortId: s.cohortId, stages: STAGES.map((x) => ({ ...x, name: `${x.name}新` })) }, randomUUID()))
    await grading.publishScheme(admin(), { versionId: next.versionId }, randomUUID())

    const r = await book.gradebook(admin(), s.cohortId)
    if (!r.ok) throw new Error(r.message)
    const row = r.receipt.groups.find((g) => g.id === s.groupId)!
    expect(row).toMatchObject({ dissolved: true })
    expect(row.members.map((m) => m.name).sort()).toEqual(['學生乙', '學生甲'])
    const mid = row.result.stages.find((x) => x.key === 'mid')!
    expect(mid.counted.map((c) => [c.teacherName, c.assignmentEnded])).toEqual([['評分一', false]])
    expect(row.result.stages.map((x) => x.name)).toEqual(['期中', '期末'])
  })

  it('原組員回到未分組；分組總覽的「已解散的組別」列出時間、理由與成員快照', async () => {
    const s = await scenario()
    expect(await dissolve(s, { reason: '全組轉系' })).toMatchObject({ ok: true })
    const overview = await groupQuery.overview(s.cohortId)
    expect(overview.groups.map((g) => g.id)).not.toContain(s.groupId)
    const ungrouped = overview.ungrouped.map((u) => u.name)
    expect(ungrouped).toEqual(expect.arrayContaining(['學生甲', '學生乙', '學生丙']))
    const dissolved = await groupQuery.dissolvedGroups(s.cohortId)
    expect(dissolved).toHaveLength(1)
    expect(dissolved[0]).toMatchObject({ id: s.groupId, code: 'G01', reason: '全組轉系' })
    expect(dissolved[0]!.members.map((m) => [m.name, m.isLeader])).toEqual([
      ['學生甲', true],
      ['學生乙', false],
      ['學生丙', false],
    ])
  })
})

describe('並發', () => {
  it('解散寫到一半、老師同時送分：送分等解散 commit 後被拒，不會多一份分數', async () => {
    const s = await scenario()
    const disable = enableFaultInjection()
    try {
      let reached!: () => void
      const arrived = new Promise<void>((resolve) => (reached = resolve))
      let release!: () => void
      const held = new Promise<void>((resolve) => (release = resolve))
      injectFault('group.dissolve.after-writes', async () => {
        reached()
        await held
      })
      const dissolving = dissolve(s)
      await arrived
      const submitting = grading.submitFinal(actor(s.t2, ['teacher']), { assignmentId: s.a2, scores: { i1: '75' } }, randomUUID())
      for (let i = 0; i < 300; i += 1) {
        const waiting = await owner.sql(`select count(*) as n from pg_locks where not granted`)
        if (Number(waiting.rows[0]!.n) > 0) break
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      release()
      expect(await dissolving).toMatchObject({ ok: true })
      expect(await submitting).toMatchObject({ ok: false })
    } finally {
      disable()
    }
    expect(await count(`select count(*) as n from evaluation_status where assignment_id = $1 and state = 'counted'`, [s.a2])).toBe(0)
  })
})
