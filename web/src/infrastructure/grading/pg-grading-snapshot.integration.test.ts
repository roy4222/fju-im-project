import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { assertTestDatabaseReachable, createIsolatedDatabase, poolAsRole, type IsolatedDatabase } from '../../../test/db'
import { migratedSchema } from '../../../test/migrations'
import type { ResolvedActor } from '@/application/accounts'
import type { SchemeStageInput } from '@/application/grading'
import { PgGradingCommand, PgGradingQuery } from '@/infrastructure/grading/pg-grading'
import { PgGradebookQuery, PgGradingResultsCommand } from '@/infrastructure/grading/pg-grading-results'
import { PgGradingSettlementCommand } from '@/infrastructure/grading/pg-grade-settlements'
import { PgGradingSnapshotQuery } from '@/infrastructure/grading/pg-grading-snapshot'
import { PgEventPublisher } from '@/infrastructure/notifications/pg-event-publisher'
import { PgAuditWriter } from '@/infrastructure/ops/audit-writer'
import { PgOperationLedger } from '@/infrastructure/ops/operation-ledger'

/**
 * B 階段 TE-B6 屆別評分快照（設計方案 §4；AC-A-14、AC-A-15）。
 *
 * - 快照的 `board`／`gradebook` 要跟原本的 `adminBoard`／`gradebook` 逐欄相同（系辦成績管理頁換成只叫快照，畫面不變）。
 * - 句數固定：組數變多不多查（沒有 N+1）。
 * - 全部以正式執行角色 `fju_app` 連線。
 */

let owner: IsolatedDatabase
let app: Pool
let adminId: string
const businessClock = { now: async () => new Date('2026-12-01T02:00:00Z') }

let command: PgGradingCommand
let board: PgGradingQuery
let book: PgGradebookQuery
let results: PgGradingResultsCommand
let settlement: PgGradingSettlementCommand
let snapshot: PgGradingSnapshotQuery
let statements = 0

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
    [name, `s${seq}-${randomUUID().slice(0, 8)}@example.com`],
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
    [`A05-${seq}`],
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

const STAGES: SchemeStageInput[] = [
  { key: 'mid', name: '期中', weight: 60, items: [{ key: 'i1', name: '總分', type: 'number', max: 100, weight: 100 }] },
  { key: 'fin', name: '期末', weight: 40, items: [{ key: 'i1', name: '總分', type: 'number', max: 100, weight: 100 }] },
]

async function scheme(cohortId: string): Promise<string> {
  const created = await command.createSchemeVersion(adminActor(), { cohortId, stages: STAGES }, randomUUID())
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

async function submit(teacherId: string, assignmentId: string, value: string) {
  const r = await command.submitFinal(teacher(teacherId), { assignmentId, scores: { i1: value } }, randomUUID())
  if (!r.ok) throw new Error(r.message)
}

/** 回執的 requestId／serverTime 每次都不同，比對內容時拿掉。 */
function content<T extends { requestId: string; serverTime: string }>(receipt: T): Omit<T, 'requestId' | 'serverTime'> {
  const rest: Record<string, unknown> = { ...receipt }
  delete rest.requestId
  delete rest.serverTime
  return rest as Omit<T, 'requestId' | 'serverTime'>
}

async function snap(cohortId: string) {
  const r = await snapshot.cohortSnapshot(adminActor(), cohortId)
  if (!r.ok) throw new Error(r.message)
  return r.receipt
}

async function countStatements(cohortId: string): Promise<number> {
  statements = 0
  await snap(cohortId)
  return statements
}

/**
 * 涵蓋成績頁會出現的每一種狀態：G01 完成＋更正後改份數（待復核）；G02 有暫存、有停用老師（缺評）；
 * G03 有更正後解散（唯讀、不進待復核清單、解散前的組員）；期中已結算。
 */
async function richCohort() {
  const cohortId = await newCohort()
  await scheme(cohortId)
  const [s1, s2, s3] = [await newUser('甲生', 'student', '0412345'), await newUser('乙生', 'student', '0412346'), await newUser('丙生', 'student', '0412347')]
  const [t1, t2, t3] = [await newUser('甲老師', 'teacher'), await newUser('乙老師', 'teacher'), await newUser('丙老師', 'teacher')]

  const g1 = await newGroup(cohortId, 'G01', [s1])
  await requirement(g1, 'mid', 2)
  await requirement(g1, 'fin', 1)
  await submit(t1, await assign(g1, t1), '80')
  await submit(t3, await assign(g1, t3), '84.29')
  await submit(t2, await assign(g1, t2, 'fin'), '90')
  const row = (await book.gradebook(adminActor(), cohortId)) as Extract<Awaited<ReturnType<PgGradebookQuery['gradebook']>>, { ok: true }>
  const g1Row = row.receipt.groups.find((g) => g.id === g1)!
  const o = await results.override(adminActor(), { groupId: g1, newValue: '88', reason: '口試補考', basisHash: g1Row.basisHash }, randomUUID())
  if (!o.ok) throw new Error(o.message)
  await requirement(g1, 'fin', 2)

  const g2 = await newGroup(cohortId, 'G02', [s2])
  await requirement(g2, 'mid', 2)
  const a = await assign(g2, t1)
  const draft = await command.saveDraft(teacher(t1), { assignmentId: a, scores: { i1: '70' } }, randomUUID())
  if (!draft.ok) throw new Error(draft.message)
  await assign(g2, t2)
  await owner.sql(`update users set status = 'disabled' where id = $1`, [t2])

  const g3 = await newGroup(cohortId, 'G03', [s3])
  await requirement(g3, 'mid', 1)
  await submit(t3, await assign(g3, t3), '75')
  await owner.sql(`update groups set status = 'dissolved', dissolved_real_at = now(), dissolve_reason = '測試' where id = $1`, [g3])

  const settled = await settlement.settleStage(adminActor(), { cohortId, stageKey: 'mid', reason: '期中成績送教務處' }, randomUUID())
  if (!settled.ok) throw new Error(settled.message)
  return { cohortId, g1, g2, g3, t1, settlementId: settled.receipt.settlementId }
}

beforeAll(async () => {
  await assertTestDatabaseReachable()
  owner = await createIsolatedDatabase({ label: 'gradingsnap', setup: migratedSchema })
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
  board = new PgGradingQuery(() => app)
  book = new PgGradebookQuery(() => app)
  results = new PgGradingResultsCommand(deps)
  settlement = new PgGradingSettlementCommand({ audit: deps.audit, ledger: deps.ledger, businessClock, pool: () => app })
  const counting: Pick<Pool, 'query'> = {
    query: ((...args: Parameters<Pool['query']>) => {
      statements += 1
      return (app.query as (...a: unknown[]) => unknown)(...args)
    }) as Pool['query'],
  }
  snapshot = new PgGradingSnapshotQuery(() => counting)
})

afterAll(async () => {
  await app?.end()
  await owner?.close()
})

describe('屆別評分快照與原 port 內容相同（AC-A-14）', () => {
  it('board＝adminBoard、gradebook＝gradebook（含暫存、停用老師、待復核、解散的組）；現行結算帶階段名稱', async () => {
    const s = await richCohort()
    const got = await snap(s.cohortId)
    const b = await board.adminBoard(adminActor(), s.cohortId)
    const g = await book.gradebook(adminActor(), s.cohortId)
    if (!b.ok || !g.ok) throw new Error('原 port 讀不到')
    expect(got.board).toEqual(content(b.receipt))
    expect(got.gradebook).toEqual(content(g.receipt))

    // 這份資料真的涵蓋了這些狀態（不是兩邊都空的相等）。
    expect(got.board.groups.map((x) => x.code)).toEqual(['G01', 'G02'])
    expect(got.board.assignments.some((x) => x.state === 'draft')).toBe(true)
    expect(got.board.assignments.some((x) => x.teacherInactive)).toBe(true)
    expect(got.gradebook.groups.map((x) => [x.code, x.dissolved])).toEqual([
      ['G01', false],
      ['G02', false],
      ['G03', true],
    ])
    expect(got.gradebook.pendingReviews.map((p) => p.groupCode)).toEqual(['G01'])
    expect(got.settlements).toEqual([
      expect.objectContaining({ settlementId: s.settlementId, cohortId: s.cohortId, stageKey: 'mid', stageName: '期中', reason: '期中成績送教務處' }),
    ])
    expect(got.settlements[0]!.settledBy).toEqual({ userId: adminId, name: '系辦' })
    expect(got.loadedAt).toBeInstanceOf(Date)
  })

  it('還沒有評分規則的屆別：current／version 是 null、沒有結算，仍與原 port 相同', async () => {
    const cohortId = await newCohort()
    await newGroup(cohortId, 'H01')
    const got = await snap(cohortId)
    const b = await board.adminBoard(adminActor(), cohortId)
    const g = await book.gradebook(adminActor(), cohortId)
    if (!b.ok || !g.ok) throw new Error('原 port 讀不到')
    expect(got.board).toEqual(content(b.receipt))
    expect(got.gradebook).toEqual(content(g.receipt))
    expect([got.board.current, got.gradebook.version, got.settlements]).toEqual([null, null, []])
  })
})

describe('句數固定（AC-A-15：沒有 N+1）', () => {
  it('組數從 1 變 6、指派與評分跟著變多，查詢句數不變', async () => {
    const cohortId = await newCohort()
    await scheme(cohortId)
    const t = await newUser('戊老師', 'teacher')
    const first = await newGroup(cohortId, 'K01', [await newUser('子生', 'student')])
    await requirement(first, 'mid', 1)
    await submit(t, await assign(first, t), '80')
    const one = await countStatements(cohortId)

    for (let i = 2; i <= 6; i += 1) {
      const gid = await newGroup(cohortId, `K0${i}`, [await newUser(`生${i}`, 'student')])
      await requirement(gid, 'mid', 1)
      await submit(t, await assign(gid, t), '70')
    }
    const six = await countStatements(cohortId)
    expect(six).toBe(one)
    // 屆別 1＋六句並行（方案＋版本、組別、份數、指派、老師、結算）＋ loadFacts 3＋組員、更正、最新評分（沒有解散的組不查釘住版本）。
    expect(one).toBe(13)
  })

  it('有解散的組才多查一句釘住版本', async () => {
    const s = await richCohort()
    expect(await countStatements(s.cohortId)).toBe(14)
  })
})

describe('權限與找不到', () => {
  it('老師、學生 → FORBIDDEN「只有系辦可以看評分管理。」，不查資料', async () => {
    const cohortId = await newCohort()
    const t = await newUser('己老師', 'teacher')
    for (const who of [teacher(t), actor(t, ['student'])]) {
      statements = 0
      expect(await snapshot.cohortSnapshot(who, cohortId)).toMatchObject({ ok: false, code: 'FORBIDDEN', message: '只有系辦可以看評分管理。' })
      expect(statements).toBe(0)
    }
  })

  it('屆別不存在或 id 格式不對 → VALIDATION_FAILED「找不到這個屆別」', async () => {
    for (const id of [randomUUID(), 'not-a-uuid']) {
      expect(await snapshot.cohortSnapshot(adminActor(), id)).toMatchObject({
        ok: false,
        code: 'VALIDATION_FAILED',
        message: '找不到這個屆別，請重新整理頁面。',
      })
    }
  })
})
