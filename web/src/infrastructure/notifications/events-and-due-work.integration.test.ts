import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import {
  assertTestDatabaseReachable,
  createIsolatedDatabase,
  poolAsRole,
  type IsolatedDatabase,
} from '../../../test/db'
import { migratedSchema } from '../../../test/migrations'
import { enableFaultInjection, failAt } from '../../../test/fault-injection'
import { DomainEventRejected, DueWorkRejected, type DomainEventInput } from '@/application/notifications'
import { PgTimelineCommand } from '@/infrastructure/cohorts/pg-timeline'
import { PgDueWorkScheduler } from '@/infrastructure/notifications/pg-due-work-scheduler'
import { PgEventPublisher } from '@/infrastructure/notifications/pg-event-publisher'
import { PgAuditWriter } from '@/infrastructure/ops/audit-writer'
import { PgOperationLedger } from '@/infrastructure/ops/operation-ledger'

/**
 * 票 11（S02-03）：「發事件」與「排到期工作」兩個共用 port，跟業務動作同一筆交易寫入。
 *
 * 四組重點（S02-03 票「自動測試」）：收件人固定、換版取消舊版本、交易回滾兩表皆空、種類白名單。
 * 全部以正式執行角色 `fju_app` 連線，順便證明權限矩陣給的權限夠用。
 */

let owner: IsolatedDatabase
let app: Pool
let userA: string
let userB: string
let cohortId: string

const publisher = new PgEventPublisher()
const productionScheduler = new PgDueWorkScheduler({ testKindsEnabled: false })
const stagingScheduler = new PgDueWorkScheduler({ testKindsEnabled: true })

beforeAll(async () => {
  await assertTestDatabaseReachable()
  owner = await createIsolatedDatabase({ label: 'outbox', setup: migratedSchema })
  app = await poolAsRole(owner, 'fju_app')

  const users = await owner.sql(
    `insert into users (id, name, email, email_verified, updated_at, status)
     values (gen_random_uuid(), 'A', 'a-outbox@example.com', false, now(), 'active'),
            (gen_random_uuid(), 'B', 'b-outbox@example.com', false, now(), 'active')
     returning id, name`,
  )
  userA = String(users.rows.find((r) => r.name === 'A')!.id)
  userB = String(users.rows.find((r) => r.name === 'B')!.id)
  const cohort = await owner.sql(
    `insert into cohorts (id, code, name, created_by_kind) values (gen_random_uuid(), '115-OB', '115', 'system') returning id`,
  )
  cohortId = String(cohort.rows[0]!.id)
})

afterAll(async () => {
  await app?.end()
  await owner?.close()
})

async function inAppTransaction<T>(body: (tx: PoolClient) => Promise<T>, commit = true): Promise<T> {
  const tx = await app.connect()
  try {
    await tx.query('begin')
    const result = await body(tx)
    await tx.query(commit ? 'commit' : 'rollback')
    return result
  } catch (error) {
    await tx.query('rollback')
    throw error
  } finally {
    tx.release()
  }
}

const event = (patch: Partial<DomainEventInput> = {}): DomainEventInput => ({
  type: 'test.notification',
  scope: 'cohort',
  cohortId,
  source: { type: 'test', id: randomUUID(), version: 1 },
  actor: { kind: 'user', userId: userA },
  recipients: [userB, userA, userB],
  recipientBasis: { reason: '整合測試' },
  payload: { title: '測試' },
  occurredRealAt: new Date('2026-09-24T01:00:00Z'),
  occurredBusinessAt: new Date('2027-03-01T02:00:00Z'),
  ...patch,
})

async function count(sql: string, values: unknown[] = []): Promise<number> {
  return Number((await owner.sql(sql, values)).rows[0]!.n)
}

describe('EventPublisher.publish', () => {
  it('寫一筆事件，收件人去重後固定存進去，業務與真實時間都在', async () => {
    const { eventId } = await inAppTransaction((tx) => publisher.publish(tx, event()))

    const row = await owner.sql(
      `select type, scope, cohort_id, actor_kind, actor_user_id, recipients, recipient_basis,
              occurred_real_at, occurred_business_at
         from domain_events where id = $1`,
      [eventId],
    )
    expect(row.rows[0]).toMatchObject({
      type: 'test.notification',
      scope: 'cohort',
      cohort_id: cohortId,
      actor_kind: 'user',
      actor_user_id: userA,
      recipient_basis: { reason: '整合測試' },
    })
    expect([...(row.rows[0]!.recipients as string[])].sort()).toEqual([userA, userB].sort())
    expect((row.rows[0]!.occurred_business_at as Date).toISOString()).toBe('2027-03-01T02:00:00.000Z')
  })

  it('依事件目錄替每個消費者建一列待投影；沒有消費者的事件不建', async () => {
    const withConsumer = await inAppTransaction((tx) => publisher.publish(tx, event()))
    expect(
      (await owner.sql('select consumer, state, attempts from event_projections where event_id = $1', [withConsumer.eventId])).rows,
    ).toEqual([{ consumer: 'notifications', state: 'pending', attempts: 0 }])

    const withoutConsumer = await inAppTransaction((tx) =>
      publisher.publish(tx, event({ type: 'calendar.changed', recipients: [] })),
    )
    expect(await count('select count(*) as n from event_projections where event_id = $1', [withoutConsumer.eventId])).toBe(0)
  })

  it('事件寫進去就改不掉（不可變 outbox）：收件人之後不能被重新展開', async () => {
    const { eventId } = await inAppTransaction((tx) => publisher.publish(tx, event()))
    await expect(app.query(`update domain_events set recipients = '{}' where id = $1`, [eventId])).rejects.toThrow(
      /permission denied/i,
    )
  })

  it('沒登記的型別：丟例外，交易回滾，什麼都沒寫', async () => {
    const before = await count('select count(*) as n from domain_events')
    await expect(
      inAppTransaction((tx) => publisher.publish(tx, event({ type: 'nope.unknown' as never }))),
    ).rejects.toThrow(DomainEventRejected)
    expect(await count('select count(*) as n from domain_events')).toBe(before)
  })
})

describe('DueWorkScheduler', () => {
  const subject = () => ({ type: 'item', id: randomUUID() })

  it('排程：寫一列 pending；同一個 identity 重排不會多一列（重試安全）', async () => {
    const s = subject()
    const work = { kind: 'deadline_snapshot' as const, subject: s, deadlineVersion: 1, dueBusinessAt: new Date('2027-03-01T15:59:00Z') }
    const first = await inAppTransaction((tx) => productionScheduler.schedule(tx, work))
    const second = await inAppTransaction((tx) => productionScheduler.schedule(tx, work))

    expect(first.created).toBe(true)
    expect(second).toEqual({ dueWorkId: first.dueWorkId, created: false })
    const rows = await owner.sql(`select state, attempts, due_business_at from due_work where subject_id = $1`, [s.id])
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0]).toMatchObject({ state: 'pending', attempts: 0 })
  })

  it('換版：同一筆交易取消舊版本、排新版本；已完成的舊列不動', async () => {
    const s = subject()
    await inAppTransaction((tx) =>
      productionScheduler.schedule(tx, { kind: 'deadline_snapshot', subject: s, deadlineVersion: 1, dueBusinessAt: new Date('2027-03-01T00:00:00Z') }),
    )

    const cancelled = await inAppTransaction(async (tx) => {
      const n = await productionScheduler.cancel(tx, { kind: 'deadline_snapshot', subject: s, deadlineVersion: 1 })
      await productionScheduler.schedule(tx, { kind: 'deadline_snapshot', subject: s, deadlineVersion: 2, dueBusinessAt: new Date('2027-03-08T00:00:00Z') })
      return n
    })
    expect(cancelled).toBe(1)

    const rows = await owner.sql(
      `select deadline_version, state from due_work where subject_id = $1 order by deadline_version`,
      [s.id],
    )
    expect(rows.rows).toEqual([
      { deadline_version: 1, state: 'cancelled' },
      { deadline_version: 2, state: 'pending' },
    ])

    // 已完成的不會被「取消」改回來（回撥不重跑 done，契約 01 §4.7）。
    await owner.sql(`update due_work set state = 'done', done_at = now() where subject_id = $1 and deadline_version = 2`, [s.id])
    expect(await inAppTransaction((tx) => productionScheduler.cancel(tx, { kind: 'deadline_snapshot', subject: s, deadlineVersion: 2 }))).toBe(0)
    expect(await count(`select count(*) as n from due_work where subject_id = $1 and state = 'done'`, [s.id])).toBe(1)
  })

  it('種類白名單：不在白名單的種類丟例外、不寫入', async () => {
    const s = subject()
    await expect(
      inAppTransaction((tx) =>
        productionScheduler.schedule(tx, { kind: 'send_email' as never, subject: s, deadlineVersion: 1, dueBusinessAt: new Date() }),
      ),
    ).rejects.toThrow(DueWorkRejected)
    expect(await count('select count(*) as n from due_work where subject_id = $1', [s.id])).toBe(0)
  })

  it('test_noop：正式站（開關 false）拒絕；測試站可以排', async () => {
    const s = subject()
    const noop = { kind: 'test_noop' as const, subject: { type: 'test', id: s.id }, deadlineVersion: 1, dueBusinessAt: new Date() }
    await expect(inAppTransaction((tx) => productionScheduler.schedule(tx, noop))).rejects.toThrow(/只能在測試站/)
    expect(await count('select count(*) as n from due_work where subject_id = $1', [s.id])).toBe(0)

    const scheduled = await inAppTransaction((tx) => stagingScheduler.schedule(tx, noop))
    expect(scheduled.created).toBe(true)
  })
})

describe('跟業務動作同一筆交易', () => {
  it('業務寫入、事件、到期工作在同一筆交易：回滾時三者都不留', async () => {
    const activityId = randomUUID()
    const s = { type: 'project_event', id: activityId }
    const before = {
      events: await count('select count(*) as n from domain_events'),
      due: await count('select count(*) as n from due_work'),
    }

    await inAppTransaction(async (tx) => {
      await tx.query(
        `insert into project_events (id, cohort_id, title, starts_at, audience_kind, created_by_kind)
         values ($1, $2, '會被回滾的活動', now(), 'cohort_students', 'system')`,
        [activityId, cohortId],
      )
      await publisher.publish(tx, event({ source: { type: 'project_event', id: activityId, version: 1 } }))
      await productionScheduler.schedule(tx, { kind: 'deadline_snapshot', subject: s, deadlineVersion: 1, dueBusinessAt: new Date() })
    }, false)

    expect(await count('select count(*) as n from project_events where id = $1', [activityId])).toBe(0)
    expect(await count('select count(*) as n from domain_events')).toBe(before.events)
    expect(await count('select count(*) as n from due_work')).toBe(before.due)
    expect(await count('select count(*) as n from event_projections ep join domain_events de on de.id = ep.event_id where de.source_id = $1', [activityId])).toBe(0)
  })

  it('真的用例：事件寫完後程序出錯（故障注入），活動、事件、稽核、帳本一起回滾', async () => {
    const command = new PgTimelineCommand({
      audit: new PgAuditWriter(),
      ledger: new PgOperationLedger(() => app),
      events: publisher,
      businessClock: { now: async () => new Date() },
      pool: () => app,
    })
    const actor = {
      kind: 'authenticated' as const,
      userId: userA,
      roles: ['admin' as const],
      status: 'active' as const,
      mustChangePassword: false,
      cohortMemberships: [],
    }
    const input = {
      title: '故障注入活動',
      description: '',
      date: '2026-12-20',
      allDay: true,
      startTime: '',
      endTime: '',
      audience: 'cohort_students',
    }
    const requestId = randomUUID()
    const before = {
      events: await count('select count(*) as n from domain_events'),
      audit: await count('select count(*) as n from audit_events'),
    }

    const disable = enableFaultInjection()
    try {
      failAt('outbox.after-insert')
      const result = await command.createActivity(actor, cohortId, input, requestId)
      expect(result).toMatchObject({ ok: false, code: 'INTERNAL' })
    } finally {
      disable()
    }

    expect(await count(`select count(*) as n from project_events where title = '故障注入活動'`)).toBe(0)
    expect(await count('select count(*) as n from domain_events')).toBe(before.events)
    expect(await count('select count(*) as n from audit_events')).toBe(before.audit)
    expect(await count('select count(*) as n from operation_records where request_id = $1', [requestId])).toBe(0)

    // 故障排除後，同一個請求編號可以正常再送一次（帳本沒有留下失敗的那一筆）。
    const retried = await command.createActivity(actor, cohortId, input, requestId)
    expect(retried.ok).toBe(true)
    expect(await count(`select count(*) as n from project_events where title = '故障注入活動'`)).toBe(1)
    expect(
      await count(
        `select count(*) as n from domain_events where type = 'calendar.changed' and source_type = 'project_event' and payload->>'title' = '故障注入活動'`,
      ),
    ).toBe(1)
  })
})
