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
import type { ResolvedActor } from '@/application/accounts'
import type { DomainEventInput, DueWorkHandler } from '@/application/notifications'
import { PgDueWorkRunner, testNoopHandler } from '@/infrastructure/notifications/pg-due-work-runner'
import { PgDueWorkScheduler } from '@/infrastructure/notifications/pg-due-work-scheduler'
import { PgEventPublisher } from '@/infrastructure/notifications/pg-event-publisher'
import { PgInbox } from '@/infrastructure/notifications/pg-inbox'
import { PgNotificationProjector } from '@/infrastructure/notifications/pg-projector'
import { PgTestNotificationCommand } from '@/infrastructure/notifications/pg-test-notification'
import { acquireWorkerLock, readWorkerHealth, writeHeartbeat } from '@/infrastructure/notifications/worker-runtime'
import { PgAuditWriter } from '@/infrastructure/ops/audit-writer'
import { PgOperationLedger } from '@/infrastructure/ops/operation-ledger'

/**
 * 票 12（#223）：背景工作與通知匣。全部以正式執行角色 `fju_app` 連線，順便證明權限矩陣給的權限夠用。
 *
 * - 投影冪等：重跑、崩潰重啟、通知已先存在，都只有一則；毒事件退避、第 5 次 failed＋管理員告警。
 * - 單一實例鎖：第二個拿不到；第一個放掉之後才拿得到。
 * - 到期工作：test_noop 恰好一次、業務鐘回撥不重跑、未註冊種類保持等待、之後掛上 handler 恰好完成一次、
 *   defer 不累計、例外累計到 failed＋告警。
 * - 心跳：`/api/health` 的 worker 欄讀得到真值。
 * - 通知匣：只看得到自己的、屆別篩選、單筆／全部已讀、別人的通知編號被拒而且不改。
 * - 測試通知：正式站拒絕；測試站發一次＝一個事件，同一個請求編號重送不會多一個。
 */

let owner: IsolatedDatabase
let app: Pool
let admin: string
let alice: string
let bob: string
let cohortId: string

const publisher = new PgEventPublisher()
const businessNow = { value: new Date('2027-03-01T00:00:00Z') }
const businessClock = { now: async () => businessNow.value }
const logs: string[] = []
const log = (message: string) => logs.push(message)

beforeAll(async () => {
  await assertTestDatabaseReachable()
  owner = await createIsolatedDatabase({ label: 'worker', setup: migratedSchema })
  app = await poolAsRole(owner, 'fju_app')

  const users = await owner.sql(
    `insert into users (id, name, email, email_verified, updated_at, status)
     values (gen_random_uuid(), 'Admin', 'admin-w@example.com', false, now(), 'active'),
            (gen_random_uuid(), 'Alice', 'alice-w@example.com', false, now(), 'active'),
            (gen_random_uuid(), 'Bob', 'bob-w@example.com', false, now(), 'active')
     returning id, name`,
  )
  const id = (name: string) => String(users.rows.find((r) => r.name === name)!.id)
  admin = id('Admin')
  alice = id('Alice')
  bob = id('Bob')
  await owner.sql(
    `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at)
     values (gen_random_uuid(), $1, 'admin', $1, now())`,
    [admin],
  )
  const cohort = await owner.sql(
    `insert into cohorts (id, code, name, created_by_kind) values (gen_random_uuid(), '115-W', '115', 'system') returning id`,
  )
  cohortId = String(cohort.rows[0]!.id)
})

afterAll(async () => {
  await app?.end()
  await owner?.close()
})

const actorOf = (userId: string, roles: ('admin' | 'student')[] = ['student']): ResolvedActor => ({
  kind: 'authenticated',
  userId,
  roles,
  status: 'active',
  mustChangePassword: false,
  cohortMemberships: [],
})

async function publish(patch: Partial<DomainEventInput> = {}): Promise<string> {
  const tx = await app.connect()
  try {
    await tx.query('begin')
    const { eventId } = await publisher.publish(tx, {
      type: 'test.notification',
      scope: 'global',
      source: { type: 'test', id: randomUUID(), version: 1 },
      actor: { kind: 'user', userId: admin },
      recipients: [alice],
      payload: { title: '整合測試通知' },
      occurredRealAt: new Date(),
      occurredBusinessAt: businessNow.value,
      ...patch,
    })
    await tx.query('commit')
    return eventId
  } finally {
    tx.release()
  }
}

async function count(sql: string, values: unknown[] = []): Promise<number> {
  return Number((await owner.sql(sql, values)).rows[0]!.n)
}

const projector = () => new PgNotificationProjector({ pool: () => app, events: publisher, businessClock, log })

describe('投影：事件 → 通知（冪等）', () => {
  it('投影一次＝每位收件人一則；重跑不會多', async () => {
    const eventId = await publish({ recipients: [alice, bob, alice] })
    await projector().runOnce()
    await projector().runOnce()

    expect(await count('select count(*) as n from notifications where event_id = $1', [eventId])).toBe(2)
    const projection = await owner.sql(`select state, attempts from event_projections where event_id = $1`, [eventId])
    expect(projection.rows[0]).toMatchObject({ state: 'done', attempts: 0 })
  })

  it('通知已經先存在（例如舊程式寫了卻沒標 done）：重跑只剩一則', async () => {
    const eventId = await publish()
    await owner.sql(
      `insert into notifications (id, event_id, recipient_user_id, scope, kind, title)
       values (gen_random_uuid(), $1, $2, 'global', 'system', '先寫進去的')`,
      [eventId, alice],
    )
    await projector().runOnce()
    expect(await count('select count(*) as n from notifications where event_id = $1', [eventId])).toBe(1)
    expect((await owner.sql('select state from event_projections where event_id = $1', [eventId])).rows[0]!.state).toBe('done')
  })

  it('寫完通知、標 done 之前崩潰：整筆回滾，重跑後恰好一則', async () => {
    const eventId = await publish()
    const disable = enableFaultInjection()
    try {
      failAt('projection.after-notifications')
      await projector().runOnce()
    } finally {
      disable()
    }
    expect(await count('select count(*) as n from notifications where event_id = $1', [eventId])).toBe(0)
    const after = await owner.sql('select state, attempts from event_projections where event_id = $1', [eventId])
    expect(after.rows[0]).toMatchObject({ state: 'pending', attempts: 1 })

    // 退避時間還沒到：這一輪不會撿。把時間往前推（模擬 2 秒後）再跑。
    await projector().runOnce()
    expect(await count('select count(*) as n from notifications where event_id = $1', [eventId])).toBe(0)
    await owner.sql(`update event_projections set claimed_at = now() - interval '1 hour' where event_id = $1`, [eventId])
    await projector().runOnce()
    expect(await count('select count(*) as n from notifications where event_id = $1', [eventId])).toBe(1)
  })

  it('毒事件（收件人不存在）：每次失敗 +1、第 5 次 failed，同交易發告警給管理員', async () => {
    const ghost = randomUUID()
    const eventId = await publish({ recipients: [ghost] })
    for (let i = 0; i < 5; i += 1) {
      await owner.sql(`update event_projections set claimed_at = now() - interval '1 hour' where event_id = $1`, [eventId])
      await projector().runOnce()
    }
    const row = await owner.sql('select state, attempts, last_error from event_projections where event_id = $1', [eventId])
    expect(row.rows[0]).toMatchObject({ state: 'failed', attempts: 5 })
    expect(String(row.rows[0]!.last_error)).toMatch(/foreign key|外鍵|violates/i)

    const alerts = await owner.sql(
      `select recipients, payload from domain_events where type = 'ops.worker_alert' and source_id = $1`,
      [eventId],
    )
    expect(alerts.rows).toHaveLength(1)
    expect(alerts.rows[0]!.recipients).toEqual([admin])
    expect(alerts.rows[0]!.payload).toMatchObject({ reason: 'projection_failed' })

    // 告警本身照一般投影進管理員的通知匣；failed 的那筆不再被撿。
    await projector().runOnce()
    expect(await count(`select count(*) as n from notifications where recipient_user_id = $1 and kind = 'system' and title like '%投影失敗%'`, [admin])).toBe(1)
    expect((await owner.sql('select attempts from event_projections where event_id = $1', [eventId])).rows[0]!.attempts).toBe(5)
  })
})

describe('單一實例鎖', () => {
  it('第二個拿不到；第一個放掉後才拿得到', async () => {
    const name = `worker-lock-${owner.schemaName}`
    const first = await acquireWorkerLock(app, name)
    expect(first).not.toBeNull()
    expect(await acquireWorkerLock(app, name)).toBeNull()
    await first!.release()
    const third = await acquireWorkerLock(app, name)
    expect(third).not.toBeNull()
    await third!.release()
  })
})

describe('心跳與 /api/health 的 worker 欄', () => {
  it('沒有心跳時兩個 null；寫過之後是版本與最後一次時間', async () => {
    expect(await readWorkerHealth(app)).toEqual({ version: null, lastTickAt: null })
    const tickAt = new Date('2026-09-24T08:00:00.000Z')
    await writeHeartbeat(app, { version: 'abc123', tickAt, projectionAt: tickAt })
    await writeHeartbeat(app, { version: 'abc123', tickAt: new Date('2026-09-24T08:00:05.000Z') })
    expect(await readWorkerHealth(app)).toEqual({ version: 'abc123', lastTickAt: '2026-09-24T08:00:05.000Z' })
    // 沒帶 projectionAt 的那一拍不會把上一次的投影時間清掉。
    const row = await owner.sql('select last_projection_at from worker_heartbeat where id = 1')
    expect((row.rows[0]!.last_projection_at as Date).toISOString()).toBe(tickAt.toISOString())
  })
})

describe('到期工作迴圈', () => {
  const scheduler = new PgDueWorkScheduler({ testKindsEnabled: true })

  async function schedule(kind: 'test_noop' | 'deadline_snapshot', due: Date) {
    const tx = await app.connect()
    try {
      await tx.query('begin')
      const scheduled = await scheduler.schedule(tx, {
        kind,
        subject: { type: kind === 'test_noop' ? 'test' : 'item', id: randomUUID() },
        deadlineVersion: 1,
        dueBusinessAt: due,
      })
      await tx.query('commit')
      return scheduled.dueWorkId
    } finally {
      tx.release()
    }
  }

  const runner = (handlers: Record<string, DueWorkHandler<PoolClient>>) =>
    new PgDueWorkRunner({ pool: () => app, handlers, events: publisher, businessClock, log })

  const state = async (id: string) =>
    (await owner.sql('select state, attempts, next_attempt_at, result_ref from due_work where id = $1', [id])).rows[0]!

  it('test_noop：業務鐘還沒到不做；推過到期時間後恰好做一次；鐘往回撥也不重做', async () => {
    const handled: string[] = []
    const handlers = {
      test_noop: {
        handle: async (tx: PoolClient, work: Parameters<ReturnType<typeof testNoopHandler>['handle']>[1]) => {
          handled.push(work.id)
          return testNoopHandler(log).handle(tx, work)
        },
      },
    }
    businessNow.value = new Date('2027-03-01T00:00:00Z')
    const id = await schedule('test_noop', new Date('2027-03-31T23:59:59Z'))

    await runner(handlers).runOnce()
    expect((await state(id)).state).toBe('pending')

    businessNow.value = new Date('2027-04-01T00:00:00Z') // 跳月
    await runner(handlers).runOnce()
    await runner(handlers).runOnce()
    expect(await state(id)).toMatchObject({ state: 'done', result_ref: { noop: true } })

    businessNow.value = new Date('2027-03-15T00:00:00Z') // 回撥
    await runner(handlers).runOnce()
    expect(handled.filter((h) => h === id)).toHaveLength(1)
  })

  it('合法但還沒有 handler：保持 pending、次數不累計；掛上 handler 後下一輪恰好完成一次', async () => {
    businessNow.value = new Date('2027-05-01T00:00:00Z')
    const id = await schedule('deadline_snapshot', new Date('2027-04-30T00:00:00Z'))

    await runner({}).runOnce()
    const waiting = await state(id)
    expect(waiting).toMatchObject({ state: 'pending', attempts: 0 })
    expect(waiting.next_attempt_at).not.toBeNull()
    expect(await count(`select count(*) as n from domain_events where type = 'ops.worker_alert' and source_id = $1`, [id])).toBe(0)

    let calls = 0
    const handler = { handle: async () => ((calls += 1), { kind: 'done' as const }) }
    await runner({ deadline_snapshot: handler }).runOnce() // 還在等待時間內
    expect(calls).toBe(0)
    await owner.sql('update due_work set next_attempt_at = now() - interval \'1 second\' where id = $1', [id])
    await runner({ deadline_snapshot: handler }).runOnce()
    await runner({ deadline_snapshot: handler }).runOnce()
    expect(calls).toBe(1)
    expect((await state(id)).state).toBe('done')
  })

  it('handler 回 defer：保持 pending、次數不累計', async () => {
    const id = await schedule('deadline_snapshot', new Date('2027-04-30T00:00:00Z'))
    await runner({ deadline_snapshot: { handle: async () => ({ kind: 'defer', reason: '快照還沒拍' }) } }).runOnce()
    expect(await state(id)).toMatchObject({ state: 'pending', attempts: 0 })
  })

  it('自己開交易的 handler（票 13 提案到期的掛法）：它自己把工作改成 cancelled 就不覆蓋；回 defer 保持等待', async () => {
    businessNow.value = new Date('2027-05-01T00:00:00Z')
    const cancelledByHandler = await schedule('deadline_snapshot', new Date('2027-04-30T00:00:00Z'))
    let seenLocked = true
    const terminating: DueWorkHandler<PoolClient> = {
      mode: 'own_transaction',
      handle: async (work) => {
        // 用另一條連線改同一列：worker 若還拿著 FOR UPDATE，這裡會卡住（lock_timeout 讓它直接失敗）。
        const other = await app.connect()
        try {
          await other.query('begin')
          await other.query(`set local lock_timeout = '2s'`)
          await other.query(`update due_work set state = 'cancelled' where id = $1 and state = 'pending'`, [work.id])
          await other.query('commit')
          seenLocked = false
        } finally {
          other.release()
        }
        return { kind: 'done' }
      },
    }
    await runner({ deadline_snapshot: terminating }).runOnce()
    expect(seenLocked).toBe(false)
    expect((await state(cancelledByHandler)).state).toBe('cancelled')

    const notDue = await schedule('deadline_snapshot', new Date('2027-04-30T00:00:00Z'))
    let calls = 0
    await runner({
      deadline_snapshot: { mode: 'own_transaction', handle: async () => ((calls += 1), { kind: 'defer', reason: 'not_due' }) },
    }).runOnce()
    expect(calls).toBe(1)
    expect(await state(notDue)).toMatchObject({ state: 'pending', attempts: 0 })
  })

  it('handler 例外：它寫一半的東西回滾；次數累計，第 5 次 failed＋告警', async () => {
    const id = await schedule('deadline_snapshot', new Date('2027-04-30T00:00:00Z'))
    const boom: DueWorkHandler<PoolClient> = {
      handle: async (tx) => {
        await tx.query(`insert into cohorts (id, code, name, created_by_kind) values (gen_random_uuid(), 'HALF-${id.slice(0, 8)}', 'x', 'system')`)
        throw new Error('handler 爆了')
      },
    }
    for (let i = 0; i < 5; i += 1) {
      await owner.sql('update due_work set next_attempt_at = null where id = $1', [id])
      await runner({ deadline_snapshot: boom }).runOnce()
    }
    expect(await state(id)).toMatchObject({ state: 'failed', attempts: 5 })
    expect(await count(`select count(*) as n from cohorts where code = $1`, [`HALF-${id.slice(0, 8)}`])).toBe(0)
    expect(await count(`select count(*) as n from domain_events where type = 'ops.worker_alert' and source_id = $1`, [id])).toBe(1)
  })
})

describe('通知匣：只有本人、篩選、已讀', () => {
  const inbox = new PgInbox({ db: () => app })

  it('只看得到自己的；可依屆別篩選；未讀數＝鈴鐺', async () => {
    await owner.sql(`update notifications set read_at = now() where recipient_user_id in ($1, $2)`, [alice, bob])
    const global = await publish({ recipients: [alice], payload: { title: '全站的' } })
    const scoped = await publish({ scope: 'cohort', cohortId, recipients: [alice], payload: { title: '115 的' } })
    await publish({ recipients: [bob], payload: { title: 'Bob 的' } })
    await projector().runOnce()

    const all = await inbox.list(actorOf(alice), { kind: 'all' }, null)
    const titles = all.items.map((i) => i.title)
    expect(titles.slice(0, 2)).toEqual(['115 的', '全站的']) // 新到舊
    expect(titles).not.toContain('Bob 的')
    expect(await inbox.unreadCount(actorOf(alice))).toBe(2)

    const onlyCohort = await inbox.list(actorOf(alice), { kind: 'cohort', cohortId }, null)
    expect(onlyCohort.items.map((i) => i.title)).toEqual(['115 的'])
    expect(onlyCohort.items[0]).toMatchObject({ cohortCode: '115-W', source: { state: 'ok' } })
    const onlyGlobal = await inbox.list(actorOf(alice), { kind: 'global' }, null)
    expect(onlyGlobal.items.map((i) => i.title)).toContain('全站的')
    expect(onlyGlobal.items.map((i) => i.title)).not.toContain('115 的')
    expect((await inbox.cohortOptions(actorOf(alice))).map((c) => c.code)).toEqual(['115-W'])
    expect([global, scoped]).toHaveLength(2)
  })

  it('單筆標已讀：未讀數減一；再按一次不改第一次的時間', async () => {
    const [first] = (await inbox.list(actorOf(alice), { kind: 'all' }, null)).items
    const result = await inbox.markRead(actorOf(alice), first!.id)
    expect(result).toMatchObject({ ok: true, receipt: { changed: 1 } })
    expect(await inbox.unreadCount(actorOf(alice))).toBe(1)

    const readAt = (await owner.sql('select read_at from notifications where id = $1', [first!.id])).rows[0]!.read_at
    const again = await inbox.markRead(actorOf(alice), first!.id)
    expect(again).toMatchObject({ ok: true, receipt: { changed: 0 } })
    expect((await owner.sql('select read_at from notifications where id = $1', [first!.id])).rows[0]!.read_at).toEqual(readAt)
  })

  it('拿別人的通知編號標已讀：「無法存取」，那一則仍是未讀；不存在的編號同一句話', async () => {
    const bobs = (await inbox.list(actorOf(bob), { kind: 'all' }, null)).items.find((i) => i.readAt === null)!
    const denied = await inbox.markRead(actorOf(alice), bobs.id)
    expect(denied).toMatchObject({ ok: false, code: 'FORBIDDEN', message: '無法存取這則通知。' })
    expect((await owner.sql('select read_at from notifications where id = $1', [bobs.id])).rows[0]!.read_at).toBeNull()
    expect(await inbox.markRead(actorOf(alice), randomUUID())).toMatchObject({ ok: false, code: 'FORBIDDEN', message: '無法存取這則通知。' })
    expect(await inbox.unreadCount(actorOf(bob))).toBe(1)
  })

  it('全部標已讀只動本人、只動篩選範圍內的', async () => {
    await publish({ scope: 'cohort', cohortId, recipients: [alice], payload: { title: '115 另一則' } })
    await publish({ recipients: [alice], payload: { title: '全站另一則' } })
    await projector().runOnce()
    const before = await inbox.unreadCount(actorOf(alice))

    const scoped = await inbox.markAllRead(actorOf(alice), { kind: 'cohort', cohortId })
    expect(scoped.ok && scoped.receipt.changed).toBe(1)
    expect(await inbox.unreadCount(actorOf(alice))).toBe(before - 1)

    await inbox.markAllRead(actorOf(alice), { kind: 'all' })
    expect(await inbox.unreadCount(actorOf(alice))).toBe(0)
    expect(await inbox.unreadCount(actorOf(bob))).toBe(1)
  })

  it('沒登入、停用、待審：看不到任何東西，也標不了', async () => {
    expect((await inbox.list({ kind: 'anonymous' }, { kind: 'all' }, null)).items).toEqual([])
    expect(await inbox.unreadCount({ ...actorOf(bob), status: 'disabled' } as ResolvedActor)).toBe(0)
    expect(await inbox.markAllRead({ kind: 'anonymous' }, { kind: 'all' })).toMatchObject({ ok: false, code: 'UNAUTHENTICATED' })
  })
})

describe('管理端「發一則測試通知」', () => {
  const command = (enabled: boolean) =>
    new PgTestNotificationCommand({
      enabled,
      audit: new PgAuditWriter(),
      ledger: new PgOperationLedger(() => app),
      events: publisher,
      businessClock,
      pool: () => app,
      reader: () => app,
    })

  it('正式站：一律拒絕，什麼都不寫', async () => {
    const before = await count(`select count(*) as n from domain_events where type = 'test.notification'`)
    const result = await command(false).send(actorOf(admin, ['admin']), { recipientUserId: bob, cohortId: '', title: '' }, randomUUID())
    expect(result).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(await count(`select count(*) as n from domain_events where type = 'test.notification'`)).toBe(before)
  })

  it('不是管理員：拒絕', async () => {
    const result = await command(true).send(actorOf(alice), { recipientUserId: bob, cohortId: '', title: '' }, randomUUID())
    expect(result).toMatchObject({ ok: false, code: 'FORBIDDEN' })
  })

  it('測試站：發一次＝一個事件；同一個請求編號重送不會多；投影後收件人通知匣多一則', async () => {
    const requestId = randomUUID()
    const input = { recipientUserId: bob, cohortId, title: '驗證投影' }
    const first = await command(true).send(actorOf(admin, ['admin']), input, requestId)
    const second = await command(true).send(actorOf(admin, ['admin']), input, requestId)
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.receipt.eventId).toBe(first.receipt.eventId)
    expect(first.receipt.recipientName).toBe('Bob')

    await projector().runOnce()
    await projector().runOnce()
    expect(await count(`select count(*) as n from notifications where event_id = $1`, [first.receipt.eventId])).toBe(1)
    const bobs = await new PgInbox({ db: () => app }).list(actorOf(bob), { kind: 'cohort', cohortId }, null)
    expect(bobs.items.map((i) => i.title)).toContain('驗證投影')
    expect(await count(`select count(*) as n from audit_events where action = 'notification.test.send'`)).toBe(1)
  })
})
