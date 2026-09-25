import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import {
  assertTestDatabaseReachable,
  createIsolatedDatabase,
  poolAsRole,
  type IsolatedDatabase,
} from '../../../test/db'
import { migratedSchema } from '../../../test/migrations'
import type { ResolvedActor } from '@/application/accounts'
import { describeStagePosition, type ActivityInput, type ScheduleInput } from '@/application/cohorts'
import { PgCohortCommand, PgCohortStatusQuery } from '@/infrastructure/cohorts/pg-cohorts'
import { PgTimelineCommand, PgTimelineQuery } from '@/infrastructure/cohorts/pg-timeline'
import { PgEventPublisher } from '@/infrastructure/notifications/pg-event-publisher'
import { PgAuditWriter } from '@/infrastructure/ops/audit-writer'
import { PgOperationLedger } from '@/infrastructure/ops/operation-ledger'

/**
 * 票 11：階段、年度結束日、活動、屆別轉進行中（模組實作設計 02 §3、§5、§6；COH-01–04）。
 *
 * 以正式執行角色 `fju_app` 連線。業務鐘在這裡是可以撥的假鐘：
 * 要證明「今天第幾階段」看的是注入的業務鐘，不是 `new Date()`。
 */

let owner: IsolatedDatabase
let app: Pool
let adminId: string
let teacherId: string
let businessNow = new Date('2026-09-01T00:00:00Z')
const businessClock = { now: async () => new Date(businessNow.getTime()) }

let cohorts: PgCohortCommand
let cohortQuery: PgCohortStatusQuery
let timeline: PgTimelineCommand
let timelineQuery: PgTimelineQuery

function actor(userId: string, roles: ('admin' | 'teacher' | 'student')[] = ['admin']): ResolvedActor {
  return { kind: 'authenticated', userId, roles, status: 'active', mustChangePassword: false, cohortMemberships: [] }
}

const SCHEDULE: ScheduleInput = {
  stages: [
    { name: '成組期', startDate: '2026-09-15' },
    { name: '期中', startDate: '2026-11-01' },
    { name: '期末', startDate: '2027-01-10' },
    { name: '成果', startDate: '2027-03-01' },
  ],
  yearEndDate: '2027-06-30',
}

const ACTIVITY: ActivityInput = {
  title: '期中發表會',
  description: '',
  date: '2026-12-20',
  allDay: false,
  startTime: '14:00',
  endTime: '16:00',
  audience: 'cohort_students',
}

let seq = 0
async function newCohort(prefix = 'TL'): Promise<{ id: string; code: string; revision: number }> {
  const code = `${prefix}-${(seq += 1)}`
  const created = await cohorts.create(actor(adminId), { code, name: `${code} 測試屆` }, randomUUID())
  if (!created.ok) throw new Error(created.message)
  const cohort = await cohortQuery.get(created.receipt.cohortId)
  return { id: cohort!.id, code, revision: cohort!.revision }
}

async function revisionOf(cohortId: string): Promise<number> {
  return (await cohortQuery.get(cohortId))!.revision
}

async function count(sql: string, values: unknown[] = []): Promise<number> {
  return Number((await owner.sql(sql, values)).rows[0]!.n)
}

beforeAll(async () => {
  await assertTestDatabaseReachable()
  owner = await createIsolatedDatabase({ label: 'timeline', setup: migratedSchema })
  app = await poolAsRole(owner, 'fju_app')

  const deps = {
    audit: new PgAuditWriter(),
    ledger: new PgOperationLedger(() => app),
    events: new PgEventPublisher(),
    businessClock,
    pool: () => app,
  }
  cohorts = new PgCohortCommand(deps)
  cohortQuery = new PgCohortStatusQuery(() => app)
  timeline = new PgTimelineCommand(deps)
  timelineQuery = new PgTimelineQuery(() => app)

  const users = await owner.sql(
    `insert into users (id, name, email, email_verified, updated_at, status)
     values (gen_random_uuid(), 'A1', 'a1-timeline@example.com', false, now(), 'active'),
            (gen_random_uuid(), 'T1', 't1-timeline@example.com', false, now(), 'active')
     returning id, name`,
  )
  adminId = String(users.rows.find((r) => r.name === 'A1')!.id)
  teacherId = String(users.rows.find((r) => r.name === 'T1')!.id)
})

afterAll(async () => {
  await app?.end()
  await owner?.close()
})

describe('階段與年度結束日', () => {
  it('存四段開始日與年度結束日；重新讀回來一樣；留稽核與帳本', async () => {
    const cohort = await newCohort()
    const requestId = randomUUID()
    const result = await timeline.saveSchedule(actor(adminId), cohort.id, SCHEDULE, cohort.revision, requestId)
    expect(result).toMatchObject({ ok: true, receipt: { changedStages: [1, 2, 3, 4] } })

    const schedule = await timelineQuery.schedule(cohort.id)
    expect(schedule.yearEndDate).toBe('2027-06-30')
    expect(schedule.stages.map((s) => [s.seq, s.name, s.startDate, s.deadlineVersion])).toEqual([
      [1, '成組期', '2026-09-15', 1],
      [2, '期中', '2026-11-01', 1],
      [3, '期末', '2027-01-10', 1],
      [4, '成果', '2027-03-01', 1],
    ])
    expect(await count(`select count(*) as n from audit_events where action = 'cohort.save_schedule' and target_id = $1`, [cohort.id])).toBe(1)
    expect(await count('select count(*) as n from operation_records where request_id = $1', [requestId])).toBe(1)
  })

  it('開始日不遞增：VALIDATION_FAILED，原本存的日期一個都沒變', async () => {
    const cohort = await newCohort()
    await timeline.saveSchedule(actor(adminId), cohort.id, SCHEDULE, cohort.revision, randomUUID())
    const before = await timelineQuery.schedule(cohort.id)

    const bad = {
      ...SCHEDULE,
      stages: SCHEDULE.stages.map((s, i) => (i === 2 ? { ...s, startDate: '2026-10-01' } : s)),
    }
    const result = await timeline.saveSchedule(actor(adminId), cohort.id, bad, await revisionOf(cohort.id), randomUUID())
    expect(result).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    expect(await timelineQuery.schedule(cohort.id)).toEqual(before)
  })

  it('改期：日期範圍有變的段換期限版本；兩段互換位置般的大改也不會撞唯一鍵', async () => {
    const cohort = await newCohort()
    await timeline.saveSchedule(actor(adminId), cohort.id, SCHEDULE, cohort.revision, randomUUID())

    // 第 1 段改到原本第 2 段的日期、第 2 段往後挪：逐列更新時會先撞 (cohort_id, start_date)。
    const shifted = {
      ...SCHEDULE,
      stages: [
        { name: '成組期', startDate: '2026-11-01' },
        { name: '期中', startDate: '2026-12-01' },
        SCHEDULE.stages[2]!,
        SCHEDULE.stages[3]!,
      ],
    }
    const result = await timeline.saveSchedule(actor(adminId), cohort.id, shifted, await revisionOf(cohort.id), randomUUID())
    expect(result).toMatchObject({ ok: true, receipt: { changedStages: [1, 2] } })
    const schedule = await timelineQuery.schedule(cohort.id)
    expect(schedule.stages.map((s) => [s.startDate, s.deadlineVersion])).toEqual([
      ['2026-11-01', 2],
      ['2026-12-01', 2],
      ['2027-01-10', 1],
      ['2027-03-01', 1],
    ])
  })

  it('畫面上的版本過期（別人先改過）：CONFLICT', async () => {
    const cohort = await newCohort()
    await timeline.saveSchedule(actor(adminId), cohort.id, SCHEDULE, cohort.revision, randomUUID())
    const stale = await timeline.saveSchedule(actor(adminId), cohort.id, SCHEDULE, cohort.revision, randomUUID())
    expect(stale).toMatchObject({ ok: false, code: 'CONFLICT' })
  })

  it('同一個請求編號重送：回第一次的回執，不重做', async () => {
    const cohort = await newCohort()
    const requestId = randomUUID()
    const first = await timeline.saveSchedule(actor(adminId), cohort.id, SCHEDULE, cohort.revision, requestId)
    const second = await timeline.saveSchedule(actor(adminId), cohort.id, SCHEDULE, cohort.revision, requestId)
    expect(second).toEqual(first)
    expect(await count(`select count(*) as n from audit_events where action = 'cohort.save_schedule' and target_id = $1`, [cohort.id])).toBe(1)
  })

  it('老師直接呼叫：FORBIDDEN，資料不動', async () => {
    const cohort = await newCohort()
    const result = await timeline.saveSchedule(actor(teacherId, ['teacher']), cohort.id, SCHEDULE, cohort.revision, randomUUID())
    expect(result).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(await count('select count(*) as n from cohort_stages where cohort_id = $1', [cohort.id])).toBe(0)
  })

  it('已封存的屆別：COHORT_ARCHIVED', async () => {
    const cohort = await newCohort()
    await owner.sql(`update cohorts set status = 'archived' where id = $1`, [cohort.id])
    const result = await timeline.saveSchedule(actor(adminId), cohort.id, SCHEDULE, cohort.revision, randomUUID())
    expect(result).toMatchObject({ ok: false, code: 'COHORT_ARCHIVED' })
  })
})

describe('現在第幾階段看注入的業務鐘', () => {
  it('業務鐘往前推，階段文字跟著變；日期過了不代表任何事做完', async () => {
    const cohort = await newCohort()
    await timeline.saveSchedule(actor(adminId), cohort.id, SCHEDULE, cohort.revision, randomUUID())
    const at = async (iso: string) => {
      businessNow = new Date(iso)
      return describeStagePosition(await timelineQuery.currentStage(cohort.id, await businessClock.now()))
    }
    expect(await at('2026-09-14T15:59:59Z')).toBe('尚未開始')
    expect(await at('2026-10-31T16:00:00Z')).toBe('階段 2：期中') // 臺灣 11/01 00:00
    expect(await at('2027-06-30T15:59:59Z')).toBe('階段 4：成果') // 年度結束日當天 23:59:59
    expect(await at('2027-06-30T16:00:00Z')).toBe('年度階段已結束')
  })

  it('兩個進行中的屆別並存，各看各的階段', async () => {
    const a = await newCohort('TWO-A')
    const b = await newCohort('TWO-B')
    await timeline.saveSchedule(actor(adminId), a.id, SCHEDULE, a.revision, randomUUID())
    const later = {
      ...SCHEDULE,
      stages: SCHEDULE.stages.map((s) => ({ ...s, startDate: `${Number(s.startDate.slice(0, 4)) + 1}${s.startDate.slice(4)}` })),
      yearEndDate: '2028-06-30',
    }
    await timeline.saveSchedule(actor(adminId), b.id, later, b.revision, randomUUID())
    expect((await cohorts.activate(actor(adminId), a.id, randomUUID())).ok).toBe(true)
    expect((await cohorts.activate(actor(adminId), b.id, randomUUID())).ok).toBe(true)

    const t = new Date('2026-12-01T04:00:00Z')
    expect(describeStagePosition(await timelineQuery.currentStage(a.id, t))).toBe('階段 2：期中')
    expect(describeStagePosition(await timelineQuery.currentStage(b.id, t))).toBe('尚未開始')
    expect((await cohortQuery.list()).filter((c) => [a.id, b.id].includes(c.id)).every((c) => c.status === 'active')).toBe(true)
  })
})

describe('學生專題時間軸：只讀得到自己那一屆（票 38）', () => {
  function student(cohortId: string | null, overrides: Partial<Extract<ResolvedActor, { kind: 'authenticated' }>> = {}): ResolvedActor {
    return {
      kind: 'authenticated',
      userId: randomUUID(),
      roles: ['student'],
      status: 'active',
      mustChangePassword: false,
      cohortMemberships: cohortId ? [{ cohortId, role: 'student' }] : [],
      ...overrides,
    }
  }

  it('兩屆各自設不同的階段：學生只拿到自己歸屬那一屆的代號與階段', async () => {
    const mine = await newCohort('STU-A')
    const other = await newCohort('STU-B')
    await timeline.saveSchedule(actor(adminId), mine.id, SCHEDULE, mine.revision, randomUUID())
    const otherSchedule = {
      stages: [
        { name: '別屆一', startDate: '2027-09-15' },
        { name: '別屆二', startDate: '2027-11-01' },
        { name: '別屆三', startDate: '2028-01-10' },
        { name: '別屆四', startDate: '2028-03-01' },
      ],
      yearEndDate: '2028-06-30',
    }
    const saved = await timeline.saveSchedule(actor(adminId), other.id, otherSchedule, other.revision, randomUUID())
    expect(saved.ok).toBe(true)

    const got = await timelineQuery.studentSchedule(student(mine.id))
    expect(got).not.toBeNull()
    expect(got!.cohortId).toBe(mine.id)
    expect(got!.cohortCode).toBe(mine.code)
    expect(got!.schedule).toEqual(await timelineQuery.schedule(mine.id))
    expect(got!.schedule.stages.map((s) => s.name)).toEqual(['成組期', '期中', '期末', '成果'])
    expect(JSON.stringify(got)).not.toContain('別屆')

    const theirs = await timelineQuery.studentSchedule(student(other.id))
    expect(theirs!.schedule.stages.map((s) => s.name)).toEqual(['別屆一', '別屆二', '別屆三', '別屆四'])
  })

  it('還沒歸屬屆別、不是學生、帳號不是啟用中、屆別不存在：一律 null，不退回任何一屆', async () => {
    const cohort = await newCohort('STU-C')
    await timeline.saveSchedule(actor(adminId), cohort.id, SCHEDULE, cohort.revision, randomUUID())
    // 預設工作屆別也不給沒有歸屬的學生（不像老師、管理員首頁會退回預設屆別）。
    await owner.sql('update cohorts set is_default_working = (id = $1)', [cohort.id])

    expect(await timelineQuery.studentSchedule(student(null))).toBeNull()
    expect(await timelineQuery.studentSchedule(student(cohort.id, { roles: ['teacher'] }))).toBeNull()
    expect(await timelineQuery.studentSchedule(student(cohort.id, { roles: ['admin'] }))).toBeNull()
    expect(await timelineQuery.studentSchedule(student(cohort.id, { status: 'pending' }))).toBeNull()
    expect(await timelineQuery.studentSchedule(student(cohort.id, { status: 'disabled' }))).toBeNull()
    expect(await timelineQuery.studentSchedule(student(randomUUID()))).toBeNull()
    expect(await timelineQuery.studentSchedule({ kind: 'anonymous' })).toBeNull()
    // 屆別成員關係的角色不是學生（例如之後的助教）：不算。
    expect(
      await timelineQuery.studentSchedule(student(null, { cohortMemberships: [{ cohortId: cohort.id, role: 'teacher' }] })),
    ).toBeNull()
  })

  it('屆別還沒設階段：回屆別、階段是空的（畫面顯示尚未設定）', async () => {
    const cohort = await newCohort('STU-D')
    const got = await timelineQuery.studentSchedule(student(cohort.id))
    expect(got).toEqual({ cohortId: cohort.id, cohortCode: cohort.code, schedule: { stages: [], yearEndDate: null } })
  })
})

describe('屆別轉進行中', () => {
  it('還沒設階段：VALIDATION_FAILED，狀態不變、沒有狀態紀錄', async () => {
    const cohort = await newCohort()
    const result = await cohorts.activate(actor(adminId), cohort.id, randomUUID())
    expect(result).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    if (!result.ok) expect(result.message).toContain('時間軸')
    expect((await cohortQuery.get(cohort.id))!.status).toBe('preparing')
    expect(await count(`select count(*) as n from cohort_status_events where cohort_id = $1 and to_status = 'active'`, [cohort.id])).toBe(0)
  })

  it('設好階段後轉進行中：同一筆交易留狀態紀錄、事件、稽核；業務時間取注入的鐘', async () => {
    const cohort = await newCohort()
    await timeline.saveSchedule(actor(adminId), cohort.id, SCHEDULE, cohort.revision, randomUUID())
    businessNow = new Date('2026-09-20T02:00:00Z')

    const result = await cohorts.activate(actor(adminId), cohort.id, randomUUID())
    expect(result).toMatchObject({ ok: true, receipt: { alreadyActive: false } })
    expect((await cohortQuery.get(cohort.id))!.status).toBe('active')

    const events = await owner.sql(
      `select from_status, to_status, actor_user_id, business_at from cohort_status_events
        where cohort_id = $1 order by real_at, id`,
      [cohort.id],
    )
    // 建立一筆（from NULL）＋轉進行中一筆。
    expect(events.rows.map((r) => [r.from_status, r.to_status])).toEqual([
      [null, 'preparing'],
      ['preparing', 'active'],
    ])
    expect((events.rows[1]!.business_at as Date).toISOString()).toBe('2026-09-20T02:00:00.000Z')
    expect(events.rows[1]!.actor_user_id).toBe(adminId)

    const outbox = await owner.sql(`select recipients from domain_events where type = 'cohort.activated' and source_id = $1`, [cohort.id])
    expect(outbox.rows).toEqual([{ recipients: [] }])
    expect(await count(`select count(*) as n from audit_events where action = 'cohort.activate' and target_id = $1`, [cohort.id])).toBe(1)
  })

  it('再按一次：成功但不多寫一筆狀態紀錄', async () => {
    const cohort = await newCohort()
    await timeline.saveSchedule(actor(adminId), cohort.id, SCHEDULE, cohort.revision, randomUUID())
    await cohorts.activate(actor(adminId), cohort.id, randomUUID())
    const again = await cohorts.activate(actor(adminId), cohort.id, randomUUID())
    expect(again).toMatchObject({ ok: true, receipt: { alreadyActive: true } })
    expect(await count(`select count(*) as n from cohort_status_events where cohort_id = $1 and to_status = 'active'`, [cohort.id])).toBe(1)
  })

  it('狀態紀錄不可變：fju_app 改不了', async () => {
    await expect(app.query(`update cohort_status_events set reason = 'x'`)).rejects.toThrow(/permission denied/i)
  })

  it('老師不能轉：FORBIDDEN', async () => {
    const cohort = await newCohort()
    await timeline.saveSchedule(actor(adminId), cohort.id, SCHEDULE, cohort.revision, randomUUID())
    expect(await cohorts.activate(actor(teacherId, ['teacher']), cohort.id, randomUUID())).toMatchObject({ ok: false, code: 'FORBIDDEN' })
  })
})

describe('獨立活動：建立、改期、取消', () => {
  it('三步各有回執；取消只標已取消、不刪；每一步都在同一筆交易發 calendar.changed', async () => {
    const cohort = await newCohort()
    const created = await timeline.createActivity(actor(adminId), cohort.id, ACTIVITY, randomUUID())
    expect(created).toMatchObject({ ok: true, receipt: { action: 'created', title: '期中發表會' } })
    if (!created.ok) return
    const id = created.receipt.activityId

    const moved = await timeline.updateActivity(actor(adminId), id, { ...ACTIVITY, date: '2026-12-22' }, 1, randomUUID())
    expect(moved).toMatchObject({ ok: true, receipt: { action: 'updated' } })

    const cancelled = await timeline.cancelActivity(actor(adminId), id, 2, randomUUID())
    expect(cancelled).toMatchObject({ ok: true, receipt: { action: 'cancelled' } })

    const [activity] = await timelineQuery.activities(cohort.id)
    expect(activity).toMatchObject({ id, status: 'cancelled', revision: 3 })
    expect(activity!.startsAt.toISOString()).toBe('2026-12-22T06:00:00.000Z')

    const outbox = await owner.sql(
      `select source_version, payload->>'action' as action from domain_events
        where type = 'calendar.changed' and source_id = $1 order by source_version`,
      [id],
    )
    expect(outbox.rows).toEqual([
      { source_version: 1, action: 'created' },
      { source_version: 2, action: 'updated' },
      { source_version: 3, action: 'cancelled' },
    ])
    expect(await count(`select count(*) as n from audit_events where target_id = $1`, [id])).toBe(3)
  })

  it('改期帶舊版本號：CONFLICT；已取消的不能再改期', async () => {
    const cohort = await newCohort()
    const created = await timeline.createActivity(actor(adminId), cohort.id, ACTIVITY, randomUUID())
    if (!created.ok) throw new Error(created.message)
    const id = created.receipt.activityId
    await timeline.updateActivity(actor(adminId), id, { ...ACTIVITY, title: '改名' }, 1, randomUUID())

    expect(await timeline.updateActivity(actor(adminId), id, ACTIVITY, 1, randomUUID())).toMatchObject({ ok: false, code: 'CONFLICT' })
    await timeline.cancelActivity(actor(adminId), id, 2, randomUUID())
    expect(await timeline.updateActivity(actor(adminId), id, ACTIVITY, 3, randomUUID())).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
    })
  })

  it('老師建立活動：FORBIDDEN；輸入不合規則：VALIDATION_FAILED；都不留資料', async () => {
    const cohort = await newCohort()
    expect(await timeline.createActivity(actor(teacherId, ['teacher']), cohort.id, ACTIVITY, randomUUID())).toMatchObject({
      ok: false,
      code: 'FORBIDDEN',
    })
    expect(await timeline.createActivity(actor(adminId), cohort.id, { ...ACTIVITY, endTime: '09:00' }, randomUUID())).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
    })
    expect(await count('select count(*) as n from project_events where cohort_id = $1', [cohort.id])).toBe(0)
  })
})
