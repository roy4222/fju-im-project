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
import { taipeiDateOf } from '@/shared/time'
import { PgEventPublisher } from '@/infrastructure/notifications/pg-event-publisher'
import { PgNotificationProjector } from '@/infrastructure/notifications/pg-projector'
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
  startDate: '2026-12-20',
  endDate: '',
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
    expect(result).toMatchObject({ ok: true, receipt: { code: cohort.code, name: `${cohort.code} 測試屆`, changedStages: [1, 2, 3, 4] } })

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

  it('一句話說明（票 39，0011）：存得進、讀得回；只改說明不換期限版本', async () => {
    const cohort = await newCohort()
    const described = {
      ...SCHEDULE,
      stages: SCHEDULE.stages.map((s, i) => (i === 0 ? { ...s, description: '五人一組報名，各自確認後成立。' } : s)),
    }
    await timeline.saveSchedule(actor(adminId), cohort.id, described, cohort.revision, randomUUID())
    const first = await timelineQuery.schedule(cohort.id)
    expect(first.stages.map((s) => s.description)).toEqual(['五人一組報名，各自確認後成立。', '', '', ''])

    const edited = { ...SCHEDULE, stages: SCHEDULE.stages.map((s, i) => (i === 1 ? { ...s, description: '期中報告與簡報。' } : s)) }
    const result = await timeline.saveSchedule(actor(adminId), cohort.id, edited, await revisionOf(cohort.id), randomUUID())
    expect(result).toMatchObject({ ok: true, receipt: { changedStages: [] } })
    const second = await timelineQuery.schedule(cohort.id)
    expect(second.stages.map((s) => [s.description, s.deadlineVersion])).toEqual([
      ['', 1],
      ['期中報告與簡報。', 1],
      ['', 1],
      ['', 1],
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
    // 訊息用「名稱（代碼）」指屆別，不只寫代碼（驗收第 2 章殘留）。
    expect(result.ok ? '' : result.message).toContain(`${cohort.code} 測試屆（${cohort.code}）已封存`)
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
    expect(got).toEqual({ cohortId: cohort.id, cohortCode: cohort.code, cohortName: `${cohort.code} 測試屆`, schedule: { stages: [], yearEndDate: null } })
  })
})

describe('屆別轉進行中', () => {
  it('還沒設階段：VALIDATION_FAILED，狀態不變、沒有狀態紀錄', async () => {
    const cohort = await newCohort()
    const result = await cohorts.activate(actor(adminId), cohort.id, randomUUID())
    expect(result).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    if (!result.ok) expect(result.message).toContain('時間軸')
    if (!result.ok) expect(result.message).toContain(`${cohort.code} 測試屆（${cohort.code}）`)
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

    const moved = await timeline.updateActivity(actor(adminId), id, { ...ACTIVITY, startDate: '2026-12-22' }, 1, randomUUID())
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
    // AC-C3-48(a)：非全天跨日沒填結束時間被擋，不留資料。
    const crossDay = await timeline.createActivity(
      actor(adminId),
      cohort.id,
      { ...ACTIVITY, startDate: '2027-04-01', endDate: '2027-04-02', startTime: '09:00', endTime: '' },
      randomUUID(),
    )
    expect(crossDay).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    expect(crossDay.ok ? '' : crossDay.message).toContain('跨日的活動要填結束時間')
    expect(await count('select count(*) as n from project_events where cohort_id = $1', [cohort.id])).toBe(0)
  })
})

describe('獨立活動：拖拉改起訖日 moveActivity（③ §9.1、AC-C3-48）', () => {
  const INTERVIEW: ActivityInput = { ...ACTIVITY, title: '面談', startDate: '2027-04-01', startTime: '09:00', endTime: '' }

  async function interview(cohortId: string): Promise<string> {
    const created = await timeline.createActivity(actor(adminId), cohortId, INTERVIEW, randomUUID())
    if (!created.ok) throw new Error(created.message)
    return created.receipt.activityId
  }

  async function rowOf(id: string) {
    return (await owner.sql('select starts_at, ends_at, revision from project_events where id = $1', [id])).rows[0] as {
      starts_at: Date
      ends_at: Date | null
      revision: number
    }
  }

  it('(c) 沒寫結束時間的拉成跨日：VALIDATION_FAILED「跨日的活動要填結束時間」，資料與 revision 不變', async () => {
    const cohort = await newCohort()
    const id = await interview(cohort.id)
    const result = await timeline.moveActivity(actor(adminId), id, { startDate: '2027-04-01', endDate: '2027-04-02' }, 1, randomUUID())
    expect(result).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    expect(result.ok ? '' : result.message).toContain('跨日的活動要填結束時間')
    const row = await rowOf(id)
    expect(row.starts_at.toISOString()).toBe('2027-04-01T01:00:00.000Z')
    expect(row.ends_at).toBeNull()
    expect(row.revision).toBe(1)
  })

  it('(d) 整段平移到 4/3：09:00 照舊、ends_at 仍 NULL、revision +1、發 calendar.changed updated', async () => {
    const cohort = await newCohort()
    const id = await interview(cohort.id)
    const result = await timeline.moveActivity(actor(adminId), id, { startDate: '2027-04-03', endDate: '2027-04-03' }, 1, randomUUID())
    expect(result).toMatchObject({ ok: true, receipt: { action: 'updated', title: '面談' } })
    const row = await rowOf(id)
    expect(row.starts_at.toISOString()).toBe('2027-04-03T01:00:00.000Z')
    expect(row.ends_at).toBeNull()
    expect(row.revision).toBe(2)
    const outbox = await owner.sql(
      `select payload->>'action' as action from domain_events where type = 'calendar.changed' and source_id = $1 and source_version = 2`,
      [id],
    )
    expect(outbox.rows).toEqual([{ action: 'updated' }])
  })

  it('全天活動拉成跨日：ends_at＝結束日次日 00:00；舊版本號 CONFLICT；老師 FORBIDDEN', async () => {
    const cohort = await newCohort()
    const created = await timeline.createActivity(
      actor(adminId),
      cohort.id,
      { ...ACTIVITY, title: '期中展', allDay: true, startDate: '2027-03-10', startTime: '', endTime: '' },
      randomUUID(),
    )
    if (!created.ok) throw new Error(created.message)
    const id = created.receipt.activityId
    expect(
      await timeline.moveActivity(actor(teacherId, ['teacher']), id, { startDate: '2027-03-10', endDate: '2027-03-12' }, 1, randomUUID()),
    ).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(await timeline.moveActivity(actor(adminId), id, { startDate: '2027-03-10', endDate: '2027-03-12' }, 1, randomUUID())).toMatchObject({
      ok: true,
    })
    const row = await rowOf(id)
    expect(row.ends_at?.toISOString()).toBe('2027-03-12T16:00:00.000Z')
    expect(await timeline.moveActivity(actor(adminId), id, { startDate: '2027-03-11', endDate: '2027-03-11' }, 1, randomUUID())).toMatchObject({
      ok: false,
      code: 'CONFLICT',
    })
  })
})

describe('獨立活動：刪除（第三波 W11；③ 起排定中也能直接刪）', () => {
  async function cancelledActivity(cohortId: string, input: ActivityInput = ACTIVITY): Promise<string> {
    const created = await timeline.createActivity(actor(adminId), cohortId, input, randomUUID())
    if (!created.ok) throw new Error(created.message)
    const cancelled = await timeline.cancelActivity(actor(adminId), created.receipt.activityId, 1, randomUUID())
    if (!cancelled.ok) throw new Error(cancelled.message)
    return created.receipt.activityId
  }

  it('AC-C3-37：排定中的活動直接刪：status 仍 scheduled、打刪除標記、稽核 activity.deleted、calendar.changed deleted', async () => {
    const cohort = await newCohort()
    const created = await timeline.createActivity(actor(adminId), cohort.id, ACTIVITY, randomUUID())
    if (!created.ok) throw new Error(created.message)
    const id = created.receipt.activityId
    const result = await timeline.deleteActivity(actor(adminId), id, 1, randomUUID())
    expect(result).toMatchObject({ ok: true, receipt: { action: 'deleted', title: '期中發表會' } })
    expect(await timelineQuery.activities(cohort.id)).toEqual([])
    const row = await owner.sql('select status, deleted_at is not null as deleted, revision from project_events where id = $1', [id])
    expect(row.rows[0]).toEqual({ status: 'scheduled', deleted: true, revision: 2 })
    const audit = await owner.sql(`select payload->'before'->>'status' as status from audit_events where action = 'activity.deleted' and target_id = $1`, [id])
    expect(audit.rows).toEqual([{ status: 'scheduled' }])
    const outbox = await owner.sql(
      `select payload->>'action' as action from domain_events where type = 'calendar.changed' and source_id = $1 order by source_version`,
      [id],
    )
    expect(outbox.rows.map((r) => r.action)).toEqual(['created', 'deleted'])
  })

  it('已取消的可以刪：打刪除標記不刪列；查詢不再列出；同一筆交易留 activity.deleted 稽核與 calendar.changed', async () => {
    const cohort = await newCohort()
    const id = await cancelledActivity(cohort.id)
    const requestId = randomUUID()
    const result = await timeline.deleteActivity(actor(adminId), id, 2, requestId)
    expect(result).toMatchObject({ ok: true, receipt: { action: 'deleted', title: '期中發表會' } })

    expect(await timelineQuery.activities(cohort.id)).toEqual([])
    const row = await owner.sql('select status, deleted_at, deleted_by_user_id, revision from project_events where id = $1', [id])
    expect(row.rows[0]).toMatchObject({ status: 'cancelled', deleted_by_user_id: adminId, revision: 3 })
    expect(row.rows[0]!.deleted_at).toBeInstanceOf(Date)

    const audit = await owner.sql(`select payload->'before' as before from audit_events where action = 'activity.deleted' and target_id = $1`, [
      id,
    ])
    expect(audit.rows).toHaveLength(1)
    expect(audit.rows[0]!.before).toMatchObject({ title: '期中發表會', status: 'cancelled', cohortId: cohort.id })
    const outbox = await owner.sql(
      `select payload->>'action' as action from domain_events where type = 'calendar.changed' and source_id = $1 and source_version = 3`,
      [id],
    )
    expect(outbox.rows).toEqual([{ action: 'deleted' }])

    // 同一個請求編號重送：回第一次的回執，不重做。
    expect(await timeline.deleteActivity(actor(adminId), id, 2, requestId)).toMatchObject({ ok: true, receipt: { action: 'deleted' } })
    expect(await count(`select count(*) as n from audit_events where action = 'activity.deleted' and target_id = $1`, [id])).toBe(1)
  })

  it('刪除後當作不存在：不能再刪、改期或取消', async () => {
    const cohort = await newCohort()
    const id = await cancelledActivity(cohort.id)
    await timeline.deleteActivity(actor(adminId), id, 2, randomUUID())
    for (const result of [
      await timeline.deleteActivity(actor(adminId), id, 3, randomUUID()),
      await timeline.updateActivity(actor(adminId), id, ACTIVITY, 3, randomUUID()),
      await timeline.cancelActivity(actor(adminId), id, 3, randomUUID()),
    ]) {
      expect(result).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
      expect(result.ok ? '' : result.message).toContain('找不到這個活動')
    }
  })

  it('老師直接呼叫：FORBIDDEN；版本過期：CONFLICT；都不留刪除標記', async () => {
    const cohort = await newCohort()
    const id = await cancelledActivity(cohort.id)
    expect(await timeline.deleteActivity(actor(teacherId, ['teacher']), id, 2, randomUUID())).toMatchObject({
      ok: false,
      code: 'FORBIDDEN',
    })
    expect(await timeline.deleteActivity(actor(adminId), id, 1, randomUUID())).toMatchObject({ ok: false, code: 'CONFLICT' })
    expect(await count('select count(*) as n from project_events where id = $1 and deleted_at is not null', [id])).toBe(0)
  })
})

describe('首頁近期活動：跨屆別的公開活動（設計方案 D-4）', () => {
  it('只列對象公開、已排定、還沒結束的；跨屆依開始時間；全天活動當天整天都算；取消後消失', async () => {
    const a = await newCohort('PA')
    const b = await newCohort('PB')
    const today = taipeiDateOf(new Date())
    const create = async (cohortId: string, input: Partial<ActivityInput>) => {
      const created = await timeline.createActivity(actor(adminId), cohortId, { ...ACTIVITY, audience: 'public', ...input }, randomUUID())
      if (!created.ok) throw new Error(created.message)
      return created.receipt.activityId
    }
    const later = await create(a.id, { title: 'A 屆成果發表會', startDate: '2099-05-20' })
    const sooner = await create(b.id, { title: 'B 屆說明會', startDate: '2099-03-01', startTime: '10:00', endTime: '' })
    const allDayToday = await create(b.id, { title: '今天的全天活動', startDate: today, allDay: true, startTime: '', endTime: '' })
    await create(a.id, { title: '已經結束', startDate: '2020-01-01' })
    await create(a.id, { title: '過去只有開始時間', startDate: '2020-01-01', endTime: '' })
    await create(a.id, { title: '過去的全天活動', startDate: '2020-01-01', allDay: true, startTime: '', endTime: '' })
    await create(a.id, { title: '只給登入者', startDate: '2099-01-01', audience: 'signed_in' })
    await create(b.id, { title: '本屆學生', startDate: '2099-01-01', audience: 'cohort_students' })

    expect((await timelineQuery.publicActivities(10)).map((x) => x.id)).toEqual([allDayToday, sooner, later])
    expect((await timelineQuery.publicActivities(2)).map((x) => x.title)).toEqual(['今天的全天活動', 'B 屆說明會'])

    await timeline.cancelActivity(actor(adminId), sooner, 1, randomUUID())
    expect((await timelineQuery.publicActivities(10)).map((x) => x.id)).toEqual([allDayToday, later])
  })
})

/**
 * C3-13（③ §9.2、AC-C3-38、39、47）：階段日期改了，同一筆交易發 `timeline.stage_changed`。
 * 收件＝截止落在變動段裡的整組作業 → 有效整組名單 → 現任組員（去重）。作業與名單只用 §14.3 契約欄位直接種：
 * `managed_items`（placement、status、deleted_at、due_at、receiver_unit）與 `response_rosters`（receiver_kind、receiver_id、
 * eligible_to_business_at、exempt）。
 */
describe('階段變動通知 timeline.stage_changed（C3-13）', () => {
  // AC-C3-38：10/1、11/19、3/1、5/1，年度結束 6/30。
  const AC38: ScheduleInput = {
    stages: [
      { name: '分組', startDate: '2026-10-01' },
      { name: '題目與計畫書', startDate: '2026-11-19' },
      { name: '系統開發', startDate: '2027-03-01' },
      { name: '成果', startDate: '2027-05-01' },
    ],
    yearEndDate: '2027-06-30',
  }
  /** 第 1／2 段分界往左 7 天（11/19 → 11/12）。 */
  const DRAGGED: ScheduleInput = { ...AC38, stages: AC38.stages.map((s, i) => (i === 1 ? { ...s, startDate: '2026-11-12' } : s)) }
  const RENAMED: ScheduleInput = { ...AC38, stages: AC38.stages.map((s, i) => (i === 1 ? { ...s, name: '題目' } : s)) }

  let n = 0
  async function student(cohortId: string): Promise<string> {
    n += 1
    const user = await owner.sql(
      `insert into users (id, name, email, email_verified, updated_at, status)
       values (gen_random_uuid(), $1, $2, true, now(), 'active') returning id`,
      [`學生${n}`, `s${n}-c313@example.com`],
    )
    const id = String(user.rows[0]!.id)
    const studentNo = `41300${String(n).padStart(4, '0')}`
    await owner.sql(
      `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at)
       values (gen_random_uuid(), $1, 'student', $2, now())`,
      [id, adminId],
    )
    await owner.sql(
      `insert into user_profiles (user_id, display_name, name_normalized, student_no, cohort_id, contact_email)
       values ($1, $2, $2, $3, $4, $5)`,
      [id, `學生${n}`, studentNo, cohortId, `s${n}-c313@contact.example.com`],
    )
    await owner.sql('insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)', [cohortId, studentNo, id])
    return id
  }

  async function group(cohortId: string, code: string, size = 2): Promise<{ id: string; members: string[] }> {
    const g = await owner.sql(
      `insert into groups (id, cohort_id, code, group_type, established_real_at, established_business_at, created_by_kind)
       values (gen_random_uuid(), $1, $2, 'general', now(), now(), 'system') returning id`,
      [cohortId, code],
    )
    const id = String(g.rows[0]!.id)
    const members: string[] = []
    for (let i = 0; i < size; i += 1) {
      const m = await student(cohortId)
      await owner.sql(
        `insert into group_memberships (id, group_id, cohort_id, user_id, valid_from, added_by_kind)
         values (gen_random_uuid(), $1, $2, $3, now(), 'system')`,
        [id, cohortId, m],
      )
      members.push(m)
    }
    return { id, members: members.sort() }
  }

  /** 已發布、有截止的收件；`roster` 是有效名單（整組作業放組 id、個人作業放學生 id）。 */
  async function item(cohortId: string, receiverUnit: 'group' | 'individual', dueAt: string, roster: string[]): Promise<string> {
    const created = await owner.sql(
      `insert into managed_items
         (id, cohort_id, placement, audience_kind, receiver_unit, status, actual_opened_at, due_at, title, summary, body_html,
          draft_schema, created_by_kind)
       values (gen_random_uuid(), $1, 'submission', 'cohort_students', $2, 'draft', '2026-09-20T00:00:00+08:00', $3, '作業', '', '<p>請交。</p>',
               '{"fields":[]}'::jsonb, 'system')
       returning id`,
      [cohortId, receiverUnit, dueAt],
    )
    const id = String(created.rows[0]!.id)
    const content = await owner.sql(
      `insert into item_versions (id, item_id, version_no, title, summary, body_html, created_by_user_id)
       values (gen_random_uuid(), $1, 1, '作業', '', '<p>請交。</p>', $2) returning id`,
      [id, adminId],
    )
    const schema = await owner.sql(
      `insert into form_schema_versions (id, item_id, version_no, schema, created_by_user_id)
       values (gen_random_uuid(), $1, 1, '{"fields":[]}'::jsonb, $2) returning id`,
      [id, adminId],
    )
    await owner.sql(`update managed_items set status = 'published', current_content_version_id = $2, current_schema_version_id = $3 where id = $1`, [
      id,
      content.rows[0]!.id,
      schema.rows[0]!.id,
    ])
    for (const receiver of roster) {
      await owner.sql(
        `insert into response_rosters (id, item_id, cohort_id, receiver_kind, receiver_id, eligible_from_business_at, source, created_by_kind)
         values (gen_random_uuid(), $1, $2, $3, $4, '2026-09-20T00:00:00+08:00', 'auto', 'system')`,
        [id, cohortId, receiverUnit === 'group' ? 'group' : 'user', receiver],
      )
    }
    return id
  }

  async function scheduled(): Promise<{ id: string }> {
    const cohort = await newCohort('SC')
    const saved = await timeline.saveSchedule(actor(adminId), cohort.id, AC38, cohort.revision, randomUUID())
    if (!saved.ok) throw new Error(saved.message)
    return cohort
  }

  async function stageEvents(cohortId: string) {
    return (
      await owner.sql(
        `select id, source_type, source_id, recipients, recipient_basis, payload from domain_events
          where type = 'timeline.stage_changed' and cohort_id = $1`,
        [cohortId],
      )
    ).rows
  }

  async function notified(userIds: string[]): Promise<Record<string, number>> {
    const rows = await owner.sql(
      `select u, (select count(*) from notifications n where n.recipient_user_id = u and n.kind = 'due' and n.source_ref->>'type' = 'timeline')::int as n
         from unnest($1::uuid[]) as u`,
      [userIds],
    )
    return Object.fromEntries(rows.rows.map((r) => [String(r.u), Number(r.n)]))
  }

  const projector = () => new PgNotificationProjector({ pool: () => app, events: new PgEventPublisher(), businessClock, log: () => undefined })

  it('AC-C3-38／39：有整組作業的組收到（G01 每人一則、連到 /timeline）；沒作業的組、未分組、老師都沒有；期限版本與 revision 照舊', async () => {
    const cohort = await scheduled()
    const g01 = await group(cohort.id, 'G01', 3)
    const g02 = await group(cohort.id, 'G02', 2)
    const x = await student(cohort.id)
    const itemId = await item(cohort.id, 'group', '2026-12-01T23:59:00+08:00', [g01.id])
    const revision = await revisionOf(cohort.id)

    const result = await timeline.saveSchedule(actor(adminId), cohort.id, DRAGGED, revision, randomUUID())
    expect(result).toMatchObject({ ok: true, receipt: { changedStages: [1, 2] } })
    expect(await revisionOf(cohort.id)).toBe(revision + 1)
    expect((await timelineQuery.schedule(cohort.id)).stages.map((s) => s.deadlineVersion)).toEqual([2, 2, 1, 1])
    expect(await count(`select count(*) as n from audit_events where action = 'cohort.save_schedule' and target_id = $1`, [cohort.id])).toBe(2)

    const events = await stageEvents(cohort.id)
    expect(events).toHaveLength(1)
    const event = events[0]!
    expect(event).toMatchObject({
      source_type: 'timeline',
      source_id: cohort.id,
      recipient_basis: { groupIds: [g01.id], itemIds: [itemId] },
      payload: { title: '專題時程更新：第 2 階段『題目與計畫書』改為 11/12–2/28', changedStages: [1, 2] },
    })
    expect([...(event.recipients as string[])].sort()).toEqual(g01.members)
    expect((await owner.sql('select consumer from event_projections where event_id = $1', [event.id])).rows).toEqual([{ consumer: 'notifications' }])

    await projector().runOnce()
    const counts = await notified([...g01.members, ...g02.members, x, teacherId])
    expect(counts).toEqual(Object.fromEntries([...g01.members.map((m) => [m, 1]), ...g02.members.map((m) => [m, 0]), [x, 0], [teacherId, 0]]))
    const note = await owner.sql(`select title, source_ref from notifications where event_id = $1 and recipient_user_id = $2`, [event.id, g01.members[0]])
    expect(note.rows[0]).toMatchObject({
      title: '專題時程更新：第 2 階段『題目與計畫書』改為 11/12–2/28',
      source_ref: { type: 'timeline', id: cohort.id },
    })
  })

  it('沒作業的組沒有：屆別有組但沒有整組作業 → 不發事件', async () => {
    const cohort = await scheduled()
    await group(cohort.id, 'G01')
    const result = await timeline.saveSchedule(actor(adminId), cohort.id, DRAGGED, await revisionOf(cohort.id), randomUUID())
    expect(result).toMatchObject({ ok: true, receipt: { changedStages: [1, 2] } })
    expect(await stageEvents(cohort.id)).toEqual([])
  })

  it('個人作業不發：只有 receiver_unit=individual 的作業（名單含組員）→ 不發事件', async () => {
    const cohort = await scheduled()
    const g01 = await group(cohort.id, 'G01')
    await item(cohort.id, 'individual', '2026-12-01T23:59:00+08:00', g01.members)
    await timeline.saveSchedule(actor(adminId), cohort.id, DRAGGED, await revisionOf(cohort.id), randomUUID())
    expect(await stageEvents(cohort.id)).toEqual([])
  })

  it('AC-C3-47 只指定 G03 的作業不發給 G01：個人作業、別組的整組作業都不算；免填、已移出的組不算；段外的截止不算', async () => {
    const cohort = await scheduled()
    const g01 = await group(cohort.id, 'G01')
    const g02 = await group(cohort.id, 'G02')
    const g03 = await group(cohort.id, 'G03')
    const g04 = await group(cohort.id, 'G04')
    const g05 = await group(cohort.id, 'G05')
    await item(cohort.id, 'individual', '2026-12-05T23:59:00+08:00', [...g01.members, ...g02.members])
    const g03Item = await item(cohort.id, 'group', '2026-12-10T23:59:00+08:00', [g03.id, g04.id, g05.id])
    await owner.sql(`update response_rosters set exempt = true where item_id = $1 and receiver_id = $2`, [g03Item, g04.id])
    await owner.sql(
      `update response_rosters set eligible_to_business_at = now(), removed_reason = '測試' where item_id = $1 and receiver_id = $2`,
      [g03Item, g05.id],
    )
    // 第 3 段（沒變）裡的整組作業：G01 不會因它收到。
    await item(cohort.id, 'group', '2027-03-15T23:59:00+08:00', [g01.id])

    await timeline.saveSchedule(actor(adminId), cohort.id, DRAGGED, await revisionOf(cohort.id), randomUUID())
    const events = await stageEvents(cohort.id)
    expect(events).toHaveLength(1)
    expect([...(events[0]!.recipients as string[])].sort()).toEqual(g03.members)
    expect(events[0]!.recipient_basis).toMatchObject({ groupIds: [g03.id], itemIds: [g03Item] })

    await projector().runOnce()
    const counts = await notified([...g01.members, ...g02.members, ...g03.members, ...g04.members, ...g05.members])
    expect(Object.entries(counts).filter(([, c]) => c > 0).map(([u]) => u).sort()).toEqual(g03.members)
  })

  it('只改名稱不發：changedStages 空、沒有事件', async () => {
    const cohort = await scheduled()
    const g01 = await group(cohort.id, 'G01')
    await item(cohort.id, 'group', '2026-12-01T23:59:00+08:00', [g01.id])
    const result = await timeline.saveSchedule(actor(adminId), cohort.id, RENAMED, await revisionOf(cohort.id), randomUUID())
    expect(result).toMatchObject({ ok: true, receipt: { changedStages: [] } })
    expect(await stageEvents(cohort.id)).toEqual([])
  })

  it('預覽 previewSchedule：確認框句子含「有 N 個整組作業」、不寫入；版本過期 CONFLICT；老師 FORBIDDEN', async () => {
    const cohort = await scheduled()
    const g01 = await group(cohort.id, 'G01')
    await item(cohort.id, 'group', '2026-12-01T23:59:00+08:00', [g01.id])
    await item(cohort.id, 'group', '2026-12-02T23:59:00+08:00', []) // 還沒有收件組的整組作業也算一個
    const revision = await revisionOf(cohort.id)
    const before = await timelineQuery.schedule(cohort.id)

    expect(await timeline.previewSchedule(actor(adminId), cohort.id, DRAGGED, revision)).toEqual({
      ok: true,
      preview: {
        changedStages: [1, 2],
        groupItemCount: 2,
        message: '第 2 階段『題目與計畫書』開始日 11/19 → 11/12（第 1 階段跟著變短）。有 2 個整組作業在這兩段裡，會重新提醒相關的組。',
      },
    })
    expect(await timeline.previewSchedule(actor(adminId), cohort.id, RENAMED, revision)).toEqual({
      ok: true,
      preview: { changedStages: [], groupItemCount: 0, message: '' },
    })
    expect(await timelineQuery.schedule(cohort.id)).toEqual(before)
    expect(await revisionOf(cohort.id)).toBe(revision)
    expect(await stageEvents(cohort.id)).toEqual([])
    expect(await timeline.previewSchedule(actor(adminId), cohort.id, DRAGGED, revision - 1)).toMatchObject({ ok: false, code: 'CONFLICT' })
    expect(await timeline.previewSchedule(actor(teacherId, ['teacher']), cohort.id, DRAGGED, revision)).toMatchObject({
      ok: false,
      code: 'FORBIDDEN',
    })
  })
})
