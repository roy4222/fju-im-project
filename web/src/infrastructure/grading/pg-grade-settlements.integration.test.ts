import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { assertTestDatabaseReachable, createIsolatedDatabase, poolAsRole, type IsolatedDatabase } from '../../../test/db'
import { enableFaultInjection, failAt, injectFault } from '../../../test/fault-injection'
import { migratedSchema } from '../../../test/migrations'
import type { ResolvedActor } from '@/application/accounts'
import type { SchemeStageInput } from '@/application/grading'
import { PgGradingSettlementCommand, PgGradingSettlementQuery } from '@/infrastructure/grading/pg-grade-settlements'
import { PgGradingCommand, PgGradingQuery } from '@/infrastructure/grading/pg-grading'
import { PgEventPublisher } from '@/infrastructure/notifications/pg-event-publisher'
import { PgAuditWriter } from '@/infrastructure/ops/audit-writer'
import { PgOperationLedger } from '@/infrastructure/ops/operation-ledger'

/**
 * B 階段 TE-B2a：系辦結算表與鎖（設計方案 §2；AC-TE-37、AC-TE-38〔API 半，覆寫後〕、AC-TE-52、AC-A-9、AC-A-10 API 半）。
 *
 * 全部以正式執行角色 `fju_app` 連線（B17 的欄級 GRANT 寫錯這裡直接紅）。
 * 「settlement interleaving」五個案例名稱照設計方案 §2.4 固定；`-t "settlement interleaving"` 只跑它們。
 */

let owner: IsolatedDatabase
let app: Pool
let adminId: string
let admin2Id: string
const businessClock = { now: async () => new Date('2026-12-01T02:00:00Z') }

let grading: PgGradingCommand
let gradingQuery: PgGradingQuery
let command: PgGradingSettlementCommand
let query: PgGradingSettlementQuery

function actor(userId: string, roles: ('admin' | 'teacher' | 'student')[]): ResolvedActor {
  return { kind: 'authenticated', userId, roles, status: 'active', mustChangePassword: false, cohortMemberships: [] }
}
const adminActor = () => actor(adminId, ['admin'])
const teacherActor = (id: string) => actor(id, ['teacher'])

let seq = 0
async function newUser(name: string, role: 'admin' | 'teacher' | 'student'): Promise<string> {
  seq += 1
  const row = await owner.sql(
    `insert into users (id, name, email, email_verified, updated_at, status)
     values (gen_random_uuid(), $1, $2, true, now(), 'active') returning id`,
    [name, `s${seq}-${randomUUID().slice(0, 8)}@example.com`],
  )
  const id = String(row.rows[0]!.id)
  await owner.sql(
    `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at) values (gen_random_uuid(), $1, $2, $1, now())`,
    [id, role],
  )
  await owner.sql(`insert into user_profiles (user_id, display_name, name_normalized, contact_email) values ($1, $2, $2, $3)`, [
    id,
    name,
    `c${seq}@example.com`,
  ])
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

/** 一屆、方案已發布、G01 指派 T1 與 T2 評「系統驗收」（s1）、T1 已正式送出 84.29。 */
async function scenario() {
  seq += 1
  const cohort = await owner.sql(
    `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
     values (gen_random_uuid(), $1, $1, 'active', '2027-06-30', 'system') returning id`,
    [`S17-${seq}`],
  )
  const cohortId = String(cohort.rows[0]!.id)
  const created = await grading.createSchemeVersion(adminActor(), { cohortId, stages: STAGES }, randomUUID())
  if (!created.ok) throw new Error(created.message)
  const published = await grading.publishScheme(adminActor(), { versionId: created.receipt.versionId }, randomUUID())
  if (!published.ok) throw new Error(published.message)
  const group = await owner.sql(
    `insert into groups (id, cohort_id, code, group_type, established_real_at, established_business_at, created_by_kind)
     values (gen_random_uuid(), $1, 'G01', 'general', now(), now(), 'system') returning id`,
    [cohortId],
  )
  const groupId = String(group.rows[0]!.id)
  const t1 = await newUser('甲老師', 'teacher')
  const t2 = await newUser('乙老師', 'teacher')
  const assign = async (teacherUserId: string) => {
    const r = await grading.assign(adminActor(), { groupId, stageKey: 's1', teacherUserId }, randomUUID())
    if (!r.ok) throw new Error(r.message)
    return r.receipt.assignmentId
  }
  const a1 = await assign(t1)
  const a2 = await assign(t2)
  const sent = await grading.submitFinal(teacherActor(t1), { assignmentId: a1, scores: { i1: '80', i2: '88.58' } }, randomUUID())
  if (!sent.ok) throw new Error(sent.message)
  return { cohortId, groupId, t1, t2, a1, a2 }
}

const settle = (cohortId: string, requestId = randomUUID(), reason = '期中結算', who = adminActor()) =>
  command.settleStage(who, { cohortId, stageKey: 's1', reason }, requestId)

async function stateCount(assignmentId: string, state: string): Promise<number> {
  const r = await owner.sql(`select count(*)::int as n from evaluation_status where assignment_id = $1 and state = $2`, [assignmentId, state])
  return Number(r.rows[0]!.n)
}

async function activeSettlements(cohortId: string): Promise<number> {
  const r = await owner.sql(`select count(*)::int as n from grade_settlements where cohort_id = $1 and released_at is null`, [cohortId])
  return Number(r.rows[0]!.n)
}

async function auditCount(action: string, cohortId: string): Promise<number> {
  const r = await owner.sql(`select count(*)::int as n from audit_events where action = $1 and cohort_id = $2`, [action, cohortId])
  return Number(r.rows[0]!.n)
}

async function ledgerCount(requestId: string): Promise<number> {
  const r = await owner.sql(`select count(*)::int as n from operation_records where request_id = $1`, [requestId])
  return Number(r.rows[0]!.n)
}

beforeAll(async () => {
  await assertTestDatabaseReachable()
  owner = await createIsolatedDatabase({ label: 'grade-settlements', setup: migratedSchema })
  app = await poolAsRole(owner, 'fju_app')
  adminId = await newUser('系辦甲', 'admin')
  admin2Id = await newUser('系辦乙', 'admin')
  const deps = {
    audit: new PgAuditWriter(),
    ledger: new PgOperationLedger(() => app),
    businessClock,
    pool: () => app,
  }
  grading = new PgGradingCommand({ ...deps, events: new PgEventPublisher() })
  gradingQuery = new PgGradingQuery(() => app)
  command = new PgGradingSettlementCommand(deps)
  query = new PgGradingSettlementQuery(() => app)
})

afterAll(async () => {
  await app?.end()
  await owner?.close()
})

describe('settlement interleaving（設計方案 §2.4；AC-TE-52）', () => {
  it('settle-then-submit：先結算，老師暫存、送出、重送都 CONFLICT「已結算」，採計不變；評閱桌與隊列標已結算、不可重送', async () => {
    const s = await scenario()
    const settled = await settle(s.cohortId)
    expect(settled).toMatchObject({ ok: true, receipt: { stageKey: 's1', stageName: '系統驗收', countedEvaluations: 1 } })

    const resubmit = await grading.submitFinal(teacherActor(s.t1), { assignmentId: s.a1, scores: { i1: '90', i2: '90' } }, randomUUID())
    expect(resubmit).toMatchObject({ ok: false, code: 'CONFLICT' })
    if (!resubmit.ok) expect(resubmit.message).toContain('系統驗收成績已結算，不能再改。')
    const draft = await grading.saveDraft(teacherActor(s.t1), { assignmentId: s.a1, scores: { i1: '90' } }, randomUUID())
    expect(draft).toMatchObject({ ok: false, code: 'CONFLICT' })
    // T2 還沒送也一樣被擋。
    expect(
      await grading.submitFinal(teacherActor(s.t2), { assignmentId: s.a2, scores: { i1: '70', i2: '70' } }, randomUUID()),
    ).toMatchObject({ ok: false, code: 'CONFLICT' })
    expect([await stateCount(s.a1, 'counted'), await stateCount(s.a1, 'historical')]).toEqual([1, 0])

    const bench = await gradingQuery.teacherBench(teacherActor(s.t1), s.groupId)
    expect(bench.ok && bench.receipt.entries[0]).toMatchObject({ state: 'counted', resubmittable: false })
    expect(bench.ok && bench.receipt.entries[0]!.settled?.settledAt).toEqual(settled.ok && settled.receipt.settledAt)
    expect((await gradingQuery.teacherQueue(teacherActor(s.t1)))[0]).toMatchObject({ settled: true })
  })

  it('submit-then-settle：老師送出拿著方案頭列時系辦按結算 → 結算等老師提交，採計份數含這一份；之後老師 CONFLICT', async () => {
    const s = await scenario()
    const disable = enableFaultInjection()
    try {
      let arrived!: () => void
      const reached = new Promise<void>((r) => (arrived = r))
      let resume!: () => void
      const gate = new Promise<void>((r) => (resume = r))
      injectFault('grading.final.before-insert', async () => {
        arrived()
        await gate
      })
      const submitting = grading.submitFinal(teacherActor(s.t2), { assignmentId: s.a2, scores: { i1: '70', i2: '70' } }, randomUUID())
      await reached
      let settleDone = false
      const settling = settle(s.cohortId).then((r) => ((settleDone = true), r))
      await new Promise((r) => setTimeout(r, 300))
      expect(settleDone).toBe(false) // 結算在頭列 FOR UPDATE 上等老師的交易
      resume()
      expect(await submitting).toMatchObject({ ok: true })
      expect(await settling).toMatchObject({ ok: true, receipt: { countedEvaluations: 2 } })
    } finally {
      disable()
    }
    expect(
      await grading.submitFinal(teacherActor(s.t2), { assignmentId: s.a2, scores: { i1: '75', i2: '75' } }, randomUUID()),
    ).toMatchObject({ ok: false, code: 'CONFLICT' })
  })

  it('resubmit-two-request-ids：兩個不同請求編號同時重送 → 兩筆 ok、最後一份採計、其餘歷史', async () => {
    const s = await scenario()
    const results = await Promise.all(
      ['70', '90'].map((v) => grading.submitFinal(teacherActor(s.t1), { assignmentId: s.a1, scores: { i1: v, i2: v } }, randomUUID())),
    )
    expect(results.every((r) => r.ok)).toBe(true)
    expect([await stateCount(s.a1, 'counted'), await stateCount(s.a1, 'historical')]).toEqual([1, 2])
    // 採計的是後提交的那一份（時間最晚的正式送出）。
    const last = await owner.sql(
      `select s.state from evaluations e join evaluation_status s on s.evaluation_id = e.id
        where e.assignment_id = $1 and e.kind = 'final' order by e.submitted_real_at desc, e.id desc limit 1`,
      [s.a1],
    )
    expect(last.rows[0]!.state).toBe('counted')
  })

  it('resubmit-same-request-id：同一請求編號重送兩次 → 回原回執、列數不變（AC-TE-34）', async () => {
    const s = await scenario()
    const requestId = randomUUID()
    const input = { assignmentId: s.a1, scores: { i1: '90', i2: '90' } }
    const first = await grading.submitFinal(teacherActor(s.t1), input, requestId)
    const evaluations = await owner.sql(`select count(*)::int as n from evaluations where assignment_id = $1`, [s.a1])
    const replay = await grading.submitFinal(teacherActor(s.t1), input, requestId)
    expect(replay.ok && replay.receipt.evaluationId).toBe(first.ok && first.receipt.evaluationId)
    expect((await owner.sql(`select count(*)::int as n from evaluations where assignment_id = $1`, [s.a1])).rows).toEqual(evaluations.rows)
    expect([await stateCount(s.a1, 'counted'), await stateCount(s.a1, 'historical')]).toEqual([1, 1])
  })

  it('release-stale-settlement：結算 S1 → 解除 S1 → 結算 S2 → 再用 S1 解除 → CONFLICT；S2 仍有效、老師仍被鎖', async () => {
    const s = await scenario()
    const s1 = await settle(s.cohortId)
    if (!s1.ok) throw new Error(s1.message)
    expect(await command.releaseSettlement(adminActor(), { settlementId: s1.receipt.settlementId, reason: '重開' }, randomUUID())).toMatchObject({
      ok: true,
    })
    const s2 = await settle(s.cohortId)
    if (!s2.ok) throw new Error(s2.message)
    const stale = await command.releaseSettlement(adminActor(), { settlementId: s1.receipt.settlementId, reason: '再重開' }, randomUUID())
    expect(stale).toMatchObject({ ok: false, code: 'CONFLICT' })
    if (!stale.ok) expect(stale.message).toMatch(/^這筆結算已於 \d{4}\/\d{2}\/\d{2} \d{2}:\d{2} 解除/)
    expect(await activeSettlements(s.cohortId)).toBe(1)
    const now = await query.settlementOf(adminActor(), s.cohortId, 's1')
    expect(now.ok && now.receipt.settlement?.settlementId).toBe(s2.receipt.settlementId)
    expect(
      await grading.saveDraft(teacherActor(s.t1), { assignmentId: s.a1, scores: { i1: '90' } }, randomUUID()),
    ).toMatchObject({ ok: false, code: 'CONFLICT' })
  })

  it('同一交易：重送在寫新評分前失敗 → 舊採計沒變成歷史、沒有稽核、沒有帳本；結算回 Err 也一樣三者都沒寫', async () => {
    const s = await scenario()
    const disable = enableFaultInjection()
    const requestId = randomUUID()
    try {
      failAt('grading.final.before-insert')
      // 交易外殼把例外收成 INTERNAL、整個回滾。
      expect(
        await grading.submitFinal(teacherActor(s.t1), { assignmentId: s.a1, scores: { i1: '90', i2: '90' } }, requestId),
      ).toMatchObject({ ok: false, code: 'INTERNAL' })
    } finally {
      disable()
    }
    expect([await stateCount(s.a1, 'counted'), await stateCount(s.a1, 'historical')]).toEqual([1, 0])
    expect(await ledgerCount(requestId)).toBe(0)
    const audits = await owner.sql(`select count(*)::int as n from audit_events where payload->>'resubmitted' = 'true' and cohort_id = $1`, [
      s.cohortId,
    ])
    expect(audits.rows[0]!.n).toBe(0)

    // 結算撞到現行結算（CONFLICT）：沒有新列、沒有稽核、沒有帳本。
    await settle(s.cohortId)
    const conflictId = randomUUID()
    expect(await settle(s.cohortId, conflictId, '再結一次')).toMatchObject({ ok: false, code: 'CONFLICT' })
    expect([await activeSettlements(s.cohortId), await auditCount('grading.settle', s.cohortId), await ledgerCount(conflictId)]).toEqual([
      1, 1, 0,
    ])
  })
})

describe('結算守衛順序：FORBIDDEN → VALIDATION_FAILED → COHORT_ARCHIVED → CONFLICT', () => {
  it('老師、學生 FORBIDDEN（理由空白也先回 FORBIDDEN）；理由空白、超過 500 字、階段不在目前版本 VALIDATION_FAILED', async () => {
    const s = await scenario()
    const student = await newUser('學生', 'student')
    for (const who of [teacherActor(s.t1), actor(student, ['student'])]) {
      expect(await settle(s.cohortId, randomUUID(), '', who)).toMatchObject({ ok: false, code: 'FORBIDDEN' })
      expect(await command.releaseSettlement(who, { settlementId: randomUUID(), reason: '' }, randomUUID())).toMatchObject({
        ok: false,
        code: 'FORBIDDEN',
      })
      expect(await query.settlements(who, s.cohortId)).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    }
    expect(await query.settlementOf(actor(student, ['student']), s.cohortId, 's1')).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(await settle(s.cohortId, randomUUID(), '   ')).toMatchObject({ ok: true, receipt: { reason: null } })
    expect(await settle(s.cohortId, randomUUID(), '字'.repeat(501))).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    expect(await settle(s.cohortId, randomUUID(), '字'.repeat(500))).toMatchObject({ ok: false, code: 'CONFLICT' })
    expect(
      await command.settleStage(adminActor(), { cohortId: s.cohortId, stageKey: 'nope', reason: '期中' }, randomUUID()),
    ).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    expect(await settle(randomUUID())).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
  })

  it('已封存屆別（AC-A-10 API 半）：VALIDATION 先於 COHORT_ARCHIVED；合法的結算、解除都 COHORT_ARCHIVED', async () => {
    const s = await scenario()
    const live = await settle(s.cohortId)
    if (!live.ok) throw new Error(live.message)
    await owner.sql(`update cohorts set status = 'archived' where id = $1`, [s.cohortId])
    expect(
      await command.settleStage(adminActor(), { cohortId: s.cohortId, stageKey: 'nope', reason: '期中' }, randomUUID()),
    ).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    expect(await settle(s.cohortId, randomUUID(), '')).toMatchObject({ ok: false, code: 'COHORT_ARCHIVED' })
    expect(
      await command.settleStage(adminActor(), { cohortId: s.cohortId, stageKey: 's2', reason: '期末' }, randomUUID()),
    ).toMatchObject({ ok: false, code: 'COHORT_ARCHIVED' })
    // 已有現行結算的階段：封存先於 CONFLICT。
    expect(await settle(s.cohortId)).toMatchObject({ ok: false, code: 'COHORT_ARCHIVED' })
    expect(
      await command.releaseSettlement(adminActor(), { settlementId: live.receipt.settlementId, reason: '重開' }, randomUUID()),
    ).toMatchObject({ ok: false, code: 'COHORT_ARCHIVED' })
  })

  it('兩位系辦同時結算同一階段（AC-A-9）：一個成功、另一個 CONFLICT「系統驗收已於 {時間} 結算」，現行列恰一筆', async () => {
    const s = await scenario()
    const results = await Promise.all([
      settle(s.cohortId, randomUUID(), '甲結算', adminActor()),
      settle(s.cohortId, randomUUID(), '乙結算', actor(admin2Id, ['admin'])),
    ])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    const loser = results.find((r) => !r.ok)
    expect(loser).toMatchObject({ code: 'CONFLICT' })
    if (loser && !loser.ok) expect(loser.message).toMatch(/^系統驗收已於 \d{4}\/\d{2}\/\d{2} \d{2}:\d{2} 結算/)
    expect(await activeSettlements(s.cohortId)).toBe(1)
  })
})

describe('結算回執、重放、解除與紀錄（AC-TE-37、AC-TE-38）', () => {
  it('回執含 countedEvaluations；同請求編號同內容回原回執（日期仍是 Date）、不多一列；內容不同 REQUEST_MISMATCH', async () => {
    const s = await scenario()
    const requestId = randomUUID()
    const first = await settle(s.cohortId, requestId)
    if (!first.ok) throw new Error(first.message)
    expect(first.receipt).toMatchObject({
      cohortId: s.cohortId,
      stageKey: 's1',
      stageName: '系統驗收',
      reason: '期中結算',
      countedEvaluations: 1,
      settledBy: { userId: adminId, name: '系辦甲' },
      requestId,
    })
    const replay = await settle(s.cohortId, requestId)
    if (!replay.ok) throw new Error(replay.message)
    expect(replay.receipt.settlementId).toBe(first.receipt.settlementId)
    expect(replay.receipt.settledAt).toBeInstanceOf(Date)
    expect(replay.receipt.settledAt).toEqual(first.receipt.settledAt)
    expect(await settle(s.cohortId, requestId, '別的理由')).toMatchObject({ ok: false, code: 'REQUEST_MISMATCH' })
    const rows = await owner.sql(`select count(*)::int as n from grade_settlements where cohort_id = $1`, [s.cohortId])
    expect(rows.rows[0]!.n).toBe(1)
    expect(await auditCount('grading.settle', s.cohortId)).toBe(1)
  })

  it('解除：回執 ReleaseReceipt；老師又能重送；稽核 settle／release 各一筆；settlements 列出 releasedAt；找不到 → VALIDATION_FAILED', async () => {
    const s = await scenario()
    const settled = await settle(s.cohortId)
    if (!settled.ok) throw new Error(settled.message)
    const requestId = randomUUID()
    const released = await command.releaseSettlement(
      actor(admin2Id, ['admin']),
      { settlementId: settled.receipt.settlementId, reason: '老師要補分' },
      requestId,
    )
    expect(released).toMatchObject({ ok: true, receipt: { settlementId: settled.receipt.settlementId, stageKey: 's1', stageName: '系統驗收' } })
    const replay = await command.releaseSettlement(
      actor(admin2Id, ['admin']),
      { settlementId: settled.receipt.settlementId, reason: '老師要補分' },
      requestId,
    )
    expect(replay.ok && replay.receipt.releasedAt).toEqual(released.ok && released.receipt.releasedAt)

    expect(
      await grading.submitFinal(teacherActor(s.t1), { assignmentId: s.a1, scores: { i1: '90', i2: '90' } }, randomUUID()),
    ).toMatchObject({ ok: true })
    expect([await auditCount('grading.settle', s.cohortId), await auditCount('grading.release', s.cohortId)]).toEqual([1, 1])
    const payload = await owner.sql(`select payload from audit_events where action = 'grading.release' and cohort_id = $1`, [s.cohortId])
    expect(payload.rows[0]!.payload).toEqual({
      cohortId: s.cohortId,
      stageKey: 's1',
      stageName: '系統驗收',
      countedEvaluations: 1,
      reason: '老師要補分',
    })

    const history = await query.settlements(adminActor(), s.cohortId)
    if (!history.ok) throw new Error(history.message)
    expect(history.receipt).toHaveLength(1)
    expect(history.receipt[0]).toMatchObject({
      settlementId: settled.receipt.settlementId,
      releasedBy: { userId: admin2Id, name: '系辦乙' },
      releaseReason: '老師要補分',
    })
    expect(history.receipt[0]!.releasedAt).toBeInstanceOf(Date)
    expect(await query.settlementOf(teacherActor(s.t1), s.cohortId, 's1')).toMatchObject({ ok: true, receipt: { settlement: null } })

    for (const settlementId of [randomUUID(), 'not-a-uuid']) {
      const missing = await command.releaseSettlement(adminActor(), { settlementId, reason: '重開' }, randomUUID())
      expect(missing).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', message: '找不到這筆結算，請重新整理頁面。' })
    }
  })

  it('settlementOf：老師、系辦都讀得到現行結算；settlements 新的在前、含已解除', async () => {
    const s = await scenario()
    const first = await settle(s.cohortId, randomUUID(), '第一次')
    if (!first.ok) throw new Error(first.message)
    await command.releaseSettlement(adminActor(), { settlementId: first.receipt.settlementId, reason: '重開' }, randomUUID())
    const second = await settle(s.cohortId, randomUUID(), '第二次')
    if (!second.ok) throw new Error(second.message)
    for (const who of [teacherActor(s.t1), adminActor()]) {
      const r = await query.settlementOf(who, s.cohortId, 's1')
      expect(r).toMatchObject({
        ok: true,
        receipt: { settlement: { settlementId: second.receipt.settlementId, reason: '第二次', stageName: '系統驗收' } },
      })
    }
    const history = await query.settlements(adminActor(), s.cohortId)
    expect(history.ok && history.receipt.map((h) => [h.reason, h.releasedAt === null])).toEqual([
      ['第二次', true],
      ['第一次', false],
    ])
  })
})

describe('C1-04 理由選填（X2；AC-31 後端）', () => {
  it('結算理由留空 → 成功、理由存 null；解除結算理由留空 → 成功；紀錄裡兩個理由都是 null', async () => {
    const s = await scenario()
    const settled = await settle(s.cohortId, randomUUID(), '')
    expect(settled).toMatchObject({ ok: true, receipt: { reason: null } })
    if (!settled.ok) throw new Error(settled.message)
    const released = await command.releaseSettlement(adminActor(), { settlementId: settled.receipt.settlementId }, randomUUID())
    expect(released).toMatchObject({ ok: true })
    const history = await query.settlements(adminActor(), s.cohortId)
    expect(history.ok && history.receipt.map((h) => [h.reason, h.releaseReason, h.releasedAt !== null])).toEqual([[null, null, true]])
  })
})
