import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { assertTestDatabaseReachable, createIsolatedDatabase, poolAsRole, type IsolatedDatabase } from '../../../test/db'
import { migratedSchema } from '../../../test/migrations'
import type { ResolvedActor } from '@/application/accounts'
import type { SchemeStageInput } from '@/application/grading'
import type { GroupVersionWithFiles } from '@/application/submissions'
import { teacherProgress } from '@/app/dashboard/admin/grading/progress'
import { latestEvaluations, PgGradingCommand, PgGradingQuery } from '@/infrastructure/grading/pg-grading'
import { PgGradebookQuery } from '@/infrastructure/grading/pg-grading-results'
import { PgEventPublisher } from '@/infrastructure/notifications/pg-event-publisher'
import { PgAuditWriter } from '@/infrastructure/ops/audit-writer'
import { PgOperationLedger } from '@/infrastructure/ops/operation-ledger'

/**
 * 票 23：評分方案、指派與老師評分（產品模組 06 §4「7.2」「7.4」「7.6」；GRD-01、02、03、04、11、12）。
 *
 * 全部以正式執行角色 `fju_app` 連線（欄級 GRANT 與 trigger 寫錯的話這裡直接紅）。
 * 權重檢查、鎖定、可見性（暫存只有本人與管理員、學生一律 FORBIDDEN）、冪等（同請求編號重送、並發送出只一筆採計）。
 */

let owner: IsolatedDatabase
let app: Pool
let adminId: string
const businessNow = new Date('2026-12-01T02:00:00Z')
const businessClock = { now: async () => new Date(businessNow.getTime()) }

let command: PgGradingCommand
let query: PgGradingQuery

function actor(userId: string, roles: ('admin' | 'teacher' | 'student')[]): ResolvedActor {
  return { kind: 'authenticated', userId, roles, status: 'active', mustChangePassword: false, cohortMemberships: [] }
}
const adminActor = () => actor(adminId, ['admin'])
const teacherActor = (t: { id: string }) => actor(t.id, ['teacher'])

let seq = 0
async function newUser(name: string, role: 'admin' | 'teacher' | 'student' | null): Promise<string> {
  seq += 1
  const row = await owner.sql(
    `insert into users (id, name, email, email_verified, updated_at, status)
     values (gen_random_uuid(), $1, $2, true, now(), 'active') returning id`,
    [name, `g${seq}-${randomUUID().slice(0, 8)}@example.com`],
  )
  const id = String(row.rows[0]!.id)
  if (role) {
    await owner.sql(
      `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at) values (gen_random_uuid(), $1, $2, $1, now())`,
      [id, role],
    )
    await owner.sql(
      `insert into user_profiles (user_id, display_name, name_normalized, contact_email) values ($1, $2, $2, $3)`,
      [id, name, `c${seq}@example.com`],
    )
  }
  return id
}

async function newCohort(status: 'active' | 'archived' = 'active'): Promise<string> {
  seq += 1
  const row = await owner.sql(
    `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
     values (gen_random_uuid(), $1, $1, $2, '2027-06-30', 'system') returning id`,
    [`T23-${seq}`, status],
  )
  return String(row.rows[0]!.id)
}

async function newGroup(cohortId: string, code: string, memberIds: string[] = []): Promise<string> {
  const row = await owner.sql(
    `insert into groups (id, cohort_id, code, group_type, established_real_at, established_business_at, created_by_kind)
     values (gen_random_uuid(), $1, $2, 'general', now(), now(), 'system') returning id`,
    [cohortId, code],
  )
  const id = String(row.rows[0]!.id)
  for (const m of memberIds) {
    await owner.sql(
      `insert into group_memberships (id, group_id, cohort_id, user_id, valid_from, added_by_kind)
       values (gen_random_uuid(), $1, $2, $3, now(), 'system')`,
      [id, cohortId, m],
    )
  }
  return id
}

const STAGES: SchemeStageInput[] = [
  {
    name: '系統驗收',
    weight: 60,
    items: [
      { name: '功能完整', type: 'number', max: 100, weight: 50 },
      { name: '文件', type: 'number', max: 100, weight: 50 },
    ],
  },
  { name: '專題發表', weight: 40, items: [{ name: '發表', type: 'number', max: 100, weight: 100 }] },
]

async function publishedScheme(cohortId: string): Promise<{ versionId: string }> {
  const created = await command.createSchemeVersion(adminActor(), { cohortId, stages: STAGES }, randomUUID())
  if (!created.ok) throw new Error(created.message)
  const published = await command.publishScheme(adminActor(), { versionId: created.receipt.versionId }, randomUUID())
  if (!published.ok) throw new Error(published.message)
  return { versionId: created.receipt.versionId }
}

async function assignOk(groupId: string, teacherId: string, stageKey = 's1'): Promise<string> {
  const r = await command.assign(adminActor(), { groupId, stageKey, teacherUserId: teacherId }, randomUUID())
  if (!r.ok) throw new Error(r.message)
  return r.receipt.assignmentId
}

async function countedCount(assignmentId: string): Promise<number> {
  return stateCount(assignmentId, 'counted')
}

async function stateCount(assignmentId: string, state: string): Promise<number> {
  const r = await owner.sql(`select count(*)::int as n from evaluation_status where assignment_id = $1 and state = $2`, [assignmentId, state])
  return Number(r.rows[0]!.n)
}

beforeAll(async () => {
  await assertTestDatabaseReachable()
  owner = await createIsolatedDatabase({ label: 'grading', setup: migratedSchema })
  app = await poolAsRole(owner, 'fju_app')
  adminId = await newUser('系辦', 'admin')
  const deps = {
    audit: new PgAuditWriter(),
    ledger: new PgOperationLedger(() => app),
    events: new PgEventPublisher(),
    businessClock,
    pool: () => app,
  }
  command = new PgGradingCommand(deps)
  query = new PgGradingQuery(() => app)
})

afterAll(async () => {
  await app?.end()
  await owner?.close()
})

describe('評分方案版本（GRD-01）', () => {
  it('權重 60／50 被拒、什麼都沒建；60／40 建成草稿 v1 → 發布；同一個請求編號重送回原回執', async () => {
    const cohortId = await newCohort()
    const bad = await command.createSchemeVersion(
      adminActor(),
      { cohortId, stages: [{ ...STAGES[0]!, weight: 60 }, { ...STAGES[1]!, weight: 50 }] },
      randomUUID(),
    )
    expect(bad).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', details: { field: 'stageWeights' } })
    expect((await owner.sql('select count(*)::int as n from grading_schemes where cohort_id = $1', [cohortId])).rows[0]!.n).toBe(0)

    const requestId = randomUUID()
    const created = await command.createSchemeVersion(adminActor(), { cohortId, stages: STAGES }, requestId)
    expect(created).toMatchObject({ ok: true, receipt: { versionNo: 1, status: 'draft' } })
    const again = await command.createSchemeVersion(adminActor(), { cohortId, stages: STAGES }, requestId)
    expect(again.ok && created.ok && again.receipt.versionId).toBe(created.ok && created.receipt.versionId)
    expect(
      (await owner.sql('select count(*)::int as n from grading_scheme_versions v join grading_schemes s on s.id = v.scheme_id where s.cohort_id = $1', [cohortId])).rows[0]!.n,
    ).toBe(1)
    // 同一個編號配不同內容：REQUEST_MISMATCH。
    expect(await command.createSchemeVersion(adminActor(), { cohortId, stages: [STAGES[0]!, { ...STAGES[1]!, name: '改名' }] }, requestId)).toMatchObject({
      ok: false,
      code: 'REQUEST_MISMATCH',
    })

    const versionId = created.ok ? created.receipt.versionId : ''
    const published = await command.publishScheme(adminActor(), { versionId }, randomUUID())
    expect(published).toMatchObject({ ok: true, receipt: { status: 'published', versionNo: 1 } })
    const board = await query.adminBoard(adminActor(), cohortId)
    expect(board.ok && board.receipt.current).toMatchObject({ versionNo: 1, status: 'published', isCurrent: true })
    expect(await command.publishScheme(adminActor(), { versionId }, randomUUID())).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
  })

  it('老師、學生直接呼叫建方案、發布、設份數、指派：FORBIDDEN', async () => {
    const cohortId = await newCohort()
    const teacher = await newUser('老師', 'teacher')
    const student = await newUser('學生', 'student')
    for (const who of [actor(teacher, ['teacher']), actor(student, ['student'])]) {
      expect(await command.createSchemeVersion(who, { cohortId, stages: STAGES }, randomUUID())).toMatchObject({ code: 'FORBIDDEN' })
      expect(await command.publishScheme(who, { versionId: randomUUID() }, randomUUID())).toMatchObject({ code: 'FORBIDDEN' })
      expect(
        await command.setRequirement(who, { groupId: randomUUID(), stageKey: 's1', requiredCount: 2, revision: 0 }, randomUUID()),
      ).toMatchObject({ code: 'FORBIDDEN' })
      expect(await command.assign(who, { groupId: randomUUID(), stageKey: 's1', teacherUserId: teacher }, randomUUID())).toMatchObject({
        code: 'FORBIDDEN',
      })
      expect(await query.adminBoard(who, cohortId)).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    }
  })

  it('封存的屆別不能建方案', async () => {
    const cohortId = await newCohort('archived')
    expect(await command.createSchemeVersion(adminActor(), { cohortId, stages: STAGES }, randomUUID())).toMatchObject({
      ok: false,
      code: 'COHORT_ARCHIVED',
    })
  })

  it('兩位管理員同時建版本：版本號不重複（方案頭列 FOR UPDATE）', async () => {
    const cohortId = await newCohort()
    const results = await Promise.all(
      [1, 2, 3].map(() => command.createSchemeVersion(adminActor(), { cohortId, stages: STAGES }, randomUUID())),
    )
    expect(results.every((r) => r.ok)).toBe(true)
    expect(results.map((r) => (r.ok ? r.receipt.versionNo : 0)).sort()).toEqual([1, 2, 3])
  })

  it('發布前可以換版本；新版本不能拿掉已經有指派的階段', async () => {
    const cohortId = await newCohort()
    await publishedScheme(cohortId)
    const groupId = await newGroup(cohortId, 'G01')
    const teacher = await newUser('老師', 'teacher')
    await assignOk(groupId, teacher, 's2')

    const onlyFirst = await command.createSchemeVersion(adminActor(), { cohortId, stages: [{ ...STAGES[0]!, key: 's1', weight: 100 }] }, randomUUID())
    expect(onlyFirst.ok).toBe(true)
    const blocked = await command.publishScheme(adminActor(), { versionId: onlyFirst.ok ? onlyFirst.receipt.versionId : '' }, randomUUID())
    expect(blocked).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    if (!blocked.ok) expect(blocked.message).toContain('「專題發表」')

    const renamed = await command.createSchemeVersion(
      adminActor(),
      { cohortId, stages: [{ ...STAGES[0]!, key: 's1' }, { ...STAGES[1]!, key: 's2', name: '成果發表' }] },
      randomUUID(),
    )
    const ok = await command.publishScheme(adminActor(), { versionId: renamed.ok ? renamed.receipt.versionId : '' }, randomUUID())
    expect(ok).toMatchObject({ ok: true, receipt: { versionNo: 3 } })
  })
})

describe('代號不重用（審查 P1）：刪掉階段或項目再新增，不會繼承舊的要求份數、指派、暫存', () => {
  it('刪掉有要求份數與指派的 s1、新增一個階段：新階段拿 s3；發布被擋（舊指派不會默默接到新階段）', async () => {
    const cohortId = await newCohort()
    await publishedScheme(cohortId)
    const groupId = await newGroup(cohortId, 'G01')
    const teacher = await newUser('老師', 'teacher')
    await command.setRequirement(adminActor(), { groupId, stageKey: 's1', requiredCount: 2, revision: 0 }, randomUUID())
    await assignOk(groupId, teacher, 's1')

    const v2 = await command.createSchemeVersion(
      adminActor(),
      { cohortId, stages: [{ ...STAGES[1]!, key: 's2', weight: 50 }, { ...STAGES[0]!, name: '新的驗收', weight: 50 }] },
      randomUUID(),
    )
    expect(v2.ok).toBe(true)
    const stored = await owner.sql('select stages from grading_scheme_versions where id = $1', [v2.ok ? v2.receipt.versionId : ''])
    const keys = (stored.rows[0]!.stages as { key: string; items: { key: string }[] }[]).map((st) => st.key)
    expect(keys).toEqual(['s2', 's3'])
    const blocked = await command.publishScheme(adminActor(), { versionId: v2.ok ? v2.receipt.versionId : '' }, randomUUID())
    expect(blocked).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    if (!blocked.ok) expect(blocked.message).toContain('「系統驗收」')
  })

  it('刪掉沒在用的 s1（份數 0）再新增：發布成功，新階段沒有任何要求份數、指派；新項目代號不撞舊項目', async () => {
    const cohortId = await newCohort()
    await publishedScheme(cohortId)
    const groupId = await newGroup(cohortId, 'G01')
    await command.setRequirement(adminActor(), { groupId, stageKey: 's1', requiredCount: 0, revision: 0 }, randomUUID())

    const v2 = await command.createSchemeVersion(
      adminActor(),
      {
        cohortId,
        stages: [
          { key: 's2', name: '專題發表', weight: 50, items: [{ name: '新發表項目', type: 'number', max: 100, weight: 100 }] },
          { name: '新的驗收', weight: 50, items: [{ name: '新項目', type: 'number', max: 100, weight: 100 }] },
        ],
      },
      randomUUID(),
    )
    const published = await command.publishScheme(adminActor(), { versionId: v2.ok ? v2.receipt.versionId : '' }, randomUUID())
    expect(published).toMatchObject({ ok: true, receipt: { versionNo: 2 } })
    const board = await query.adminBoard(adminActor(), cohortId)
    if (!board.ok) throw new Error(board.message)
    const current = board.receipt.current!
    expect(current.stages.map((st) => st.key)).toEqual(['s2', 's3'])
    // v1 的項目是 i1、i2（系統驗收）、i3（專題發表）；新項目都是新代號。
    expect(current.stages.flatMap((st) => st.items.map((i) => i.key))).toEqual(['i4', 'i5'])
    expect(board.receipt.requirements.filter((r) => r.stageKey === 's3')).toEqual([])
    expect(board.receipt.assignments.filter((a) => a.stageKey === 's3')).toEqual([])
  })
})

describe('第一位老師開始填就鎖定方案（產品 7.5「開始填」，GRD-09）', () => {
  it('第一份暫存就把目前版本鎖定；之後直接發布新版本 SCHEME_LOCKED，暫存照原版本的結構保留', async () => {
    const cohortId = await newCohort()
    const { versionId } = await publishedScheme(cohortId)
    const groupId = await newGroup(cohortId, 'G01')
    const t1 = await newUser('甲老師', 'teacher')
    const a1 = await assignOk(groupId, t1)

    // 還沒有人開始填：可以直接換版本前的狀態是 published。
    expect((await owner.sql('select status from grading_scheme_versions where id = $1', [versionId])).rows[0]!.status).toBe('published')
    const saved = await command.saveDraft(teacherActor({ id: t1 }), { assignmentId: a1, scores: { i1: '70' } }, randomUUID())
    expect(saved.ok).toBe(true)
    const row = await owner.sql('select status, locked_at from grading_scheme_versions where id = $1', [versionId])
    expect(row.rows[0]!.status).toBe('locked')
    expect(row.rows[0]!.locked_at).not.toBeNull()

    const v2 = await command.createSchemeVersion(
      adminActor(),
      { cohortId, stages: [{ ...STAGES[0]!, key: 's1', items: [{ key: 'i1', name: '功能完整', type: 'number', max: 50, weight: 100 }] }, { ...STAGES[1]!, key: 's2' }] },
      randomUUID(),
    )
    expect(v2.ok).toBe(true)
    const blocked = await command.publishScheme(adminActor(), { versionId: v2.ok ? v2.receipt.versionId : '' }, randomUUID())
    expect(blocked).toMatchObject({ ok: false, code: 'SCHEME_LOCKED' })
    if (!blocked.ok) expect(blocked.message).toContain('開始評分')
    const bench = await query.teacherBench(teacherActor({ id: t1 }), groupId)
    expect(bench.ok && bench.receipt.entries[0]).toMatchObject({ state: 'draft', scores: { i1: '70' }, draftFromOlderVersion: false })
    expect(bench.ok && bench.receipt.entries[0]!.stage.items[0]).toMatchObject({ key: 'i1', max: 100 })
  })
})

describe('要求份數與指派（GRD-02）', () => {
  it('設份數（版本號樂觀鎖）→ 指派 T1 → 老師收到評分指派通知；重複指派被拒；T1 的佇列只有自己的指派', async () => {
    const cohortId = await newCohort()
    await publishedScheme(cohortId)
    const student = await newUser('學生', 'student')
    const g1 = await newGroup(cohortId, 'G01', [student])
    const g2 = await newGroup(cohortId, 'G02')
    const t1 = await newUser('甲老師', 'teacher')
    const t3 = await newUser('丙老師', 'teacher')

    expect(await command.setRequirement(adminActor(), { groupId: g1, stageKey: 's1', requiredCount: 2, revision: 0 }, randomUUID())).toMatchObject({
      ok: true,
      receipt: { requiredCount: 2, stageName: '系統驗收' },
    })
    // 別人先改過（版本 0 已經不是最新）：CONFLICT。
    expect(await command.setRequirement(adminActor(), { groupId: g1, stageKey: 's1', requiredCount: 3, revision: 0 }, randomUUID())).toMatchObject({
      ok: false,
      code: 'CONFLICT',
    })
    expect(await command.setRequirement(adminActor(), { groupId: g1, stageKey: 's1', requiredCount: 11, revision: 1 }, randomUUID())).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
    })
    expect(await command.setRequirement(adminActor(), { groupId: g1, stageKey: 'nope', requiredCount: 1, revision: 0 }, randomUUID())).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
    })

    const a1 = await assignOk(g1, t1)
    await assignOk(g2, t3)
    const dup = await command.assign(adminActor(), { groupId: g1, stageKey: 's1', teacherUserId: t1 }, randomUUID())
    expect(dup).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    if (!dup.ok) expect(dup.message).toContain('不能重複指派')

    const events = await owner.sql(`select recipients, payload from domain_events where type = 'grading.assigned' and source_id = $1`, [a1])
    expect(events.rows).toHaveLength(1)
    expect(events.rows[0]!.recipients).toEqual([t1])
    expect(JSON.stringify(events.rows[0]!.payload)).not.toMatch(/score/i)

    const queue = await query.teacherQueue(teacherActor({ id: t1 }))
    expect(queue.map((q) => q.groupCode)).toEqual(['G01'])
    expect(queue[0]).toMatchObject({ stageName: '系統驗收', state: 'empty', total: 2 })
    // 學生、系辦（沒有老師角色）的佇列一律空的。
    expect(await query.teacherQueue(actor(student, ['student']))).toEqual([])
    expect(await query.teacherQueue(adminActor())).toEqual([])
  })

  it('停用或不是老師的帳號不能被指派；方案還沒發布不能指派', async () => {
    const cohortId = await newCohort()
    const groupId = await newGroup(cohortId, 'G01')
    const teacher = await newUser('老師', 'teacher')
    expect(await command.assign(adminActor(), { groupId, stageKey: 's1', teacherUserId: teacher }, randomUUID())).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
    })
    await publishedScheme(cohortId)
    const student = await newUser('學生', 'student')
    expect(await command.assign(adminActor(), { groupId, stageKey: 's1', teacherUserId: student }, randomUUID())).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
    })
    await owner.sql(`update users set status = 'disabled' where id = $1`, [teacher])
    expect(await command.assign(adminActor(), { groupId, stageKey: 's1', teacherUserId: teacher }, randomUUID())).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
    })
  })

  it('兩位管理員同時指派同一位老師：只有一筆有效指派（部分唯一）', async () => {
    const cohortId = await newCohort()
    await publishedScheme(cohortId)
    const groupId = await newGroup(cohortId, 'G01')
    const teacher = await newUser('老師', 'teacher')
    const results = await Promise.all(
      [1, 2].map(() => command.assign(adminActor(), { groupId, stageKey: 's1', teacherUserId: teacher }, randomUUID())),
    )
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    const active = await owner.sql(`select count(*)::int as n from evaluator_assignments where group_id = $1 and valid_to is null`, [groupId])
    expect(active.rows[0]!.n).toBe(1)
  })

  it('重派對話框的清單：只列那位老師在本組的有效指派與狀態', async () => {
    const cohortId = await newCohort()
    await publishedScheme(cohortId)
    const groupId = await newGroup(cohortId, 'G01')
    const t1 = await newUser('甲老師', 'teacher')
    const t2 = await newUser('乙老師', 'teacher')
    const a1 = await assignOk(groupId, t1, 's1')
    await assignOk(groupId, t1, 's2')
    await assignOk(groupId, t2, 's1')
    await command.saveDraft(teacherActor({ id: t1 }), { assignmentId: a1, scores: { i1: '80' } }, randomUUID())
    const list = await query.listForGroup(groupId, t1)
    expect(list.map((l) => [l.stageName, l.state])).toEqual([
      ['系統驗收', 'draft'],
      ['專題發表', 'empty'],
    ])
  })
})

describe('暫存（GRD-03、GRD-12）', () => {
  it('受指派老師暫存（可以沒填完）；重新讀回內容相同；T3 看不到、也寫不進 T1 的指派；學生 FORBIDDEN', async () => {
    const cohortId = await newCohort()
    await publishedScheme(cohortId)
    const student = await newUser('學生', 'student')
    const groupId = await newGroup(cohortId, 'G01', [student])
    const t1 = await newUser('甲老師', 'teacher')
    const t3 = await newUser('丙老師', 'teacher')
    const a1 = await assignOk(groupId, t1)

    const bad = await command.saveDraft(teacherActor({ id: t1 }), { assignmentId: a1, scores: { i1: '101' } }, randomUUID())
    expect(bad).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', details: { field: 'i1' } })

    const saved = await command.saveDraft(teacherActor({ id: t1 }), { assignmentId: a1, scores: { i1: '80.5' } }, randomUUID())
    expect(saved).toMatchObject({ ok: true, receipt: { filled: 1, total: 2 } })
    const bench = await query.teacherBench(teacherActor({ id: t1 }), groupId)
    expect(bench.ok && bench.receipt.entries[0]).toMatchObject({ state: 'draft', scores: { i1: '80.5' }, finalScore: null })

    // T3 沒有被指派：看不到評閱桌，也不能用 T1 的指派 id 暫存。
    expect(await query.teacherBench(teacherActor({ id: t3 }), groupId)).toMatchObject({ ok: false, code: 'NOT_ASSIGNED' })
    expect(await command.saveDraft(teacherActor({ id: t3 }), { assignmentId: a1, scores: { i1: '1' } }, randomUUID())).toMatchObject({
      ok: false,
      code: 'NOT_ASSIGNED',
    })
    // 學生：暫存、正式送出、評閱桌全部 FORBIDDEN，不透露任何東西。
    for (const call of [
      command.saveDraft(actor(student, ['student']), { assignmentId: a1, scores: {} }, randomUUID()),
      command.submitFinal(actor(student, ['student']), { assignmentId: a1, scores: {} }, randomUUID()),
      query.teacherBench(actor(student, ['student']), groupId),
    ]) {
      const r = await call
      expect(r).toMatchObject({ ok: false, code: 'FORBIDDEN' })
      expect(JSON.stringify(r)).not.toContain('80.5')
    }

    // 管理員看得到暫存（標未正式），而且暫存不是採計。
    const board = await query.adminBoard(adminActor(), cohortId)
    expect(board.ok && board.receipt.assignments.find((a) => a.id === a1)).toMatchObject({ state: 'draft', score: '40.25', filled: 1 })
    expect(await countedCount(a1)).toBe(0)
  })

  it('指派已結束（valid_to 非空）：暫存、送出都 NOT_ASSIGNED；評閱桌也看不到', async () => {
    const cohortId = await newCohort()
    await publishedScheme(cohortId)
    const groupId = await newGroup(cohortId, 'G01')
    const t1 = await newUser('甲老師', 'teacher')
    const a1 = await assignOk(groupId, t1)
    await owner.sql(
      `update evaluator_assignments set valid_to = valid_from, ended_real_at = now(), ended_by_user_id = $2, reason = '移除', removal_choice = 'replace' where id = $1`,
      [a1, adminId],
    )
    expect(await command.saveDraft(teacherActor({ id: t1 }), { assignmentId: a1, scores: {} }, randomUUID())).toMatchObject({ code: 'NOT_ASSIGNED' })
    expect(
      await command.submitFinal(teacherActor({ id: t1 }), { assignmentId: a1, scores: { i1: '1', i2: '1' } }, randomUUID()),
    ).toMatchObject({ code: 'NOT_ASSIGNED' })
    expect(await query.teacherBench(teacherActor({ id: t1 }), groupId)).toMatchObject({ code: 'NOT_ASSIGNED' })
  })
})

describe('正式送出與鎖定（GRD-04）', () => {
  it('沒填齊不能送；送出後有收件回執、採計一筆、方案鎖定；再送 ok（重送：舊的成歷史、reason resubmitted）；再暫存 ok、latestEvaluations 回 {counted, draft}', async () => {
    const cohortId = await newCohort()
    const { versionId } = await publishedScheme(cohortId)
    const groupId = await newGroup(cohortId, 'G01')
    const t1 = await newUser('甲老師', 'teacher')
    const a1 = await assignOk(groupId, t1)

    expect(await command.submitFinal(teacherActor({ id: t1 }), { assignmentId: a1, scores: { i1: '80' } }, randomUUID())).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
    })

    const requestId = randomUUID()
    const scores = { i1: '80', i2: '88.58' }
    const sent = await command.submitFinal(teacherActor({ id: t1 }), { assignmentId: a1, scores }, requestId)
    expect(sent).toMatchObject({ ok: true, receipt: { teacherScore: '84.29', groupCode: 'G01', stageName: '系統驗收', versionNo: 1 } })
    expect(await countedCount(a1)).toBe(1)
    const version = await owner.sql('select status, locked_at from grading_scheme_versions where id = $1', [versionId])
    expect(version.rows[0]!.status).toBe('locked')
    expect(version.rows[0]!.locked_at).not.toBeNull()

    // 同一個請求編號重送（連點、斷線重試）：回原回執，不多一筆。
    const replay = await command.submitFinal(teacherActor({ id: t1 }), { assignmentId: a1, scores }, requestId)
    expect(replay.ok && replay.receipt.evaluationId).toBe(sent.ok && sent.receipt.evaluationId)
    expect(await countedCount(a1)).toBe(1)

    const bench = await query.teacherBench(teacherActor({ id: t1 }), groupId)
    expect(bench.ok && bench.receipt.entries[0]).toMatchObject({ state: 'counted', finalScore: '84.29', scores })
    const board = await query.adminBoard(adminActor(), cohortId)
    expect(board.ok && board.receipt.current).toMatchObject({ status: 'locked' })

    // B 階段 TE-B1：正式送出後可以重送——舊的採計改成歷史（事件 reason='resubmitted'），新的一筆採計，採計恰一筆。
    const again = await command.submitFinal(teacherActor({ id: t1 }), { assignmentId: a1, scores: { i1: '90', i2: '90' } }, randomUUID())
    expect(again).toMatchObject({ ok: true, receipt: { teacherScore: '90.00' } })
    expect(await countedCount(a1)).toBe(1)
    expect(await stateCount(a1, 'historical')).toBe(1)
    const last = await owner.sql(
      `select ev.reason from evaluation_status_events ev where ev.evaluation_id = $1 order by ev.real_at desc, ev.id desc limit 1`,
      [sent.ok ? sent.receipt.evaluationId : ''],
    )
    expect(last.rows).toEqual([{ reason: 'resubmitted' }])

    // 再暫存也可以：採計不變，latestEvaluations 回 {counted, draft} 兩筆。
    const draft = await command.saveDraft(teacherActor({ id: t1 }), { assignmentId: a1, scores: { i1: '1' } }, randomUUID())
    expect(draft).toMatchObject({ ok: true })
    expect(await countedCount(a1)).toBe(1)
    const current = (await latestEvaluations(app, [a1])).get(a1)
    expect(current?.counted?.scores).toEqual({ i1: '90', i2: '90' })
    expect(current?.draft?.scores).toEqual({ i1: '1' })
  })

  it('方案鎖定後：建新版本可以（草稿），直接發布換掉現版 SCHEME_LOCKED', async () => {
    const cohortId = await newCohort()
    await publishedScheme(cohortId)
    const groupId = await newGroup(cohortId, 'G01')
    const t1 = await newUser('甲老師', 'teacher')
    const a1 = await assignOk(groupId, t1)
    await command.submitFinal(teacherActor({ id: t1 }), { assignmentId: a1, scores: { i1: '80', i2: '80' } }, randomUUID())

    const v2 = await command.createSchemeVersion(adminActor(), { cohortId, stages: STAGES }, randomUUID())
    expect(v2).toMatchObject({ ok: true, receipt: { versionNo: 2, status: 'draft' } })
    expect(await command.publishScheme(adminActor(), { versionId: v2.ok ? v2.receipt.versionId : '' }, randomUUID())).toMatchObject({
      ok: false,
      code: 'SCHEME_LOCKED',
    })
  })

  it('同一指派兩個不同請求編號同時正式送出：兩個都 ok（在指派列排隊、後到的成重送），採計恰一筆、歷史一筆', async () => {
    const cohortId = await newCohort()
    await publishedScheme(cohortId)
    const groupId = await newGroup(cohortId, 'G01')
    const t1 = await newUser('甲老師', 'teacher')
    const a1 = await assignOk(groupId, t1)
    const results = await Promise.all(
      ['70', '90'].map((v) => command.submitFinal(teacherActor({ id: t1 }), { assignmentId: a1, scores: { i1: v, i2: v } }, randomUUID())),
    )
    expect(results.filter((r) => r.ok)).toHaveLength(2)
    expect(await countedCount(a1)).toBe(1)
    expect(await stateCount(a1, 'historical')).toBe(1)
  })

  it('兩位老師各自送出同一組：各一筆採計；狀態紀錄每筆都有「建立」事件', async () => {
    const cohortId = await newCohort()
    await publishedScheme(cohortId)
    const groupId = await newGroup(cohortId, 'G01')
    const t1 = await newUser('甲老師', 'teacher')
    const t2 = await newUser('乙老師', 'teacher')
    const a1 = await assignOk(groupId, t1)
    const a2 = await assignOk(groupId, t2)
    await Promise.all([
      command.submitFinal(teacherActor({ id: t1 }), { assignmentId: a1, scores: { i1: '80', i2: '80' } }, randomUUID()),
      command.submitFinal(teacherActor({ id: t2 }), { assignmentId: a2, scores: { i1: '84.29', i2: '84.29' } }, randomUUID()),
    ])
    expect([await countedCount(a1), await countedCount(a2)]).toEqual([1, 1])
    const events = await owner.sql(
      `select count(*)::int as n from evaluation_status_events ev join evaluations e on e.id = ev.evaluation_id
        where e.assignment_id = any($1::uuid[]) and ev.from_state is null and ev.to_state = 'counted'`,
      [[a1, a2]],
    )
    expect(events.rows[0]!.n).toBe(2)
  })
})

// ── TE-11：評分隊列三欄、評分單組頁一次讀齊（AC-TE-47、AC-TE-48） ─────────────────────────

/** 包一層計數的連線：量「幾句 SQL」（不是幾次 port 呼叫）。 */
function countingPool(pool: Pool): { db: Pick<Pool, 'query'>; count: () => number; reset: () => void } {
  let n = 0
  const query = (...args: unknown[]) => {
    n += 1
    return (pool.query as (...a: unknown[]) => unknown)(...args)
  }
  return { db: { query } as unknown as Pick<Pool, 'query'>, count: () => n, reset: () => (n = 0) }
}

/** 換組長＝結束舊列＋插新列（跟分組用例同一個形狀）。 */
async function setLeader(groupId: string, userId: string) {
  await owner.sql(`update group_leaders set valid_to = now() where group_id = $1 and valid_to is null`, [groupId])
  await owner.sql(
    `insert into group_leaders (id, group_id, user_id, valid_from, changed_by_user_id) values (gen_random_uuid(), $1, $2, now(), $3)`,
    [groupId, userId, adminId],
  )
}

/** T1 三組指派：G01 已正式送出 84.29、G02 草稿、G03 未填；三組各有現任組長，G02 換過一次組長。T2 只評 G02。 */
async function queueScenario() {
  const cohortId = await newCohort()
  await publishedScheme(cohortId)
  const [l1, l2old, l2, l3] = [await newUser('組長甲', 'student'), await newUser('舊組長', 'student'), await newUser('新組長乙', 'student'), await newUser('組長丙', 'student')]
  const g1 = await newGroup(cohortId, 'G01', [l1])
  const g2 = await newGroup(cohortId, 'G02', [l2old, l2])
  const g3 = await newGroup(cohortId, 'G03', [l3])
  await setLeader(g1, l1)
  await setLeader(g2, l2old)
  await setLeader(g2, l2)
  await setLeader(g3, l3)
  const t1 = await newUser('甲老師', 'teacher')
  const t2 = await newUser('乙老師', 'teacher')
  const [a1, a2] = [await assignOk(g1, t1), await assignOk(g2, t1)]
  await assignOk(g3, t1)
  await assignOk(g2, t2)
  const sent = await command.submitFinal(teacherActor({ id: t1 }), { assignmentId: a1, scores: { i1: '80', i2: '88.58' } }, randomUUID())
  if (!sent.ok) throw new Error(sent.message)
  const saved = await command.saveDraft(teacherActor({ id: t1 }), { assignmentId: a2, scores: { i1: '70' } }, randomUUID())
  if (!saved.ok) throw new Error(saved.message)
  return { cohortId, g1, g2, g3, t1, t2, a1, l1 }
}

/** 拿掉每次都不同的 requestId、serverTime，剩下的才能逐欄比。 */
function strip<R extends { requestId: string; serverTime: string }>(receipt: R): Omit<R, 'requestId' | 'serverTime'> {
  const rest: Partial<R> = { ...receipt }
  delete rest.requestId
  delete rest.serverTime
  return rest as Omit<R, 'requestId' | 'serverTime'>
}

describe('TE-11 teacherQueue：組長、總分、送出時間（AC-TE-47）', () => {
  it('teacherQueue 每筆有現任組長；已送出那組有總分與送出時間，草稿、未填兩欄是 null；仍是 3 句 SQL', async () => {
    const { t1, a1 } = await queueScenario()
    const counter = countingPool(app)
    const counted = new PgGradingQuery(() => counter.db)
    const queue = await counted.teacherQueue(teacherActor({ id: t1 }))
    expect(counter.count()).toBe(3)

    const submittedAt = (
      await owner.sql(
        `select e.submitted_real_at from evaluations e join evaluation_status s on s.evaluation_id = e.id
          where e.assignment_id = $1 and s.state = 'counted'`,
        [a1],
      )
    ).rows[0]!.submitted_real_at as Date
    expect(queue.map((e) => [e.groupCode, e.state, e.leaderName, e.finalScore, e.submittedAt])).toEqual([
      ['G01', 'counted', '組長甲', '84.29', submittedAt],
      ['G02', 'draft', '新組長乙', null, null],
      ['G03', 'empty', '組長丙', null, null],
    ])
    // 既有欄位照舊。
    expect(queue[1]).toMatchObject({ filled: 1, total: 2, returned: false, stageKey: 's1', stageName: '系統驗收' })
  })
})

describe('TE-11 teacherBenchPage：評分單組頁一次讀齊（AC-TE-48）', () => {
  function fakeSubmissions(result: readonly GroupVersionWithFiles[] | null) {
    const calls: [ResolvedActor, string][] = []
    return {
      calls,
      result,
      async groupVersionsWithFiles(who: ResolvedActor, groupId: string) {
        calls.push([who, groupId])
        return this.result
      },
    }
  }
  const SUBMISSIONS: GroupVersionWithFiles[] = [
    {
      itemId: randomUUID(),
      title: '期中報告',
      versionNo: 2,
      receivedBusinessAt: new Date('2026-11-01T02:00:00Z'),
      submittedByName: '組長甲',
      attachments: [
        { fileId: randomUUID(), name: 'report.pdf', mime: 'application/pdf', sizeBytes: 1234 },
        { fileId: randomUUID(), name: 'source.zip', mime: 'application/zip', sizeBytes: 22 },
      ],
    },
  ]

  it('teacherBenchPage 的 bench 與 teacherBench 逐欄相等、queue 與 teacherQueue 相等、submissions 是繳交查詢的結果；組長正確', async () => {
    const { g1, t1 } = await queueScenario()
    const port = fakeSubmissions(SUBMISSIONS)
    const pageQuery = new PgGradingQuery(() => app, port)
    const page = await pageQuery.teacherBenchPage(teacherActor({ id: t1 }), g1)
    const bench = await query.teacherBench(teacherActor({ id: t1 }), g1)
    if (!page.ok || !bench.ok) throw new Error('應該讀得到')
    const { leaderName, queue, submissions, ...benchPart } = strip(page.receipt)
    expect(benchPart).toEqual(strip(bench.receipt))
    expect(queue).toEqual(await query.teacherQueue(teacherActor({ id: t1 })))
    expect(submissions).toEqual(SUBMISSIONS)
    expect(port.calls).toEqual([[teacherActor({ id: t1 }), g1]])
    expect(leaderName).toBe('組長甲')
    expect(benchPart.entries[0]).toMatchObject({ state: 'counted', finalScore: '84.29' })

    // 繳交查詢回 null（不是老師等）時當空陣列。
    port.result = null
    const empty = await pageQuery.teacherBenchPage(teacherActor({ id: t1 }), g1)
    expect(empty.ok && empty.receipt.submissions).toEqual([])
  })

  it('teacherBenchPage 守衛不變：T2 沒有 G01 指派 NOT_ASSIGNED、學生 FORBIDDEN、不是 UUID NOT_ASSIGNED；都不帶任何分數', async () => {
    const { g1, t2, l1 } = await queueScenario()
    const pageQuery = new PgGradingQuery(() => app, fakeSubmissions(SUBMISSIONS))
    expect(await pageQuery.teacherBenchPage(teacherActor({ id: t2 }), g1)).toMatchObject({ ok: false, code: 'NOT_ASSIGNED' })
    expect(await pageQuery.teacherBenchPage(teacherActor({ id: t2 }), 'G01')).toMatchObject({ ok: false, code: 'NOT_ASSIGNED' })
    const student = await pageQuery.teacherBenchPage(actor(l1, ['student']), g1)
    expect(student).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(JSON.stringify(student)).not.toContain('84.29')
  })

  it('teacherBenchPage 句數固定：評閱桌 4 句＋隊列 3 句（繳交另計）；指派從 3 加到 9 句數不變', async () => {
    const { cohortId, g1, t1 } = await queueScenario()
    const counter = countingPool(app)
    const pageQuery = new PgGradingQuery(() => counter.db, fakeSubmissions(SUBMISSIONS))

    await pageQuery.teacherBench(teacherActor({ id: t1 }), g1)
    expect(counter.count()).toBe(4)
    counter.reset()
    await pageQuery.teacherBenchPage(teacherActor({ id: t1 }), g1)
    expect(counter.count()).toBe(7)

    // 再加 6 個指派（5 組＋G01 第二階段）→ 9 個。
    for (const code of ['G04', 'G05', 'G06', 'G07', 'G08']) await assignOk(await newGroup(cohortId, code), t1)
    await assignOk(g1, t1, 's2')
    counter.reset()
    const page = await pageQuery.teacherBenchPage(teacherActor({ id: t1 }), g1)
    expect(counter.count()).toBe(7)
    expect(page.ok && page.receipt.queue).toHaveLength(9)
    expect(page.ok && page.receipt.entries.map((e) => e.stage.key)).toEqual(['s1', 's2'])
  })
})

// ── B 階段 TE-B1／TE-B4：正式送出後暫存、重送、評語（AC-TE-33～36、AC-TE-51、AC-A-1～3） ─────────────

describe('TE-B1 正式送出後暫存與重送（AC-TE-33、AC-TE-51、AC-A-1、AC-A-2）', () => {
  it('送出 84.29 → 暫存 90：評閱桌顯示草稿、正式分數仍 84.29、draftAfterFinal；系辦採計不變 → 重送：第 2 次、歷史一筆、不發通知', async () => {
    const cohortId = await newCohort()
    await publishedScheme(cohortId)
    const groupId = await newGroup(cohortId, 'G01')
    const t1 = await newUser('甲老師', 'teacher')
    const t2 = await newUser('乙老師', 'teacher')
    const a1 = await assignOk(groupId, t1)
    await assignOk(groupId, t2)
    const first = await command.submitFinal(teacherActor({ id: t1 }), { assignmentId: a1, scores: { i1: '80', i2: '88.58' } }, randomUUID())
    if (!first.ok) throw new Error(first.message)
    const eventsBefore = await domainEventCount(cohortId)

    // AC-TE-51／AC-A-2：正式送出後只暫存。
    const draft = await command.saveDraft(
      teacherActor({ id: t1 }),
      { assignmentId: a1, scores: { i1: '90', i2: '88.58' }, comment: '第一項補強後再看' },
      randomUUID(),
    )
    expect(draft).toMatchObject({ ok: true })
    const bench = await query.teacherBench(teacherActor({ id: t1 }), groupId)
    expect(bench.ok && bench.receipt.entries[0]).toMatchObject({
      state: 'counted',
      scores: { i1: '90', i2: '88.58' },
      finalScore: '84.29',
      comment: '第一項補強後再看',
      draftAfterFinal: true,
      resubmittable: true,
      settled: null,
    })
    expect(bench.ok && bench.receipt.entries[0]!.submissionHistory).toHaveLength(1)
    const queue = await query.teacherQueue(teacherActor({ id: t1 }))
    expect(queue[0]).toMatchObject({ state: 'counted', finalScore: '84.29', draftAfterFinal: true, settled: false })
    const board = await query.adminBoard(adminActor(), cohortId)
    expect(board.ok && board.receipt.assignments.find((a) => a.id === a1)).toMatchObject({ state: 'counted', score: '84.29', comment: null })

    // T2 不能動 T1 的指派（AC-TE-35）。
    expect(
      await command.submitFinal(teacherActor({ id: t2 }), { assignmentId: a1, scores: { i1: '1', i2: '1' } }, randomUUID()),
    ).toMatchObject({ ok: false, code: 'NOT_ASSIGNED' })

    // AC-TE-33／AC-A-1：重新送出。
    const resent = await command.submitFinal(
      teacherActor({ id: t1 }),
      { assignmentId: a1, scores: { i1: '90', i2: '88.58' }, comment: '第一項補強後再看' },
      randomUUID(),
    )
    expect(resent).toMatchObject({ ok: true, receipt: { teacherScore: '89.29' } })
    expect(await countedCount(a1)).toBe(1)
    expect(await stateCount(a1, 'historical')).toBe(1)
    const after = await query.teacherBench(teacherActor({ id: t1 }), groupId)
    if (!after.ok) throw new Error(after.message)
    const entry = after.receipt.entries[0]!
    expect(entry).toMatchObject({ state: 'counted', finalScore: '89.29', draftAfterFinal: false, comment: '第一項補強後再看' })
    expect(entry.submissionHistory.map((h) => h.no)).toEqual([1, 2])
    expect(entry.submissionHistory[1]!.at).toEqual(entry.submittedAt)
    const boardAfter = await query.adminBoard(adminActor(), cohortId)
    expect(boardAfter.ok && boardAfter.receipt.assignments.find((a) => a.id === a1)).toMatchObject({
      score: '89.29',
      comment: '第一項補強後再看',
    })
    // 重送不通知系辦（D6）：沒有新的領域事件；稽核記「重新送出」。
    expect(await domainEventCount(cohortId)).toBe(eventsBefore)
    const audit = await owner.sql(
      `select payload from audit_events where action = 'grading.submit_final' and target_id = $1`,
      [resent.ok ? resent.receipt.evaluationId : ''],
    )
    expect(audit.rows[0]!.payload).toMatchObject({ resubmitted: true, previousEvaluationId: first.receipt.evaluationId })
  })

  it('被退回後的流程不變：退回那筆不是採計，再送出是第 2 次送出、不產生歷史', async () => {
    const cohortId = await newCohort()
    await publishedScheme(cohortId)
    const groupId = await newGroup(cohortId, 'G01')
    const t1 = await newUser('甲老師', 'teacher')
    const a1 = await assignOk(groupId, t1)
    const first = await command.submitFinal(teacherActor({ id: t1 }), { assignmentId: a1, scores: { i1: '80', i2: '80' } }, randomUUID())
    if (!first.ok) throw new Error(first.message)
    await owner.sql(`update evaluation_status set state = 'returned' where evaluation_id = $1`, [first.receipt.evaluationId])
    await owner.sql(
      `insert into evaluation_status_events (id, evaluation_id, from_state, to_state, reason, actor_kind, actor_user_id, real_at)
       values (gen_random_uuid(), $1, 'counted', 'returned', '請補評語', 'user', $2, now())`,
      [first.receipt.evaluationId, adminId],
    )
    const bench = await query.teacherBench(teacherActor({ id: t1 }), groupId)
    expect(bench.ok && bench.receipt.entries[0]).toMatchObject({ state: 'empty', resubmittable: false, returned: { reason: '請補評語' } })
    const again = await command.submitFinal(teacherActor({ id: t1 }), { assignmentId: a1, scores: { i1: '85', i2: '85' } }, randomUUID())
    expect(again).toMatchObject({ ok: true })
    expect([await countedCount(a1), await stateCount(a1, 'historical'), await stateCount(a1, 'returned')]).toEqual([1, 0, 1])
    const after = await query.teacherBench(teacherActor({ id: t1 }), groupId)
    expect(after.ok && after.receipt.entries[0]!.submissionHistory.map((h) => h.no)).toEqual([1, 2])
  })
})

describe('TE-B4 評語（AC-A-3 API 半）', () => {
  it('評語跟分數同一次寫入；空白存成 null；501 字 VALIDATION_FAILED（什麼都沒寫）、500 字（含 emoji 算一個字）可以', async () => {
    const cohortId = await newCohort()
    await publishedScheme(cohortId)
    const groupId = await newGroup(cohortId, 'G01')
    const t1 = await newUser('甲老師', 'teacher')
    const a1 = await assignOk(groupId, t1)
    const me = teacherActor({ id: t1 })

    const tooLong = await command.saveDraft(me, { assignmentId: a1, scores: { i1: '80' }, comment: '字'.repeat(501) }, randomUUID())
    expect(tooLong).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', details: { field: 'comment' } })
    expect(
      await command.submitFinal(me, { assignmentId: a1, scores: { i1: '80', i2: '80' }, comment: '字'.repeat(501) }, randomUUID()),
    ).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    const rows = await owner.sql(`select count(*)::int as n from evaluations where assignment_id = $1`, [a1])
    expect(rows.rows[0]!.n).toBe(0)

    expect(await command.saveDraft(me, { assignmentId: a1, scores: { i1: '80' }, comment: '   ' }, randomUUID())).toMatchObject({ ok: true })
    const blank = await query.teacherBench(me, groupId)
    expect(blank.ok && blank.receipt.entries[0]).toMatchObject({ state: 'draft', comment: null })

    const emoji = '👍'.repeat(500)
    expect(await command.saveDraft(me, { assignmentId: a1, scores: { i1: '80' }, comment: emoji }, randomUUID())).toMatchObject({ ok: true })
    const saved = await query.teacherBench(me, groupId)
    expect(saved.ok && saved.receipt.entries[0]!.comment).toBe(emoji)
    const stored = await owner.sql(`select comment from evaluations where assignment_id = $1 order by submitted_real_at desc limit 1`, [a1])
    expect(stored.rows[0]!.comment).toBe(emoji)
  })

  it('同一請求編號：評語不同 → REQUEST_MISMATCH；沒評語的請求指紋跟加欄之前一樣（同內容重放回原回執）', async () => {
    const cohortId = await newCohort()
    await publishedScheme(cohortId)
    const groupId = await newGroup(cohortId, 'G01')
    const t1 = await newUser('甲老師', 'teacher')
    const a1 = await assignOk(groupId, t1)
    const me = teacherActor({ id: t1 })
    const requestId = randomUUID()
    const first = await command.saveDraft(me, { assignmentId: a1, scores: { i1: '80' } }, requestId)
    const replay = await command.saveDraft(me, { assignmentId: a1, scores: { i1: '80' }, comment: null }, requestId)
    expect(replay.ok && replay.receipt.evaluationId).toBe(first.ok && first.receipt.evaluationId)
    expect(await command.saveDraft(me, { assignmentId: a1, scores: { i1: '80' }, comment: '不同' }, requestId)).toMatchObject({
      ok: false,
      code: 'REQUEST_MISMATCH',
    })
  })
})

// ── AD-21 供應端：pendingReviews／progressSummary 各 1 句（設計方案 §10） ─────────────────────────────

describe('AD-21 系辦首頁供應端', () => {
  it('pendingReviews 跟成績表的 pendingReviews 相同、1 句；progressSummary 跟 teacherProgress 同口徑、1 句；非系辦 FORBIDDEN', async () => {
    const cohortId = await newCohort()
    await publishedScheme(cohortId)
    const g1 = await newGroup(cohortId, 'G01')
    const g2 = await newGroup(cohortId, 'G02')
    const gone = await newGroup(cohortId, 'G03')
    const t1 = await newUser('甲老師', 'teacher')
    const t2 = await newUser('乙老師', 'teacher')
    const a1 = await assignOk(g1, t1)
    await assignOk(g1, t2)
    await assignOk(g2, t1, 's2')
    await assignOk(gone, t2)
    await command.submitFinal(teacherActor({ id: t1 }), { assignmentId: a1, scores: { i1: '80', i2: '80' } }, randomUUID())
    await owner.sql(`update groups set status = 'dissolved', dissolved_real_at = now(), dissolve_reason = '測試' where id = $1`, [gone])

    // 兩筆更正：G01 待復核、G02 生效中；只有 G01 列出。
    const { versionId } = (await owner.sql(`select current_version_id as "versionId" from grading_schemes where cohort_id = $1`, [cohortId]))
      .rows[0] as { versionId: string }
    for (const [groupId, state, value] of [
      [g1, 'pending_review', '91.5'],
      [g2, 'effective', '70'],
    ] as const) {
      const o = await owner.sql(
        `insert into grade_overrides (id, group_id, scheme_version_id, original_value, new_value, basis_hash, reason, actor_user_id, real_at)
         values (gen_random_uuid(), $1, $2, 80, $3, 'x', '口試加分', $4, now()) returning id`,
        [groupId, versionId, value, adminId],
      )
      await owner.sql(`insert into override_review_state (override_id, state) values ($1, $2)`, [o.rows[0]!.id, state])
    }

    const counter = countingPool(app)
    const counted = new PgGradingQuery(() => counter.db)
    const reviews = await counted.pendingReviews(adminActor(), cohortId)
    expect(counter.count()).toBe(1)
    const book = await new PgGradebookQuery(() => app).gradebook(adminActor(), cohortId)
    if (!reviews.ok || !book.ok) throw new Error('應該讀得到')
    expect([...reviews.receipt]).toEqual(book.receipt.pendingReviews)
    expect(reviews.receipt.map((r) => r.groupCode)).toEqual(['G01'])

    counter.reset()
    const summary = await counted.progressSummary(adminActor(), cohortId)
    expect(counter.count()).toBe(1)
    const board = await query.adminBoard(adminActor(), cohortId)
    if (!summary.ok || !board.ok) throw new Error('應該讀得到')
    const progress = teacherProgress(board.receipt, { excludeDissolved: true })
    expect({ counted: summary.receipt.counted, required: summary.receipt.required }).toEqual({
      counted: progress.reduce((n, t) => n + t.counted, 0),
      required: progress.reduce((n, t) => n + t.assigned, 0),
    })
    expect({ counted: summary.receipt.counted, required: summary.receipt.required }).toEqual({ counted: 1, required: 3 })

    expect(await query.pendingReviews(teacherActor({ id: t1 }), cohortId)).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(await query.progressSummary(teacherActor({ id: t1 }), cohortId)).toMatchObject({ ok: false, code: 'FORBIDDEN' })
  })
})

async function domainEventCount(cohortId: string): Promise<number> {
  const r = await owner.sql(`select count(*)::int as n from domain_events where cohort_id = $1`, [cohortId])
  return Number(r.rows[0]!.n)
}

describe('0021（C1-01）：評分項目側表 grading_stage_settings 的 CHECK', () => {
  it('一屆一項目一列；三欄至少一欄有值；說明 1–500 字、評審組 1–40 字；作業與屆別要存在', async () => {
    const cohortId = await newCohort()
    const item = await owner.sql(
      `insert into managed_items (id, cohort_id, placement, audience_kind, receiver_unit, title, created_by_kind, created_by_user_id)
       values (gen_random_uuid(), $1, 'submission', 'cohort_students', 'group', '系統驗收文件', 'user', $2) returning id`,
      [cohortId, adminId],
    )
    const itemId = String(item.rows[0]!.id)
    const setting = (stageKey: string, fields: { itemId?: string | null; description?: string | null; panelKey?: string | null }) =>
      app.query(
        `insert into grading_stage_settings (cohort_id, stage_key, item_id, description, panel_key, updated_by_user_id)
         values ($1, $2, $3, $4, $5, $6)`,
        [cohortId, stageKey, fields.itemId ?? null, fields.description ?? null, fields.panelKey ?? null, adminId],
      )

    await expect(setting('s1', { itemId })).resolves.toBeTruthy()
    await expect(setting('s2', { description: '依發表當天表現評分', panelKey: 'final' })).resolves.toBeTruthy()
    await expect(setting('s3', { panelKey: 'final' })).resolves.toBeTruthy()
    await expect(setting('s1', { description: '重複' })).rejects.toThrow(/grading_stage_settings_pk/)
    await expect(setting('s4', {})).rejects.toThrow(/grading_stage_settings_not_empty_check/)
    await expect(setting('s4', { description: '' })).rejects.toThrow(/grading_stage_settings_description_check/)
    await expect(setting('s4', { description: '字'.repeat(501) })).rejects.toThrow(/grading_stage_settings_description_check/)
    await expect(setting('s4', { description: '字'.repeat(500) })).resolves.toBeTruthy()
    await expect(setting('s5', { panelKey: '' })).rejects.toThrow(/grading_stage_settings_panel_key_check/)
    await expect(setting('s5', { panelKey: 'p'.repeat(41) })).rejects.toThrow(/grading_stage_settings_panel_key_check/)
    await expect(setting('', { description: '沒有代號' })).rejects.toThrow(/grading_stage_settings_stage_key_check/)
    await expect(setting('s6', { itemId: randomUUID() })).rejects.toThrow(/grading_stage_settings_item_id_managed_items_id_fk/)

    // 改了不建版：直接改欄位；三欄都清空不合法（清空＝刪列）。
    await expect(
      app.query(`update grading_stage_settings set description = '補一句說明', updated_at = now() where cohort_id = $1 and stage_key = 's1'`, [
        cohortId,
      ]),
    ).resolves.toBeTruthy()
    await expect(
      app.query(`update grading_stage_settings set panel_key = null where cohort_id = $1 and stage_key = 's3'`, [cohortId]),
    ).rejects.toThrow(/grading_stage_settings_not_empty_check/)
    await expect(app.query(`delete from grading_stage_settings where cohort_id = $1 and stage_key = 's3'`, [cohortId])).resolves.toBeTruthy()
    const rows = await owner.sql(`select stage_key from grading_stage_settings where cohort_id = $1 order by stage_key`, [cohortId])
    expect(rows.rows.map((r) => r.stage_key)).toEqual(['s1', 's2', 's4'])
  })

  it('結算、解除結算的理由可以留空（AC-31 的資料庫面）；有填仍是 1–500 字、解除仍要解除時間與解除者', async () => {
    const cohortId = await newCohort()
    const settle = (reason: string | null) =>
      app.query(
        `insert into grade_settlements (id, cohort_id, stage_key, settled_at, settled_by_user_id, reason, counted_evaluations, request_id)
         values (gen_random_uuid(), $1, 's1', now(), $2, $3, 0, gen_random_uuid()::text) returning id`,
        [cohortId, adminId, reason],
      )
    await expect(settle('')).rejects.toThrow(/grade_settlements_reason_check/)
    const first = String((await settle(null)).rows[0]!.id)
    await expect(
      app.query(`update grade_settlements set released_at = now() where id = $1`, [first]),
    ).rejects.toThrow(/grade_settlements_released_check/)
    await expect(
      app.query(`update grade_settlements set released_at = now(), released_by_user_id = $2 where id = $1`, [first, adminId]),
    ).resolves.toBeTruthy()
    expect((await owner.sql(`select reason, release_reason from grade_settlements where id = $1`, [first])).rows).toEqual([
      { reason: null, release_reason: null },
    ])
  })
})
