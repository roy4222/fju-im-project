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
import type { ActivityInput } from '@/application/cohorts'
import { PgCohortCommand, PgCohortStatusQuery } from '@/infrastructure/cohorts/pg-cohorts'
import { PgTimelineCommand, PgTimelineQuery } from '@/infrastructure/cohorts/pg-timeline'
import { PgEventPublisher } from '@/infrastructure/notifications/pg-event-publisher'
import { PgAuditWriter } from '@/infrastructure/ops/audit-writer'
import { PgOperationLedger } from '@/infrastructure/ops/operation-ledger'

/**
 * TE-07b：`activitiesFor(cohortIds)` 一句查完多屆的活動（老師首頁「本屆活動」），結果要跟逐屆呼叫
 * `activities(id)` 合起來一樣（同樣的欄位、依開始時間排序、含已取消、不含已刪除）。
 * 以正式執行角色 `fju_app` 連線，並數送出的 SQL 句數。
 */

let owner: IsolatedDatabase
let app: Pool
let adminId: string
const businessClock = { now: async () => new Date('2026-09-01T00:00:00Z') }

let cohorts: PgCohortCommand
let cohortQuery: PgCohortStatusQuery
let timeline: PgTimelineCommand
let timelineQuery: PgTimelineQuery
let statements = 0

function admin(): ResolvedActor {
  return { kind: 'authenticated', userId: adminId, roles: ['admin'], status: 'active', mustChangePassword: false, cohortMemberships: [] }
}

const ACTIVITY: ActivityInput = {
  title: '活動',
  description: '',
  date: '2099-01-01',
  allDay: false,
  startTime: '14:00',
  endTime: '16:00',
  audience: 'cohort_students',
}

let seq = 0
async function newCohort(): Promise<string> {
  const code = `AF-${(seq += 1)}`
  const created = await cohorts.create(admin(), { code, name: `${code} 測試屆` }, randomUUID())
  if (!created.ok) throw new Error(created.message)
  return (await cohortQuery.get(created.receipt.cohortId))!.id
}

async function create(cohortId: string, input: Partial<ActivityInput>): Promise<string> {
  const created = await timeline.createActivity(admin(), cohortId, { ...ACTIVITY, ...input }, randomUUID())
  if (!created.ok) throw new Error(created.message)
  return created.receipt.activityId
}

/** 原本老師首頁的做法：逐屆查、攤平、依開始時間排。 */
async function perCohort(cohortIds: string[]) {
  const lists = await Promise.all(cohortIds.map((id) => timelineQuery.activities(id)))
  return lists.flat().sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
}

async function counted<T>(body: () => Promise<T>): Promise<{ value: T; statements: number }> {
  statements = 0
  const value = await body()
  return { value, statements }
}

beforeAll(async () => {
  await assertTestDatabaseReachable()
  owner = await createIsolatedDatabase({ label: 'timeline_for', setup: migratedSchema })
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
  const reader = { query: ((...args: Parameters<Pool['query']>) => ((statements += 1), app.query(...args))) as Pool['query'] }
  timelineQuery = new PgTimelineQuery(() => reader)

  const users = await owner.sql(
    `insert into users (id, name, email, email_verified, updated_at, status)
     values (gen_random_uuid(), 'A1', 'a1-timeline-for@example.com', false, now(), 'active')
     returning id`,
  )
  adminId = String(users.rows[0]!.id)
})

afterAll(async () => {
  await app?.end()
  await owner?.close()
})

describe('activitiesFor：多屆活動一句查完（TE-07b）', () => {
  it('0 個屆別：回空陣列，不送 SQL', async () => {
    const { value, statements: n } = await counted(() => timelineQuery.activitiesFor([]))
    expect(value).toEqual([])
    expect(n).toBe(0)
  })

  it('1 個屆別：跟 activities(id) 完全一樣（含已取消、不含已刪除、別屆的不混進來）', async () => {
    const mine = await newCohort()
    const other = await newCohort()
    await create(mine, { title: '晚的', date: '2099-05-01' })
    const cancelled = await create(mine, { title: '取消的', date: '2099-02-01' })
    await timeline.cancelActivity(admin(), cancelled, 1, randomUUID())
    const removed = await create(mine, { title: '刪掉的', date: '2099-03-01' })
    await timeline.cancelActivity(admin(), removed, 1, randomUUID())
    await timeline.deleteActivity(admin(), removed, 2, randomUUID())
    await create(mine, { title: '早的', date: '2099-01-01', audience: 'teachers' })
    await create(other, { title: '別屆的' })

    const { value, statements: n } = await counted(() => timelineQuery.activitiesFor([mine]))
    expect(n).toBe(1)
    expect(value).toEqual(await timelineQuery.activities(mine))
    expect(value.map((a) => a.title)).toEqual(['早的', '取消的', '晚的'])
    expect(value.find((a) => a.title === '取消的')).toMatchObject({ status: 'cancelled', cohortId: mine })
  })

  it('3 個屆別：一句查完，結果跟逐屆查再合併排序一樣；重複的屆別 ID、格式不對的 ID 不影響', async () => {
    const [a, b, c, outside] = [await newCohort(), await newCohort(), await newCohort(), await newCohort()]
    await create(a, { title: 'A-3 月', date: '2099-03-01' })
    await create(b, { title: 'B-1 月', date: '2099-01-01', audience: 'signed_in' })
    await create(c, { title: 'C-2 月', date: '2099-02-01', allDay: true, startTime: '', endTime: '' })
    await create(a, { title: 'A-4 月', date: '2099-04-01', audience: 'teachers' })
    await create(outside, { title: '不在名單', date: '2099-01-15' })

    const { value, statements: n } = await counted(() => timelineQuery.activitiesFor([a, b, c, a, 'not-a-uuid']))
    expect(n).toBe(1)
    expect(value).toEqual(await perCohort([a, b, c]))
    expect(value.map((x) => x.title)).toEqual(['B-1 月', 'C-2 月', 'A-3 月', 'A-4 月'])
    expect(new Set(value.map((x) => x.cohortId))).toEqual(new Set([a, b, c]))
  })

  it('全是格式不對的屆別 ID：回空陣列，不送 SQL', async () => {
    const { value, statements: n } = await counted(() => timelineQuery.activitiesFor(['nope', '']))
    expect(value).toEqual([])
    expect(n).toBe(0)
  })
})
