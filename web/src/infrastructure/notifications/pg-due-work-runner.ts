import 'server-only'
import type { Pool, PoolClient } from 'pg'
import type { BusinessClockSource } from '@/application/cohorts'
import {
  dueWorkTransition,
  type ClaimedDueWork,
  type DueWorkHandlers,
  type DueWorkKind,
  type DueWorkRunResult,
  type EventPublisher,
} from '@/application/notifications'
import { errorText } from '@/infrastructure/notifications/pg-projector'
import { publishWorkerAlert } from '@/infrastructure/notifications/worker-alerts'
import { reachFaultPoint } from '@/shared/fault-points'
import { RealClock, type Clock } from '@/shared/time'

/**
 * 背景工作的到期迴圈（模組實作設計 08 §6「到期迴圈 30 秒」與 v2.4 生命週期表；契約 01 §4.7）。
 *
 * 看**業務鐘**決定到期了沒（測試站推模擬鐘就會觸發）：
 * `due_business_at <= 業務現在 AND state='pending' AND (next_attempt_at 為空或已過真實現在)`。
 * 每一件一個交易：認領 → handler（跟「標 done」同一筆 commit）→ 寫回狀態。
 *
 * - 已經 done 的不會再跑：業務鐘往回撥也一樣（只認領 pending）。
 * - 合法但還沒有 handler 的種類、handler 回 `defer`：保持 pending、5 分鐘後再看、次數不累計、不告警；
 *   每個種類每小時只 log 一次。後面的票掛上 handler 後，下一輪就會恰好完成一次。
 * - handler 丟例外：回到 savepoint（它寫一半的東西不留），次數 +1、退避 2^n 秒；第 5 次 failed＋告警。
 */

type Row = {
  id: string
  kind: DueWorkKind
  subject_type: string
  subject_id: string
  deadline_version: number
  due_business_at: Date
  attempts: number
}

export type DueWorkSummary = { done: number; waiting: number; retried: number; failed: number }

type Deps = {
  pool: () => Pick<Pool, 'connect'>
  handlers: DueWorkHandlers<PoolClient>
  events: EventPublisher<PoolClient>
  businessClock: BusinessClockSource
  realClock?: Clock
  batchSize?: number
  log?: (message: string, detail?: Record<string, unknown>) => void
}

const HOUR_MS = 60 * 60 * 1000

/** 自己開交易的 handler：交易外呼叫期間，這件工作被往後推多久（期間 worker 崩潰，過了就重撿）。 */
const OWN_TRANSACTION_HOLD_MS = 2 * 60 * 1000

export class PgDueWorkRunner {
  readonly #pool: () => Pick<Pool, 'connect'>
  readonly #handlers: DueWorkHandlers<PoolClient>
  readonly #events: EventPublisher<PoolClient>
  readonly #businessClock: BusinessClockSource
  readonly #realClock: Clock
  readonly #batchSize: number
  readonly #log: (message: string, detail?: Record<string, unknown>) => void
  /** 未註冊種類上次 log 的時間（每種每小時一次）。 */
  readonly #unregisteredLoggedAt = new Map<string, number>()

  constructor(deps: Deps) {
    this.#pool = deps.pool
    this.#handlers = deps.handlers
    this.#events = deps.events
    this.#businessClock = deps.businessClock
    this.#realClock = deps.realClock ?? new RealClock()
    this.#batchSize = deps.batchSize ?? 50
    this.#log = deps.log ?? ((message, detail) => console.log(`[worker] ${message}`, detail ?? ''))
  }

  /** 跑一輪。業務現在只在開頭讀一次：同一輪的判斷用同一個時間點。 */
  async runOnce(): Promise<DueWorkSummary> {
    const businessNow = await this.#businessClock.now()
    const summary: DueWorkSummary = { done: 0, waiting: 0, retried: 0, failed: 0 }
    // 同一輪不重複處理同一件（等待中的列 next_attempt_at 已往後推，本來就認領不到；這裡是保險）。
    const seen = new Set<string>()
    for (let i = 0; i < this.#batchSize; i += 1) {
      const outcome = await this.#runOne(businessNow, seen)
      if (outcome === 'empty') break
      summary[outcome] += 1
    }
    return summary
  }

  async #runOne(businessNow: Date, seen: Set<string>): Promise<'empty' | keyof DueWorkSummary> {
    const realNow = this.#realClock.now()
    const client = await this.#pool().connect()
    try {
      await client.query('begin')
      await reachFaultPoint('worker.before-claim')
      const found = await client.query<Row>(
        `select id, kind, subject_type, subject_id, deadline_version, due_business_at, attempts
           from due_work
          where state = 'pending' and due_business_at <= $1
            and (next_attempt_at is null or next_attempt_at <= $2)
            and not (id = any($3::uuid[]))
          order by due_business_at, id
          for update skip locked
          limit 1`,
        [businessNow, realNow, [...seen]],
      )
      const row = found.rows[0]
      if (!row) {
        await client.query('rollback')
        return 'empty'
      }
      seen.add(row.id)
      await reachFaultPoint('worker.after-claim')

      const work: ClaimedDueWork = {
        id: row.id,
        kind: row.kind,
        subject: { type: row.subject_type, id: row.subject_id },
        deadlineVersion: row.deadline_version,
        dueBusinessAt: row.due_business_at,
        attempts: row.attempts,
      }
      const handler = this.#handlers[row.kind]

      if (handler?.mode === 'own_transaction') {
        // 自己開交易的 handler（例如票 13 的提案到期，它會在自己的交易裡把這件工作改成 cancelled）：
        // 先把這件往後推一段持有期再 commit 放鎖，交易外呼叫，之後另開交易寫回——
        // 不然 handler 要改同一列時會卡在我們的 FOR UPDATE 上。持有期內 worker 若崩潰，過了就會被重撿。
        await client.query('update due_work set next_attempt_at = $2 where id = $1', [
          row.id,
          new Date(realNow.getTime() + OWN_TRANSACTION_HOLD_MS),
        ])
        await client.query('commit')

        let result: DueWorkRunResult
        let lastError: string | null = null
        try {
          await reachFaultPoint('worker.before-handler')
          const outcome = await handler.handle(work)
          result = outcome.kind === 'done' ? { kind: 'done', resultRef: outcome.resultRef } : { kind: 'defer' }
          if (outcome.kind === 'defer') this.#log('到期工作前置未就緒，稍後再看', { id: row.id, kind: row.kind, reason: outcome.reason })
        } catch (error) {
          result = { kind: 'error' }
          lastError = errorText(error)
        }

        await client.query('begin')
        const current = await client.query<{ state: string }>('select state from due_work where id = $1 for update', [row.id])
        if (current.rows[0]?.state !== 'pending') {
          // handler 已經自己收尾（例如終止提案時把工作改成 cancelled）：不覆蓋。
          await client.query('commit')
          this.#log('到期工作由處理器自己收尾', { id: row.id, kind: row.kind, state: current.rows[0]?.state })
          return 'done'
        }
        const outcome = await this.#apply(client, row, result, lastError, realNow, businessNow)
        await client.query('commit')
        return outcome
      }

      let result: DueWorkRunResult
      let lastError: string | null = null
      if (!handler) {
        result = { kind: 'unregistered' }
        this.#logUnregistered(row.kind, realNow)
      } else {
        await client.query('savepoint due_work_handler')
        try {
          await reachFaultPoint('worker.before-handler')
          const outcome = await handler.handle(client, work)
          result = outcome.kind === 'done' ? { kind: 'done', resultRef: outcome.resultRef } : { kind: 'defer' }
          if (outcome.kind === 'defer') this.#log('到期工作前置未就緒，稍後再看', { id: row.id, kind: row.kind, reason: outcome.reason })
        } catch (error) {
          await client.query('rollback to savepoint due_work_handler')
          result = { kind: 'error' }
          lastError = errorText(error)
        }
      }

      const outcome = await this.#apply(client, row, result, lastError, realNow, businessNow)
      await client.query('commit')
      return outcome
    } catch (error) {
      await client.query('rollback').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  /** 依生命週期規則寫回狀態（在呼叫端的交易裡；只改仍是 pending 的列）。 */
  async #apply(
    client: PoolClient,
    row: Row,
    result: DueWorkRunResult,
    lastError: string | null,
    realNow: Date,
    businessNow: Date,
  ): Promise<keyof DueWorkSummary> {
    const next = dueWorkTransition(result, row.attempts, realNow)
    if (next.state === 'done') {
      await client.query(
        `update due_work set state = 'done', done_at = $2, result_ref = $3::jsonb, next_attempt_at = null, last_error = null
          where id = $1 and state = 'pending'`,
        [row.id, realNow, JSON.stringify(next.resultRef)],
      )
      this.#log('到期工作完成', { id: row.id, kind: row.kind, subjectId: row.subject_id, deadlineVersion: row.deadline_version })
      return 'done'
    }
    if (next.state === 'pending') {
      await client.query(
        `update due_work set attempts = $2, next_attempt_at = $3, last_error = coalesce($4, last_error)
          where id = $1 and state = 'pending'`,
        [row.id, next.attempts, next.nextAttemptAt, lastError],
      )
      if (lastError) this.#log(`到期工作失敗（第 ${next.attempts} 次），稍後重試`, { id: row.id, kind: row.kind, error: lastError })
      return result.kind === 'error' ? 'retried' : 'waiting'
    }
    await client.query(`update due_work set state = 'failed', attempts = $2, last_error = $3 where id = $1 and state = 'pending'`, [
      row.id,
      next.attempts,
      lastError,
    ])
    this.#log('到期工作失敗 5 次，已停止重試', { id: row.id, kind: row.kind, error: lastError })
    await publishWorkerAlert(client, this.#events, {
      title: '有一件到期工作失敗 5 次，已停止重試',
      source: { type: 'due_work', id: row.id },
      detail: { reason: 'due_work_failed', dueWorkId: row.id, kind: row.kind },
      realAt: realNow,
      businessAt: businessNow,
    })
    return 'failed'
  }

  #logUnregistered(kind: string, realNow: Date) {
    const last = this.#unregisteredLoggedAt.get(kind)
    if (last !== undefined && realNow.getTime() - last < HOUR_MS) return
    this.#unregisteredLoggedAt.set(kind, realNow.getTime())
    this.#log(`到期工作種類 ${kind} 還沒有處理器（後面的票會掛上），保持等待`, { kind })
  }
}

/**
 * `test_noop`：只給測試站驗收到期迴圈（契約 01 §4.7）。什麼都不做，只回 done 並留一行 log。
 * 組裝層只在 `BUSINESS_CLOCK_OVERRIDE_ENABLED=true` 時註冊它；正式站沒有這個 handler。
 */
export function testNoopHandler(log: (message: string, detail?: Record<string, unknown>) => void) {
  return {
    async handle(_tx: PoolClient, work: ClaimedDueWork) {
      log('test_noop 已處理', { id: work.id, subjectId: work.subject.id, deadlineVersion: work.deadlineVersion })
      return { kind: 'done' as const, resultRef: { noop: true } }
    },
  }
}
