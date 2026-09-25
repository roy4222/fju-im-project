import { randomUUID } from 'node:crypto'
import { strFromU8, unzipSync } from 'fflate'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { assertTestDatabaseReachable, createIsolatedDatabase, poolAsRole, type IsolatedDatabase } from '../../../test/db'
import { createBarrier } from '../../../test/barrier'
import { enableFaultInjection, injectFault } from '../../../test/fault-injection'
import { migratedSchema } from '../../../test/migrations'
import type { ResolvedActor } from '@/application/accounts'
import { DEFAULT_GRADE_EXPORT_FILTER, type SchemeStageInput } from '@/application/grading'
import { PgGradeExporter } from '@/infrastructure/grading/pg-grade-export'
import { PgGradingCommand, PgGradingQuery } from '@/infrastructure/grading/pg-grading'
import { PgGradebookQuery, PgGradingResultsCommand } from '@/infrastructure/grading/pg-grading-results'
import { PgEventPublisher } from '@/infrastructure/notifications/pg-event-publisher'
import { PgAuditWriter } from '@/infrastructure/ops/audit-writer'
import { PgOperationLedger } from '@/infrastructure/ops/operation-ledger'

/**
 * 票 24：成績表、退回、更正與復核、改派三選一、套用新方案版本、匯出
 * （產品模組 06 §4「7.3」「7.4」「7.5」「7.6」；GRD-05–10、13–15）。
 *
 * 全部以正式執行角色 `fju_app` 連線（欄級 GRANT、trigger 寫錯這裡直接紅）。
 * 數字用案例本身的：80／84.29 → 82.145（82.15）；期中 60%、期末 40%、期末 90 → 85.287（85.29）。
 */

let owner: IsolatedDatabase
let app: Pool
let adminId: string
const businessNow = new Date('2026-12-01T02:00:00Z')
const businessClock = { now: async () => new Date(businessNow.getTime()) }

let command: PgGradingCommand
let query: PgGradingQuery
let results: PgGradingResultsCommand
let book: PgGradebookQuery
let exporter: PgGradeExporter

function actor(userId: string, roles: ('admin' | 'teacher' | 'student')[]): ResolvedActor {
  return { kind: 'authenticated', userId, roles, status: 'active', mustChangePassword: false, cohortMemberships: [] }
}
const adminActor = () => actor(adminId, ['admin'])
const teacher = (id: string) => actor(id, ['teacher'])

let seq = 0
async function newUser(name: string, role: 'admin' | 'teacher' | 'student', studentNo: string | null = null): Promise<string> {
  seq += 1
  const row = await owner.sql(
    `insert into users (id, name, email, email_verified, updated_at, status)
     values (gen_random_uuid(), $1, $2, true, now(), 'active') returning id`,
    [name, `r${seq}-${randomUUID().slice(0, 8)}@example.com`],
  )
  const id = String(row.rows[0]!.id)
  await owner.sql(
    `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at) values (gen_random_uuid(), $1, $2, $1, now())`,
    [id, role],
  )
  await owner.sql(`insert into user_profiles (user_id, display_name, name_normalized, contact_email, student_no) values ($1, $2, $2, $3, $4)`, [
    id,
    name,
    `c${seq}@example.com`,
    studentNo,
  ])
  return id
}

async function newCohort(): Promise<string> {
  seq += 1
  const row = await owner.sql(
    `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
     values (gen_random_uuid(), $1, $1, 'active', '2027-06-30', 'system') returning id`,
    [`T24-${seq}`],
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
      `insert into group_memberships (id, group_id, cohort_id, user_id, valid_from, added_by_kind) values (gen_random_uuid(), $1, $2, $3, now(), 'system')`,
      [id, cohortId, m],
    )
  }
  return id
}

/** 期中 60%、期末 40%，各一個滿分 100 的項目（GRD-05／06 的測試方案；不是校方固定權重）。 */
const STAGES: SchemeStageInput[] = [
  { key: 'mid', name: '期中', weight: 60, items: [{ key: 'i1', name: '總分', type: 'number', max: 100, weight: 100 }] },
  { key: 'fin', name: '期末', weight: 40, items: [{ key: 'i1', name: '總分', type: 'number', max: 100, weight: 100 }] },
]

async function scheme(cohortId: string, stages: SchemeStageInput[] = STAGES): Promise<string> {
  const created = await command.createSchemeVersion(adminActor(), { cohortId, stages }, randomUUID())
  if (!created.ok) throw new Error(created.message)
  const published = await command.publishScheme(adminActor(), { versionId: created.receipt.versionId }, randomUUID())
  if (!published.ok) throw new Error(published.message)
  return created.receipt.versionId
}

async function requirement(groupId: string, stageKey: string, count: number) {
  const current = await owner.sql('select revision from stage_requirements where group_id = $1 and stage_key = $2', [groupId, stageKey])
  const r = await command.setRequirement(
    adminActor(),
    { groupId, stageKey, requiredCount: count, revision: Number(current.rows[0]?.revision ?? 0) },
    randomUUID(),
  )
  if (!r.ok) throw new Error(r.message)
}

async function assign(groupId: string, teacherId: string, stageKey = 'mid'): Promise<string> {
  const r = await command.assign(adminActor(), { groupId, stageKey, teacherUserId: teacherId }, randomUUID())
  if (!r.ok) throw new Error(r.message)
  return r.receipt.assignmentId
}

async function submit(teacherId: string, assignmentId: string, value: string): Promise<string> {
  const r = await command.submitFinal(teacher(teacherId), { assignmentId, scores: { i1: value } }, randomUUID())
  if (!r.ok) throw new Error(r.message)
  return r.receipt.evaluationId
}

async function groupRow(cohortId: string, groupId: string) {
  const r = await book.gradebook(adminActor(), cohortId)
  if (!r.ok) throw new Error(r.message)
  return r.receipt.groups.find((g) => g.id === groupId)!
}

async function preview(assignmentId: string) {
  const r = await book.previewReassignment(adminActor(), assignmentId)
  if (!r.ok) throw new Error(r.message)
  return r.receipt
}

async function stateOf(evaluationId: string): Promise<string> {
  return String((await owner.sql('select state from evaluation_status where evaluation_id = $1', [evaluationId])).rows[0]!.state)
}

async function overrideState(overrideId: string): Promise<string> {
  return String((await owner.sql('select state from override_review_state where override_id = $1', [overrideId])).rows[0]!.state)
}

/** 標準場景：G1 期中要兩份（T1＝80、T3＝84.29）、期末一份（T2＝90）。 */
async function standard() {
  const cohortId = await newCohort()
  const versionId = await scheme(cohortId)
  const s1 = await newUser('甲生', 'student', '0412345')
  const s2 = await newUser('=HYPERLINK("http://x")', 'student', '0412346')
  const groupId = await newGroup(cohortId, 'G01', [s1, s2])
  const [t1, t2, t3] = [await newUser('甲老師', 'teacher'), await newUser('乙老師', 'teacher'), await newUser('丙老師', 'teacher')]
  await requirement(groupId, 'mid', 2)
  await requirement(groupId, 'fin', 1)
  const a1 = await assign(groupId, t1)
  const a3 = await assign(groupId, t3)
  const a2 = await assign(groupId, t2, 'fin')
  return { cohortId, versionId, groupId, t1, t2, t3, a1, a2, a3 }
}

beforeAll(async () => {
  await assertTestDatabaseReachable()
  owner = await createIsolatedDatabase({ label: 'grading24', setup: migratedSchema })
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
  results = new PgGradingResultsCommand(deps)
  book = new PgGradebookQuery(() => app)
  exporter = new PgGradeExporter({ query: book, audit: new PgAuditWriter(), pool: () => app })
})

afterAll(async () => {
  await app?.end()
  await owner?.close()
})

describe('成績表（GRD-05、GRD-06）', () => {
  it('期中 80／84.29 → 82.145（82.15）；期末 90；最終 85.287（85.29）；未達份數標尚未完成、最終沒有值', async () => {
    const s = await standard()
    await submit(s.t1, s.a1, '80')
    let g = await groupRow(s.cohortId, s.groupId)
    expect(g.result.stages[0]).toMatchObject({ averageDisplay: '80.00', status: 'incomplete', required: 2 })
    expect(g.result.finalDisplay).toBeNull()
    expect(g.missing.map((m) => m.teacherName).sort()).toEqual(['丙老師', '乙老師'])

    await submit(s.t3, s.a3, '84.29')
    await submit(s.t2, s.a2, '90')
    g = await groupRow(s.cohortId, s.groupId)
    expect(g.result.stages.map((x) => [x.averageExact, x.averageDisplay, x.status])).toEqual([
      ['82.145', '82.15', 'complete'],
      ['90', '90.00', 'complete'],
    ])
    expect([g.result.finalExact, g.result.finalDisplay]).toEqual(['85.287', '85.29'])
    expect(g.members.map((m) => m.studentNo)).toEqual(['0412345', '0412346'])
    expect(g.missing).toEqual([])

    const detail = await book.groupDetail(adminActor(), s.groupId)
    expect(detail.ok && detail.receipt.result.finalExact).toBe('85.287')
  })

  it('老師、學生讀成績表、明細、預覽、匯出：FORBIDDEN', async () => {
    const s = await standard()
    for (const who of [teacher(s.t1), actor(s.t1, ['student'])]) {
      expect(await book.gradebook(who, s.cohortId)).toMatchObject({ ok: false, code: 'FORBIDDEN' })
      expect(await book.groupDetail(who, s.groupId)).toMatchObject({ ok: false, code: 'FORBIDDEN' })
      expect(await book.previewReassignment(who, s.a1)).toMatchObject({ ok: false, code: 'FORBIDDEN' })
      expect(await book.previewSchemeVersion(who, s.versionId)).toMatchObject({ ok: false, code: 'FORBIDDEN' })
      expect(
        await exporter.exportGrades(who, { cohortId: s.cohortId, format: 'csv', filter: DEFAULT_GRADE_EXPORT_FILTER }),
      ).toMatchObject({ ok: false, code: 'FORBIDDEN' })
      expect(await results.returnEvaluation(who, { evaluationId: randomUUID(), reason: 'x' }, randomUUID())).toMatchObject({ code: 'FORBIDDEN' })
      expect(
        await results.removeAssignment(who, { assignmentId: s.a1, choice: 'replace', newTeacherUserId: null, reason: 'x', basisHash: '0'.repeat(64) }, randomUUID()),
      ).toMatchObject({ code: 'FORBIDDEN' })
      expect(await results.override(who, { groupId: s.groupId, newValue: '90', reason: 'x', basisHash: '0'.repeat(64) }, randomUUID())).toMatchObject({
        code: 'FORBIDDEN',
      })
      expect(
        await results.resolveReview(who, { overrideId: randomUUID(), decision: 'keep', newValue: null, reason: 'x', basisHash: '0'.repeat(64) }, randomUUID()),
      ).toMatchObject({ code: 'FORBIDDEN' })
      expect(await results.applySchemeVersion(who, { versionId: s.versionId, token: '0'.repeat(64) }, randomUUID())).toMatchObject({ code: 'FORBIDDEN' })
    }
  })
})

describe('退回重送（GRD-07）', () => {
  it('退回要理由；老師收到通知（附理由、無分數）；退回不算完成；老師看到理由與預填；重送重新鎖定；兩筆紀錄都留著', async () => {
    const s = await standard()
    const first = await submit(s.t2, s.a2, '90')
    expect(await results.returnEvaluation(adminActor(), { evaluationId: first, reason: '  ' }, randomUUID())).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
    })
    const requestId = randomUUID()
    const back = await results.returnEvaluation(adminActor(), { evaluationId: first, reason: '請補上展示影片的評語' }, requestId)
    expect(back).toMatchObject({ ok: true, receipt: { groupCode: 'G01', stageName: '期末', teacherName: '乙老師' } })
    // 同一個請求編號重送：回原回執，不再做一次。
    expect(await results.returnEvaluation(adminActor(), { evaluationId: first, reason: '請補上展示影片的評語' }, requestId)).toMatchObject({ ok: true })
    // 已經退回的再退回：CONFLICT。
    expect(await results.returnEvaluation(adminActor(), { evaluationId: first, reason: '再退一次' }, randomUUID())).toMatchObject({
      ok: false,
      code: 'CONFLICT',
    })
    expect(await stateOf(first)).toBe('returned')
    const reasonRow = await owner.sql(`select reason from evaluation_status_events where evaluation_id = $1 and to_state = 'returned'`, [first])
    expect(reasonRow.rows.map((r) => r.reason)).toEqual(['請補上展示影片的評語'])

    const events = await owner.sql(`select recipients, payload from domain_events where type = 'grading.returned'`)
    const mine = events.rows.filter((e) => (e.recipients as string[]).includes(s.t2))
    expect(mine).toHaveLength(1)
    expect(JSON.stringify(mine[0]!.payload)).toContain('請補上展示影片的評語')
    // 沒有分數：payload 只有這幾個欄位，文字欄也不含 90（不整串比對，組別 UUID 可能剛好含 "90"）。
    const payload = mine[0]!.payload as Record<string, unknown>
    expect(Object.keys(payload).sort()).toEqual(['code', 'groupId', 'reason', 'stageKey', 'title'])
    expect(`${String(payload.title)} ${String(payload.reason)}`).not.toContain('90')

    const g = await groupRow(s.cohortId, s.groupId)
    expect(g.result.stages[1]).toMatchObject({ status: 'incomplete', averageDisplay: null })

    const bench = await query.teacherBench(teacher(s.t2), s.groupId)
    expect(bench.ok && bench.receipt.entries[0]).toMatchObject({
      state: 'empty',
      scores: { i1: '90' },
      returned: { reason: '請補上展示影片的評語' },
    })
    expect((await query.teacherQueue(teacher(s.t2)))[0]).toMatchObject({ returned: true })

    const second = await submit(s.t2, s.a2, '92')
    expect(await stateOf(second)).toBe('counted')
    expect(await stateOf(first)).toBe('returned')
    const again = await query.teacherBench(teacher(s.t2), s.groupId)
    expect(again.ok && again.receipt.entries[0]).toMatchObject({ state: 'counted', finalScore: '92.00', returned: null })
    const detail = await book.groupDetail(adminActor(), s.groupId)
    expect(detail.ok && detail.receipt.evaluations.filter((e) => e.stageKey === 'fin').map((e) => e.state)).toEqual(['counted', 'returned'])
  })

  it('老師帳號已停用：不能退回給他（先處理指派）；指派已結束：NOT_ASSIGNED', async () => {
    const s = await standard()
    const ev = await submit(s.t2, s.a2, '90')
    await owner.sql(`update users set status = 'disabled' where id = $1`, [s.t2])
    expect(await results.returnEvaluation(adminActor(), { evaluationId: ev, reason: '重評' }, randomUUID())).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
    })
    await owner.sql(`update users set status = 'active' where id = $1`, [s.t2])
    const p = await preview(s.a2)
    const kept = await results.removeAssignment(
      adminActor(),
      { assignmentId: s.a2, choice: 'keep', newTeacherUserId: null, reason: '乙老師出國', basisHash: p.basisHash },
      randomUUID(),
    )
    expect(kept.ok).toBe(true)
    expect(await results.returnEvaluation(adminActor(), { evaluationId: ev, reason: '重評' }, randomUUID())).toMatchObject({
      ok: false,
      code: 'NOT_ASSIGNED',
    })
  })
})

describe('管理員更正與待復核（GRD-08、GRD-15）', () => {
  it('最終未完成 FINAL_INCOMPLETE；完成後更正保留原值與理由、不動老師輸入；基礎改變進待復核並通知管理員一次；沿用建新版本', async () => {
    const s = await standard()
    await submit(s.t1, s.a1, '80')
    await submit(s.t3, s.a3, '84.29')
    let g = await groupRow(s.cohortId, s.groupId)
    expect(await results.override(adminActor(), { groupId: s.groupId, newValue: '88', reason: '口試補考', basisHash: g.basisHash }, randomUUID())).toMatchObject(
      { ok: false, code: 'FINAL_INCOMPLETE' },
    )

    const fin = await submit(s.t2, s.a2, '90')
    // 畫面拿的是舊的計算基礎：CONFLICT。
    expect(await results.override(adminActor(), { groupId: s.groupId, newValue: '88', reason: '口試補考', basisHash: g.basisHash }, randomUUID())).toMatchObject(
      { ok: false, code: 'CONFLICT' },
    )
    g = await groupRow(s.cohortId, s.groupId)
    expect(await results.override(adminActor(), { groupId: s.groupId, newValue: '101', reason: 'x', basisHash: g.basisHash }, randomUUID())).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
    })
    const evaluationsBefore = (await owner.sql('select count(*)::int as n from evaluations')).rows[0]!.n
    const done = await results.override(adminActor(), { groupId: s.groupId, newValue: '88', reason: '口試補考', basisHash: g.basisHash }, randomUUID())
    expect(done).toMatchObject({ ok: true, receipt: { originalValue: '85.287', newValue: '88' } })
    const overrideId = done.ok ? done.receipt.overrideId : ''
    const row = await owner.sql('select original_value::text as o, new_value::text as n, reason, actor_user_id, scheme_version_id from grade_overrides where id = $1', [
      overrideId,
    ])
    expect(row.rows[0]).toMatchObject({ o: '85.2870', n: '88.0000', reason: '口試補考', actor_user_id: adminId, scheme_version_id: s.versionId })
    expect((await owner.sql('select count(*)::int as n from evaluations')).rows[0]!.n).toBe(evaluationsBefore)
    g = await groupRow(s.cohortId, s.groupId)
    expect(g.override).toMatchObject({ state: 'effective', newValue: '88', originalValue: '85.287' })
    // 更正完成不通知老師或學生。
    expect((await owner.sql(`select count(*)::int as n from domain_events where type = 'grading.overridden' and recipients <> '{}'`)).rows[0]!.n).toBe(0)

    // 計算基礎改變（退回期末那一份）→ 待復核，通知管理員一次。
    await results.returnEvaluation(adminActor(), { evaluationId: fin, reason: '重評' }, randomUUID())
    expect(await overrideState(overrideId)).toBe('pending_review')
    const notices = async () =>
      (await owner.sql(`select recipients from domain_events where type = 'grading.override_review' and source_id = $1`, [overrideId])).rows
    expect(await notices()).toHaveLength(1)
    expect((await notices())[0]!.recipients).toContain(adminId)
    g = await groupRow(s.cohortId, s.groupId)
    expect(g.override?.state).toBe('pending_review')
    const pending = await book.gradebook(adminActor(), s.cohortId)
    expect(pending.ok && pending.receipt.pendingReviews.map((p) => p.overrideId)).toEqual([overrideId])

    // 還沒完成時不能處理復核。
    expect(
      await results.resolveReview(adminActor(), { overrideId, decision: 'keep', newValue: null, reason: '確認', basisHash: g.basisHash }, randomUUID()),
    ).toMatchObject({ ok: false, code: 'FINAL_INCOMPLETE' })

    // 老師重送（基礎又變）：已是待復核，不重複通知。
    await submit(s.t2, s.a2, '94')
    expect(await notices()).toHaveLength(1)
    g = await groupRow(s.cohortId, s.groupId)
    expect(g.result.finalExact).toBe('86.887')
    const kept = await results.resolveReview(
      adminActor(),
      { overrideId, decision: 'keep', newValue: null, reason: '口試補考結果不變', basisHash: g.basisHash },
      randomUUID(),
    )
    expect(kept).toMatchObject({ ok: true, receipt: { originalValue: '86.887', newValue: '88' } })
    expect(await overrideState(overrideId)).toBe('superseded')
    g = await groupRow(s.cohortId, s.groupId)
    expect(g.override).toMatchObject({ state: 'effective', newValue: '88', originalValue: '86.887' })
    // 已處理過的再處理：CONFLICT。
    expect(
      await results.resolveReview(adminActor(), { overrideId, decision: 'keep', newValue: null, reason: '再一次', basisHash: g.basisHash }, randomUUID()),
    ).toMatchObject({ ok: false, code: 'CONFLICT' })
  })

  it('只換主指導、不動評分：更正不受影響', async () => {
    const s = await standard()
    await submit(s.t1, s.a1, '80')
    await submit(s.t3, s.a3, '84.29')
    await submit(s.t2, s.a2, '90')
    const g = await groupRow(s.cohortId, s.groupId)
    const done = await results.override(adminActor(), { groupId: s.groupId, newValue: '88', reason: '補考', basisHash: g.basisHash }, randomUUID())
    await owner.sql(
      `insert into advisor_assignments (id, group_id, teacher_user_id, source, valid_from, assigned_by_user_id, reason)
       values (gen_random_uuid(), $1, $2, 'admin', now(), $3, '換主指導')`,
      [s.groupId, s.t1, adminId],
    )
    expect((await groupRow(s.cohortId, s.groupId)).basisHash).toBe(g.basisHash)
    expect(await overrideState(done.ok ? done.receipt.overrideId : '')).toBe('effective')
  })
})

describe('移除／改派三選一（GRD-13）', () => {
  async function scenario() {
    const cohortId = await newCohort()
    await scheme(cohortId)
    const groupId = await newGroup(cohortId, 'G01')
    const [t1, t2, t3] = [await newUser('T1', 'teacher'), await newUser('T2', 'teacher'), await newUser('T3', 'teacher')]
    await requirement(groupId, 'mid', 2)
    const a1 = await assign(groupId, t1)
    const a3 = await assign(groupId, t3)
    const e1 = await submit(t1, a1, '80')
    await submit(t3, a3, '90')
    return { cohortId, groupId, t1, t2, t3, a1, a3, e1 }
  }

  it('預覽三種選擇的前後：保留 2／2 平均 85；替換 1／2 尚未完成；新增 2／3', async () => {
    const s = await scenario()
    const p = await preview(s.a1)
    expect([p.requiredBefore, p.averageBefore, p.stageStatusBefore]).toEqual([2, '85.00', '已完成'])
    const byChoice = Object.fromEntries(p.options.map((o) => [o.choice, o]))
    expect(byChoice.keep).toMatchObject({ requiredAfter: 2, averageAfter: '85.00', stageStatusAfter: '已完成', blockedReason: null })
    expect(byChoice.replace).toMatchObject({ requiredAfter: 2, averageAfter: '90.00', stageStatusAfter: '尚未完成（1／2）' })
    expect(byChoice.add).toMatchObject({ requiredAfter: 3, averageAfter: '85.00', stageStatusAfter: '尚未完成（2／3）' })
    // 可以接手的老師不含已受指派的 T1、T3。
    expect(p.teachers.map((t) => t.userId)).toContain(s.t2)
    expect(p.teachers.map((t) => t.userId)).not.toContain(s.t3)
  })

  it('（a）保留：仍兩票、平均 85；T1 的指派結束、不能再寫；保留不能帶新老師', async () => {
    const s = await scenario()
    const p = await preview(s.a1)
    expect(
      await results.removeAssignment(adminActor(), { assignmentId: s.a1, choice: 'keep', newTeacherUserId: s.t2, reason: '出國', basisHash: p.basisHash }, randomUUID()),
    ).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    const r = await results.removeAssignment(
      adminActor(),
      { assignmentId: s.a1, choice: 'keep', newTeacherUserId: null, reason: '出國', basisHash: p.basisHash },
      randomUUID(),
    )
    expect(r).toMatchObject({ ok: true, receipt: { choice: 'keep', requiredCount: 2 } })
    const g = await groupRow(s.cohortId, s.groupId)
    expect(g.result.stages[0]).toMatchObject({ averageDisplay: '85.00', status: 'complete' })
    expect(g.result.stages[0]!.counted.find((c) => c.teacherName === 'T1')?.assignmentEnded).toBe(true)
    const ended = await owner.sql('select removal_choice, reason, valid_to is not null as ended from evaluator_assignments where id = $1', [s.a1])
    expect(ended.rows[0]).toMatchObject({ removal_choice: 'keep', reason: '出國', ended: true })
    expect(await command.saveDraft(teacher(s.t1), { assignmentId: s.a1, scores: { i1: '1' } }, randomUUID())).toMatchObject({ code: 'NOT_ASSIGNED' })
  })

  it('同一位老師不算兩票：T1 選「保留」後，再指派 T1、或改派／新增給 T1 都被擋；接手名單也沒有 T1', async () => {
    const s = await scenario()
    const p = await preview(s.a1)
    expect(
      (await results.removeAssignment(adminActor(), { assignmentId: s.a1, choice: 'keep', newTeacherUserId: null, reason: '出國', basisHash: p.basisHash }, randomUUID()))
        .ok,
    ).toBe(true)
    const again = await command.assign(adminActor(), { groupId: s.groupId, stageKey: 'mid', teacherUserId: s.t1 }, randomUUID())
    expect(again).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    if (!again.ok) expect(again.message).toContain('不能再算一票')

    const p3 = await preview(s.a3)
    expect(p3.teachers.map((t) => t.userId)).not.toContain(s.t1)
    expect(p3.teachers.map((t) => t.userId)).toContain(s.t2)
    const viaAdd = await results.removeAssignment(
      adminActor(),
      { assignmentId: s.a3, choice: 'add', newTeacherUserId: s.t1, reason: '加評', basisHash: p3.basisHash },
      randomUUID(),
    )
    expect(viaAdd).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    if (!viaAdd.ok) expect(viaAdd.message).toContain('不能再算一票')
    const g = await groupRow(s.cohortId, s.groupId)
    expect(g.result.stages[0]!.counted).toHaveLength(2)
  })

  it('（b）替換：舊 80 改為歷史；T2 收到指派通知、送出後重算；T1 的暫存失效、不轉給 T2', async () => {
    const s = await scenario()
    const p = await preview(s.a1)
    const r = await results.removeAssignment(
      adminActor(),
      { assignmentId: s.a1, choice: 'replace', newTeacherUserId: s.t2, reason: 'T1 請長假', basisHash: p.basisHash },
      randomUUID(),
    )
    expect(r).toMatchObject({ ok: true, receipt: { newTeacherName: 'T2', choice: 'replace' } })
    expect(await stateOf(s.e1)).toBe('historical')
    let g = await groupRow(s.cohortId, s.groupId)
    expect(g.result.stages[0]).toMatchObject({ averageDisplay: '90.00', status: 'incomplete' })
    const newAssignment = await owner.sql(
      'select id, previous_assignment_id from evaluator_assignments where group_id = $1 and teacher_user_id = $2 and valid_to is null',
      [s.groupId, s.t2],
    )
    expect(newAssignment.rows[0]!.previous_assignment_id).toBe(s.a1)
    const notice = await owner.sql(`select recipients from domain_events where type = 'grading.assigned' and source_id = $1`, [newAssignment.rows[0]!.id])
    expect(notice.rows[0]!.recipients).toEqual([s.t2])
    const bench = await query.teacherBench(teacher(s.t2), s.groupId)
    expect(bench.ok && bench.receipt.entries[0]).toMatchObject({ state: 'empty', scores: {} })
    await submit(s.t2, String(newAssignment.rows[0]!.id), '70')
    g = await groupRow(s.cohortId, s.groupId)
    expect(g.result.stages[0]).toMatchObject({ averageDisplay: '80.00', status: 'complete' })
  })

  it('（c）新增：舊 80 繼續採計、要求份數 3、完成 2／3；改派給已受指派的 T3 被要求先處理重複', async () => {
    const s = await scenario()
    const p = await preview(s.a1)
    const dup = await results.removeAssignment(
      adminActor(),
      { assignmentId: s.a1, choice: 'add', newTeacherUserId: s.t3, reason: '多一位', basisHash: p.basisHash },
      randomUUID(),
    )
    expect(dup).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    if (!dup.ok) expect(dup.message).toContain('重複')
    expect(
      await results.removeAssignment(adminActor(), { assignmentId: s.a1, choice: 'add', newTeacherUserId: s.t2, reason: ' ', basisHash: p.basisHash }, randomUUID()),
    ).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    const r = await results.removeAssignment(
      adminActor(),
      { assignmentId: s.a1, choice: 'add', newTeacherUserId: s.t2, reason: '請 T2 加評', basisHash: p.basisHash },
      randomUUID(),
    )
    expect(r).toMatchObject({ ok: true, receipt: { requiredCount: 3 } })
    expect(await stateOf(s.e1)).toBe('counted')
    const g = await groupRow(s.cohortId, s.groupId)
    expect(g.result.stages[0]).toMatchObject({ required: 3, averageDisplay: '85.00', status: 'incomplete' })
  })

  it('要求份數已到上限 10：預覽「新增」標不能用、執行被拒、份數不變；保留與替換照常', async () => {
    const s = await scenario()
    await requirement(s.groupId, 'mid', 10)
    const p = await preview(s.a1)
    const byChoice = Object.fromEntries(p.options.map((o) => [o.choice, o]))
    expect(byChoice.add!.blockedReason).toContain('上限 10')
    expect(byChoice.keep!.blockedReason).toBeNull()
    expect(byChoice.replace!.blockedReason).toBeNull()
    const over = await results.removeAssignment(
      adminActor(),
      { assignmentId: s.a1, choice: 'add', newTeacherUserId: s.t2, reason: '請 T2 加評', basisHash: p.basisHash },
      randomUUID(),
    )
    expect(over).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    if (!over.ok) expect(over.message).toContain('上限 10')
    const req = await owner.sql(`select required_count from stage_requirements where group_id = $1 and stage_key = 'mid'`, [s.groupId])
    expect(req.rows[0]!.required_count).toBe(10)
    expect((await owner.sql('select valid_to from evaluator_assignments where id = $1', [s.a1])).rows[0]!.valid_to).toBeNull()

    // 份數 9：新增後剛好 10，可以。
    await requirement(s.groupId, 'mid', 9)
    const p9 = await preview(s.a1)
    expect(p9.options.find((o) => o.choice === 'add')!.blockedReason).toBeNull()
    expect(
      await results.removeAssignment(
        adminActor(),
        { assignmentId: s.a1, choice: 'add', newTeacherUserId: s.t2, reason: '請 T2 加評', basisHash: p9.basisHash },
        randomUUID(),
      ),
    ).toMatchObject({ ok: true, receipt: { requiredCount: 10 } })
  })

  it('沒有正式分數的老師：只能「替換」（可以只移除），暫存標失效並保留內容；重新指派不復活舊暫存', async () => {
    const cohortId = await newCohort()
    await scheme(cohortId)
    const groupId = await newGroup(cohortId, 'G01')
    const t1 = await newUser('T1', 'teacher')
    await requirement(groupId, 'mid', 1)
    const a1 = await assign(groupId, t1)
    const draft = await command.saveDraft(teacher(t1), { assignmentId: a1, scores: { i1: '66' } }, randomUUID())
    const draftId = draft.ok ? draft.receipt.evaluationId : ''
    const p = await preview(a1)
    expect(p.options.find((o) => o.choice === 'keep')?.blockedReason).toContain('沒有可保留')
    expect(
      await results.removeAssignment(adminActor(), { assignmentId: a1, choice: 'keep', newTeacherUserId: null, reason: '移除', basisHash: p.basisHash }, randomUUID()),
    ).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    expect(
      await results.removeAssignment(adminActor(), { assignmentId: a1, choice: 'replace', newTeacherUserId: null, reason: '移除', basisHash: p.basisHash }, randomUUID()),
    ).toMatchObject({ ok: true, receipt: { newTeacherName: null } })
    expect(await stateOf(draftId)).toBe('invalidated')
    const kept = await owner.sql('select scores from evaluations where id = $1', [draftId])
    expect(kept.rows[0]!.scores).toEqual({ i1: '66' })
    const g = await groupRow(cohortId, groupId)
    expect(g.missing).toEqual([])
    const again = await assign(groupId, t1)
    const bench = await query.teacherBench(teacher(t1), groupId)
    expect(bench.ok && bench.receipt.entries[0]).toMatchObject({ assignmentId: again, state: 'empty', scores: {} })
  })

  it('封存的屆別：預覽與執行都 COHORT_ARCHIVED（先解封）', async () => {
    const s = await scenario()
    const p = await preview(s.a1)
    await owner.sql(`update cohorts set status = 'archived' where id = $1`, [s.cohortId])
    expect(await book.previewReassignment(adminActor(), s.a1)).toMatchObject({ ok: false, code: 'COHORT_ARCHIVED' })
    expect(
      await results.removeAssignment(adminActor(), { assignmentId: s.a1, choice: 'keep', newTeacherUserId: null, reason: '出國', basisHash: p.basisHash }, randomUUID()),
    ).toMatchObject({ ok: false, code: 'COHORT_ARCHIVED' })
  })
})

describe('預覽過期（basis_hash；GRD-15、模組實作設計 06 §10 四種衝突）', () => {
  it.each([
    ['同一指派剛正式送出', 'same'],
    ['另一位老師剛正式送出', 'other'],
    ['剛有一份被退回', 'return'],
    ['要求份數剛改了', 'requirement'],
    ['剛套用了新方案版本', 'scheme'],
  ] as const)('%s：用舊預覽執行 → CONFLICT，重新預覽後才能執行；剛送出的分數沒被當暫存', async (_label, kind) => {
    const cohortId = await newCohort()
    await scheme(cohortId)
    const groupId = await newGroup(cohortId, 'G01')
    const [t1, t2, t3] = [await newUser('T1', 'teacher'), await newUser('T2', 'teacher'), await newUser('T3', 'teacher')]
    await requirement(groupId, 'mid', 3)
    const a1 = await assign(groupId, t1)
    const a2 = await assign(groupId, t2)
    const a3 = await assign(groupId, t3)
    const e3 = await submit(t3, a3, '70')
    if (kind === 'return' || kind === 'scheme') await submit(t2, a2, '75')
    const stale = await preview(a1)

    let justSubmitted: string | null = null
    if (kind === 'same') justSubmitted = await submit(t1, a1, '88')
    if (kind === 'other') justSubmitted = await submit(t2, a2, '77')
    if (kind === 'return') expect((await results.returnEvaluation(adminActor(), { evaluationId: e3, reason: '重評' }, randomUUID())).ok).toBe(true)
    if (kind === 'requirement') await requirement(groupId, 'mid', 2)
    if (kind === 'scheme') {
      const v2 = await command.createSchemeVersion(
        adminActor(),
        { cohortId, stages: [{ ...STAGES[0]!, items: [{ ...STAGES[0]!.items[0]!, max: 90 }] }, STAGES[1]!] },
        randomUUID(),
      )
      const versionId = v2.ok ? v2.receipt.versionId : ''
      const p = await book.previewSchemeVersion(adminActor(), versionId)
      expect(p.ok && p.receipt.blockers).toEqual([])
      expect((await results.applySchemeVersion(adminActor(), { versionId, token: p.ok ? p.receipt.token : '' }, randomUUID())).ok).toBe(true)
    }

    const input = { assignmentId: a1, choice: 'replace' as const, newTeacherUserId: null, reason: '改派', basisHash: stale.basisHash }
    expect(await results.removeAssignment(adminActor(), input, randomUUID())).toMatchObject({ ok: false, code: 'CONFLICT' })
    const fresh = await preview(a1)
    expect(fresh.basisHash).not.toBe(stale.basisHash)
    expect((await results.removeAssignment(adminActor(), { ...input, basisHash: fresh.basisHash }, randomUUID())).ok).toBe(true)
    if (kind === 'same') expect(await stateOf(justSubmitted!)).toBe('historical')
    if (kind === 'other') expect(await stateOf(justSubmitted!)).toBe('counted')
  })

  /** 等到有一筆交易卡在評分指派列的鎖上（輪詢 pg_stat_activity，不是固定 sleep）。 */
  async function someoneWaitsOnAssignmentLock(): Promise<void> {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const waiting = await owner.sql(
        `select count(*)::int as n from pg_stat_activity
          where wait_event_type = 'Lock' and query ilike '%evaluator_assignments%' and query ilike '%for update%'`,
      )
      if (Number(waiting.rows[0]!.n) > 0) return
      await new Promise((resolve) => setImmediate(resolve))
    }
    throw new Error('5 秒內沒有交易卡在評分指派的鎖上')
  }

  it.each([
    ['退回先拿到鎖', 'grading.return.before-update', 'CONFLICT'],
    ['改派先拿到鎖', 'grading.reassign.before-write', 'NOT_ASSIGNED'],
  ] as const)('退回 × 改派同時（%s）：先拿到鎖的成功；另一方等鎖、醒來依狀態回 %s（故障注入點＋同步屏障）', async (_label, point, loserCode) => {
    const cohortId = await newCohort()
    await scheme(cohortId)
    const groupId = await newGroup(cohortId, 'G01')
    const [t1, t2] = [await newUser('T1', 'teacher'), await newUser('T2', 'teacher')]
    await requirement(groupId, 'mid', 1)
    const a1 = await assign(groupId, t1)
    const e1 = await submit(t1, a1, '80')
    const p = await preview(a1)
    const doReturn = () => results.returnEvaluation(adminActor(), { evaluationId: e1, reason: '重評' }, randomUUID())
    const doReassign = () =>
      results.removeAssignment(adminActor(), { assignmentId: a1, choice: 'replace', newTeacherUserId: t2, reason: '改派', basisHash: p.basisHash }, randomUUID())

    const disable = enableFaultInjection()
    try {
      // 先到的一方在注入點停住（鎖都拿著）；另一方開始、卡在指派列的鎖上之後才放行。
      const holding = createBarrier(2)
      let release!: () => void
      const released = new Promise<void>((resolve) => (release = resolve))
      injectFault(point, async () => {
        await holding.arrive()
        await released
      })
      const first = point === 'grading.return.before-update' ? doReturn() : doReassign()
      await holding.arrive()
      const second = point === 'grading.return.before-update' ? doReassign() : doReturn()
      await someoneWaitsOnAssignmentLock()
      release()
      const [winner, loser] = await Promise.all([first, second])
      expect(winner.ok).toBe(true)
      expect(loser).toMatchObject({ ok: false, code: loserCode })
    } finally {
      disable()
    }
    // 只有一方的效果：退回贏 → 評分是 returned、指派還在；改派贏 → 評分是 historical、指派結束。
    const state = await stateOf(e1)
    const ended = (await owner.sql('select valid_to is not null as ended from evaluator_assignments where id = $1', [a1])).rows[0]!.ended
    expect([state, ended]).toEqual(point === 'grading.return.before-update' ? ['returned', false] : ['historical', true])
  })

  it('退回 × 改派不加注入點直接並發：也只會有一方成功', async () => {
    const cohortId = await newCohort()
    await scheme(cohortId)
    const groupId = await newGroup(cohortId, 'G01')
    const [t1, t2] = [await newUser('T1', 'teacher'), await newUser('T2', 'teacher')]
    await requirement(groupId, 'mid', 1)
    const a1 = await assign(groupId, t1)
    const e1 = await submit(t1, a1, '80')
    const p = await preview(a1)
    const outcomes = await Promise.all([
      results.returnEvaluation(adminActor(), { evaluationId: e1, reason: '重評' }, randomUUID()),
      results.removeAssignment(adminActor(), { assignmentId: a1, choice: 'replace', newTeacherUserId: t2, reason: '改派', basisHash: p.basisHash }, randomUUID()),
    ])
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1)
    const loser = outcomes.find((o) => !o.ok)!
    expect(['CONFLICT', 'NOT_ASSIGNED']).toContain(loser.ok ? '' : loser.code)
  })
})

describe('老師停用（GRD-14）', () => {
  it('停用不改派、不縮小分母：未送出列缺評「老師已停用」，已送出仍採計；匯出寫「缺評待處理」', async () => {
    const s = await standard()
    await submit(s.t1, s.a1, '80')
    await command.saveDraft(teacher(s.t3), { assignmentId: s.a3, scores: { i1: '70' } }, randomUUID())
    await owner.sql(`update users set status = 'disabled' where id = any($1::uuid[])`, [[s.t1, s.t3]])
    const g = await groupRow(s.cohortId, s.groupId)
    expect(g.result.stages[0]).toMatchObject({ required: 2, averageDisplay: '80.00', status: 'incomplete' })
    expect(g.missing.find((m) => m.teacherName === '丙老師')).toMatchObject({ teacherInactive: true })
    const csv = await exporter.exportGrades(adminActor(), { cohortId: s.cohortId, format: 'csv', filter: DEFAULT_GRADE_EXPORT_FILTER })
    expect(csv.ok && String(csv.receipt.body)).toContain('期中：丙老師（老師已停用，缺評待處理）')
    // 停用期間原草稿保留但不可操作（停用的人解析出來就不是有效身分）。
    const disabled: ResolvedActor = { ...actor(s.t3, ['teacher']), status: 'disabled' } as ResolvedActor
    expect(await command.saveDraft(disabled, { assignmentId: s.a3, scores: { i1: '71' } }, randomUUID())).toMatchObject({ ok: false })
    expect((await owner.sql(`select count(*)::int as n from evaluation_status where assignment_id = $1 and state = 'draft'`, [s.a3])).rows[0]!.n).toBe(1)
  })
})

describe('方案鎖定後套用新版本（GRD-09）', () => {
  it('預覽看影響（取消不動任何東西）；預覽後有人送分 → CONFLICT；確認後用新權重重算、方案版本換成新版並鎖定、更正進待復核', async () => {
    const s = await standard()
    await submit(s.t1, s.a1, '80')
    await submit(s.t3, s.a3, '84.29')
    await submit(s.t2, s.a2, '90')
    const g = await groupRow(s.cohortId, s.groupId)
    const o = await results.override(adminActor(), { groupId: s.groupId, newValue: '88', reason: '補考', basisHash: g.basisHash }, randomUUID())

    const v2 = await command.createSchemeVersion(
      adminActor(),
      { cohortId: s.cohortId, stages: [{ ...STAGES[0]!, weight: 50 }, { ...STAGES[1]!, weight: 50 }] },
      randomUUID(),
    )
    const versionId = v2.ok ? v2.receipt.versionId : ''
    const p = await book.previewSchemeVersion(adminActor(), versionId)
    expect(p.ok).toBe(true)
    if (!p.ok) return
    expect(p.receipt.blockers).toEqual([])
    expect(p.receipt.groups.find((x) => x.groupId === s.groupId)).toMatchObject({
      finalBefore: '85.29',
      finalAfter: '86.07',
      changed: true,
      hasOverride: true,
    })
    // 取消（只看預覽）：什麼都沒變。
    expect((await groupRow(s.cohortId, s.groupId)).result.finalDisplay).toBe('85.29')

    // 預覽之後又有人送分（新一組）：舊預覽過期。
    const g2 = await newGroup(s.cohortId, 'G02')
    await requirement(g2, 'mid', 1)
    const a = await assign(g2, s.t1)
    await submit(s.t1, a, '60')
    expect(await results.applySchemeVersion(adminActor(), { versionId, token: p.receipt.token }, randomUUID())).toMatchObject({
      ok: false,
      code: 'CONFLICT',
    })

    const again = await book.previewSchemeVersion(adminActor(), versionId)
    const applied = await results.applySchemeVersion(adminActor(), { versionId, token: again.ok ? again.receipt.token : '' }, randomUUID())
    expect(applied).toMatchObject({ ok: true, receipt: { versionNo: 2, status: 'locked' } })
    const after = await groupRow(s.cohortId, s.groupId)
    expect(after.result.finalExact).toBe('86.0725')
    expect(after.result.finalDisplay).toBe('86.07')
    expect(await overrideState(o.ok ? o.receipt.overrideId : '')).toBe('pending_review')
    const board = await query.adminBoard(adminActor(), s.cohortId)
    expect(board.ok && board.receipt.current).toMatchObject({ versionNo: 2, status: 'locked' })
    // 已送出的老師輸入沒被改：仍記著送出當時的 v1。
    const v1Rows = await owner.sql(`select count(*)::int as n from evaluations where scheme_version_id = $1`, [s.versionId])
    expect(v1Rows.rows[0]!.n).toBeGreaterThanOrEqual(3)
  })

  it('數字沒變也提示「更正會進待復核」（方案版本是計算基礎）；已經待復核的不算在提示裡', async () => {
    const s = await standard()
    await submit(s.t1, s.a1, '80')
    await submit(s.t3, s.a3, '84.29')
    await submit(s.t2, s.a2, '90')
    const g = await groupRow(s.cohortId, s.groupId)
    const o = await results.override(adminActor(), { groupId: s.groupId, newValue: '88', reason: '補考', basisHash: g.basisHash }, randomUUID())
    // 同樣的權重另建一版：數字不變。
    const same = await command.createSchemeVersion(adminActor(), { cohortId: s.cohortId, stages: STAGES }, randomUUID())
    const sameId = same.ok ? same.receipt.versionId : ''
    const p = await book.previewSchemeVersion(adminActor(), sameId)
    expect(p.ok && p.receipt.groups.find((x) => x.groupId === s.groupId)).toMatchObject({ changed: false, hasOverride: true })
    expect((await results.applySchemeVersion(adminActor(), { versionId: sameId, token: p.ok ? p.receipt.token : '' }, randomUUID())).ok).toBe(true)
    expect(await overrideState(o.ok ? o.receipt.overrideId : '')).toBe('pending_review')
    // 已經待復核：再套用一版不會「再進」待復核，提示就不再出現。
    const next = await command.createSchemeVersion(adminActor(), { cohortId: s.cohortId, stages: STAGES }, randomUUID())
    const p2 = await book.previewSchemeVersion(adminActor(), next.ok ? next.receipt.versionId : '')
    expect(p2.ok && p2.receipt.groups.find((x) => x.groupId === s.groupId)?.hasOverride).toBe(false)
  })

  it('只有暫存就已鎖定（票 23：第一位老師開始填就鎖）：直接發布 SCHEME_LOCKED，改走套用；沒有採計所以成績不變，暫存保留、提示照舊版本填的', async () => {
    const s = await standard()
    const draft = await command.saveDraft(teacher(s.t1), { assignmentId: s.a1, scores: { i1: '70' } }, randomUUID())
    expect(draft.ok).toBe(true)
    const v2 = await command.createSchemeVersion(
      adminActor(),
      { cohortId: s.cohortId, stages: [{ ...STAGES[0]!, weight: 50 }, { ...STAGES[1]!, weight: 50 }] },
      randomUUID(),
    )
    const versionId = v2.ok ? v2.receipt.versionId : ''
    expect(await command.publishScheme(adminActor(), { versionId }, randomUUID())).toMatchObject({ ok: false, code: 'SCHEME_LOCKED' })
    const p = await book.previewSchemeVersion(adminActor(), versionId)
    expect(p.ok && p.receipt.blockers).toEqual([])
    expect(p.ok && p.receipt.groups.every((g) => !g.changed)).toBe(true)
    expect(await results.applySchemeVersion(adminActor(), { versionId, token: p.ok ? p.receipt.token : '' }, randomUUID())).toMatchObject({
      ok: true,
      receipt: { versionNo: 2, status: 'locked' },
    })
    const bench = await query.teacherBench(teacher(s.t1), s.groupId)
    expect(bench.ok && bench.receipt.entries.find((e) => e.stage.key === 'mid')).toMatchObject({
      state: 'draft',
      scores: { i1: '70' },
      draftFromOlderVersion: true,
    })
  })

  it('已有正式評分的階段在新版本對不上（多了項目、滿分比已給的低）：列出原因、不能套用', async () => {
    const s = await standard()
    await submit(s.t1, s.a1, '80')
    const v2 = await command.createSchemeVersion(
      adminActor(),
      {
        cohortId: s.cohortId,
        stages: [
          {
            ...STAGES[0]!,
            items: [
              { key: 'i1', name: '總分', type: 'number', max: 70, weight: 50 },
              { key: 'i2', name: '新項目', type: 'number', max: 100, weight: 50 },
            ],
          },
          STAGES[1]!,
        ],
      },
      randomUUID(),
    )
    const versionId = v2.ok ? v2.receipt.versionId : ''
    const p = await book.previewSchemeVersion(adminActor(), versionId)
    expect(p.ok && p.receipt.blockers.length).toBeGreaterThan(0)
    expect(p.ok && p.receipt.blockers[0]).toContain('甲老師')
    expect(await results.applySchemeVersion(adminActor(), { versionId, token: p.ok ? p.receipt.token : '' }, randomUUID())).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
    })
  })
})

describe('匯出（GRD-10）', () => {
  it('CSV：每位組員一列、學號前導零、兩位小數與畫面一致、更正註記、公式字首加 \'；XLSX：學號是文字儲存格', async () => {
    const s = await standard()
    await submit(s.t1, s.a1, '80')
    await submit(s.t3, s.a3, '84.29')
    await submit(s.t2, s.a2, '90')
    const g = await groupRow(s.cohortId, s.groupId)
    await results.override(adminActor(), { groupId: s.groupId, newValue: '88', reason: '口試補考', basisHash: g.basisHash }, randomUUID())
    const other = await newGroup(s.cohortId, 'G02')
    await requirement(other, 'mid', 1)

    const csv = await exporter.exportGrades(adminActor(), { cohortId: s.cohortId, format: 'csv', filter: DEFAULT_GRADE_EXPORT_FILTER })
    expect(csv).toMatchObject({ ok: true, receipt: { groupCount: 2, rowCount: 3 } })
    const text = csv.ok ? String(csv.receipt.body) : ''
    const lines = text.replace(/^\uFEFF/, '').trimEnd().split('\r\n')
    expect(lines[0]).toBe(
      '"屆別","組別","學號","姓名","期中 份數","期中 平均","期中 狀態","期末 份數","期末 平均","期末 狀態","最終成績（計算）","最終成績（原始精度）","最終成績（採用）","更正註記","缺評待處理","方案版本"',
    )
    expect(lines[1]).toContain('"G01","0412345","甲生","2／2","82.15","已完成","1／1","90.00","已完成","85.29","85.287","88.00","已更正：原 85.29 → 88.00（口試補考）"')
    expect(lines[2]).toContain('"\'=HYPERLINK(""http://x"")"')
    expect(lines[3]).toContain('"G02","","","0／1","","尚未完成（0／1）"')

    // 「尚缺幾位評分老師」依階段篩：G02 只有期中要一份、沒有指派；只匯出期末時不該出現期中的缺額。
    const finOnly = await exporter.exportGrades(adminActor(), {
      cohortId: s.cohortId,
      format: 'csv',
      filter: { stageKey: 'fin', groupId: other, status: 'all' },
    })
    expect(finOnly.ok && String(finOnly.receipt.body)).not.toContain('尚缺')
    const midOnly = await exporter.exportGrades(adminActor(), {
      cohortId: s.cohortId,
      format: 'csv',
      filter: { stageKey: 'mid', groupId: other, status: 'all' },
    })
    expect(midOnly.ok && String(midOnly.receipt.body)).toContain('期中：尚缺 1 位評分老師（待指派）')

    const filtered = await exporter.exportGrades(adminActor(), {
      cohortId: s.cohortId,
      format: 'csv',
      filter: { stageKey: 'mid', groupId: 'all', status: 'complete' },
    })
    expect(filtered).toMatchObject({ ok: true, receipt: { groupCount: 1, rowCount: 2 } })
    expect(filtered.ok && String(filtered.receipt.body)).not.toContain('期末 平均')
    expect(
      await exporter.exportGrades(adminActor(), { cohortId: s.cohortId, format: 'csv', filter: { stageKey: 'nope', groupId: 'all', status: 'all' } }),
    ).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })

    const xlsx = await exporter.exportGrades(adminActor(), { cohortId: s.cohortId, format: 'xlsx', filter: DEFAULT_GRADE_EXPORT_FILTER })
    expect(xlsx.ok).toBe(true)
    const sheet = strFromU8(unzipSync(xlsx.ok ? (xlsx.receipt.body as Uint8Array) : new Uint8Array())['xl/worksheets/sheet1.xml']!)
    expect(sheet).toContain('<c r="C2" t="inlineStr"><is><t xml:space="preserve">0412345</t></is></c>')
    expect(sheet).toContain('>85.29<')
    const audit = await owner.sql(`select payload from audit_events where action = 'grading.export' order by real_at desc limit 1`)
    expect(audit.rows[0]!.payload).toMatchObject({ format: 'xlsx', groups: 2, rows: 3 })
    expect(JSON.stringify(audit.rows[0]!.payload)).not.toContain('0412345')
  })
})
