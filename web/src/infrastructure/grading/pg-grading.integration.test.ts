import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { assertTestDatabaseReachable, createIsolatedDatabase, poolAsRole, type IsolatedDatabase } from '../../../test/db'
import { migratedSchema } from '../../../test/migrations'
import type { ResolvedActor } from '@/application/accounts'
import type { SchemeStageInput } from '@/application/grading'
import { PgGradingCommand, PgGradingQuery } from '@/infrastructure/grading/pg-grading'
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
  const r = await owner.sql(`select count(*)::int as n from evaluation_status where assignment_id = $1 and state = 'counted'`, [assignmentId])
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
  it('沒填齊不能送；送出後有收件回執、採計一筆、方案鎖定；再送 CONFLICT（需先退回）；再暫存也不行', async () => {
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

    const again = await command.submitFinal(teacherActor({ id: t1 }), { assignmentId: a1, scores: { i1: '90', i2: '90' } }, randomUUID())
    expect(again).toMatchObject({ ok: false, code: 'CONFLICT' })
    if (!again.ok) expect(again.message).toContain('退回')
    expect(await command.saveDraft(teacherActor({ id: t1 }), { assignmentId: a1, scores: { i1: '1' } }, randomUUID())).toMatchObject({
      ok: false,
      code: 'CONFLICT',
    })

    const bench = await query.teacherBench(teacherActor({ id: t1 }), groupId)
    expect(bench.ok && bench.receipt.entries[0]).toMatchObject({ state: 'counted', finalScore: '84.29', scores })
    const board = await query.adminBoard(adminActor(), cohortId)
    expect(board.ok && board.receipt.current).toMatchObject({ status: 'locked' })
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

  it('同一指派兩個不同請求編號同時正式送出：只有一筆採計，另一筆 CONFLICT', async () => {
    const cohortId = await newCohort()
    await publishedScheme(cohortId)
    const groupId = await newGroup(cohortId, 'G01')
    const t1 = await newUser('甲老師', 'teacher')
    const a1 = await assignOk(groupId, t1)
    const results = await Promise.all(
      ['70', '90'].map((v) => command.submitFinal(teacherActor({ id: t1 }), { assignmentId: a1, scores: { i1: v, i2: v } }, randomUUID())),
    )
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(results.find((r) => !r.ok)).toMatchObject({ code: 'CONFLICT' })
    expect(await countedCount(a1)).toBe(1)
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
