import 'server-only'
import { uuidv7 } from 'uuidv7'
import type { Pool, PoolClient } from 'pg'
import type { BusinessClockSource } from '@/application/cohorts'
import {
  afterProjectionFailure,
  notificationsFor,
  type EventPublisher,
  type ProjectableEvent,
} from '@/application/notifications'
import { publishWorkerAlert } from '@/infrastructure/notifications/worker-alerts'
import { reachFaultPoint } from '@/shared/fault-points'
import { RealClock, type Clock } from '@/shared/time'

/**
 * 背景工作的投影迴圈：把 `event_projections(consumer='notifications', pending)` 變成通知
 * （模組實作設計 08 §6；契約 01 §4.6、§9；產品模組 08 §4「去重、補建與保存」）。
 *
 * 每一筆一個交易：`FOR UPDATE SKIP LOCKED` 認領 → 依事件**寫入當下固定**的收件人寫通知
 * （`(event_id, recipient)` 唯一鍵擋重複）→ 標 done → COMMIT。
 * 中途崩潰就整筆回滾，下一輪重跑；就算通知已經寫進去（例如舊版程式寫了卻沒標 done），
 * 唯一鍵也會把重複的擋掉——重跑永遠只會有一則。
 *
 * 失敗（毒事件）：回滾後另開交易記 `attempts+1`、`last_error`、`claimed_at=now()`，
 * 等 2^n 秒再試（`event_projections` 沒有「下次時間」欄，由 `claimed_at` 推）；
 * 第 5 次標 failed，同一筆交易發 `ops.worker_alert` 給管理員（告警事件自己失敗就只記 log，不再告警）。
 */

/** 一句 insert 最多寫幾位收件人。 */
const INSERT_CHUNK = 500

type ClaimRow = { event_id: string; attempts: number }

type EventRow = {
  id: string
  type: string
  scope: 'cohort' | 'global'
  cohort_id: string | null
  source_type: string
  source_id: string
  source_version: number | null
  recipients: string[]
  payload: Record<string, unknown>
  occurred_real_at: Date
}

export type ProjectionSummary = { done: number; retried: number; failed: number }

type Deps = {
  pool: () => Pick<Pool, 'connect'>
  events: EventPublisher<PoolClient>
  businessClock: BusinessClockSource
  realClock?: Clock
  /** 一輪最多處理幾筆（設計：50）。 */
  batchSize?: number
  log?: (message: string, detail?: Record<string, unknown>) => void
}

export class PgNotificationProjector {
  readonly #pool: () => Pick<Pool, 'connect'>
  readonly #events: EventPublisher<PoolClient>
  readonly #businessClock: BusinessClockSource
  readonly #realClock: Clock
  readonly #batchSize: number
  readonly #log: (message: string, detail?: Record<string, unknown>) => void

  constructor(deps: Deps) {
    this.#pool = deps.pool
    this.#events = deps.events
    this.#businessClock = deps.businessClock
    this.#realClock = deps.realClock ?? new RealClock()
    this.#batchSize = deps.batchSize ?? 50
    this.#log = deps.log ?? ((message, detail) => console.log(`[worker] ${message}`, detail ?? ''))
  }

  /** 跑一輪：處理到沒有可認領的列或達到批次上限為止。 */
  async runOnce(): Promise<ProjectionSummary> {
    const summary: ProjectionSummary = { done: 0, retried: 0, failed: 0 }
    for (let i = 0; i < this.#batchSize; i += 1) {
      const outcome = await this.#projectOne()
      if (outcome === 'empty') break
      summary[outcome] += 1
    }
    return summary
  }

  async #projectOne(): Promise<'empty' | 'done' | 'retried' | 'failed'> {
    const client = await this.#pool().connect()
    let claimed: ClaimRow | undefined
    try {
      await client.query('begin')
      const found = await client.query<ClaimRow>(
        `select event_id, attempts from event_projections
          where consumer = 'notifications' and state = 'pending'
            and (claimed_at is null or claimed_at + make_interval(secs => power(2, attempts)) <= now())
          order by event_id
          for update skip locked
          limit 1`,
      )
      claimed = found.rows[0]
      if (!claimed) {
        await client.query('rollback')
        return 'empty'
      }

      const event = await client.query<EventRow>(
        `select id, type, scope, cohort_id, source_type, source_id, source_version, recipients, payload, occurred_real_at
           from domain_events where id = $1`,
        [claimed.event_id],
      )
      const row = event.rows[0]!
      const drafts = notificationsFor(toProjectable(row))
      // 批次寫入：全站公告的收件人可能上千位，一則一句 insert 太慢；每 500 位一句（unnest 陣列），
      // 同一個唯一鍵擋重複，所以重跑、補建一樣只會有一則。
      for (let start = 0; start < drafts.length; start += INSERT_CHUNK) {
        const chunk = drafts.slice(start, start + INSERT_CHUNK)
        const first = chunk[0]!
        await client.query(
          `insert into notifications
             (id, event_id, recipient_user_id, scope, cohort_id, kind, title, source_ref, created_at)
           select r.id, $3, r.recipient, $4, $5, $6, $7, $8::jsonb, $9
             from unnest($1::uuid[], $2::uuid[]) as r(id, recipient)
           on conflict on constraint notifications_event_recipient_unique do nothing`,
          [
            chunk.map(() => uuidv7()),
            chunk.map((d) => d.recipientUserId),
            first.eventId,
            first.scope,
            first.cohortId,
            first.kind,
            first.title,
            JSON.stringify(first.sourceRef),
            // 通知的時間＝事件發生的時間：worker 停機後補建，排序仍照事件先後。
            row.occurred_real_at,
          ],
        )
      }

      // 故障注入點：通知寫了、還沒標 done 就崩潰——整筆回滾，下一輪重跑也只會有一則。
      await reachFaultPoint('projection.after-notifications')

      await client.query(
        `update event_projections set state = 'done', done_at = now(), claimed_at = now(), last_error = null
          where event_id = $1 and consumer = 'notifications'`,
        [claimed.event_id],
      )
      await client.query('commit')
      return 'done'
    } catch (error) {
      await client.query('rollback').catch(() => undefined)
      if (!claimed) throw error
      return this.#recordFailure(claimed.event_id, error)
    } finally {
      client.release()
    }
  }

  async #recordFailure(eventId: string, error: unknown): Promise<'retried' | 'failed'> {
    const message = errorText(error)
    const client = await this.#pool().connect()
    try {
      await client.query('begin')
      const current = await client.query<{ attempts: number; type: string }>(
        `select ep.attempts, de.type
           from event_projections ep join domain_events de on de.id = ep.event_id
          where ep.event_id = $1 and ep.consumer = 'notifications' for update of ep`,
        [eventId],
      )
      const row = current.rows[0]
      if (!row) {
        await client.query('rollback')
        return 'retried'
      }
      const next = afterProjectionFailure(row.attempts)
      await client.query(
        `update event_projections set state = $2, attempts = $3, claimed_at = now(), last_error = $4
          where event_id = $1 and consumer = 'notifications'`,
        [eventId, next.state, next.attempts, message],
      )
      this.#log(`投影失敗（第 ${next.attempts} 次）`, { eventId, type: row.type, state: next.state, error: message })

      if (next.state === 'failed' && row.type !== 'ops.worker_alert') {
        await publishWorkerAlert(client, this.#events, {
          title: '有一則通知投影失敗 5 次，已停止重試',
          source: { type: 'domain_event', id: eventId },
          detail: { reason: 'projection_failed', eventId, eventType: row.type },
          realAt: this.#realClock.now(),
          businessAt: await this.#businessClock.now(),
        })
      }
      await client.query('commit')
      return next.state === 'failed' ? 'failed' : 'retried'
    } catch (inner) {
      await client.query('rollback').catch(() => undefined)
      throw inner
    } finally {
      client.release()
    }
  }
}

function toProjectable(row: EventRow): ProjectableEvent {
  return {
    id: row.id,
    type: row.type,
    scope: row.scope,
    cohortId: row.cohort_id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    sourceVersion: row.source_version,
    recipients: row.recipients,
    payload: row.payload ?? {},
  }
}

/** 錯誤訊息只留前 500 字，而且不含連線字串這類東西（pg 的錯誤訊息本身不帶）。 */
export function errorText(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return text.slice(0, 500)
}
