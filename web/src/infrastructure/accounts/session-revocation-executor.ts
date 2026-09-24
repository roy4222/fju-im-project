import 'server-only'
import { uuidv7 } from 'uuidv7'
import type { Pool, PoolClient } from 'pg'
import {
  expectedBannedFor,
  nextReconcileRound,
  reachesReconcileLimit,
  RECONCILE_RECENT_HOURS,
  RECONCILE_ROUND_LIMIT,
  RECONCILE_UNKNOWN_OUTCOME_DAYS,
  REVOCATION_CALL_TIMEOUT_MS,
  REVOCATION_LEASE_SECONDS,
  revocationKindFor,
  revocationTargetOf,
  type AccountStatus,
  type ReconcileReason,
  type RevocationTargetStatus,
} from '@/application/accounts'
import type { BusinessClockSource } from '@/application/cohorts'
import type { EventPublisher } from '@/application/notifications'
import type { AuditWriter } from '@/application/ops'
import type { BanStateGateway } from '@/infrastructure/accounts/ban-state'
import { readBanned } from '@/infrastructure/accounts/ban-state'
import { errorText } from '@/infrastructure/notifications/pg-projector'
import { publishWorkerAlert } from '@/infrastructure/notifications/worker-alerts'
import { reachFaultPoint } from '@/shared/fault-points'
import { RealClock, type Clock } from '@/shared/time'

/**
 * `SessionRevocationExecutor`（模組實作設計 01 附錄 A `session_revocations` v2.4，規則 2–5）。
 *
 * 所有「把 Better Auth 的 banned／session 拉到跟 `users.status` 一致」的動作都經 `runForUser`：
 * 停用、恢復用例 commit 後的立即呼叫（票 9 接上）、背景工作的週期核對（本票）、管理端重試（後續），沒有第二條路。
 *
 * - 規則 2 認領（短交易）：鎖該使用者未結的列；租約還有效就不做事；過期的標 failed（`lease_expired`、
 *   `outcome_unknown`）；只留最新的 queued（其餘 cancelled `superseded_by_event`）；它指的狀態事件不是最新的就
 *   cancelled `status_mismatch`；否則標 executing、寫租約，並用**認領當下**的 `users.status` 覆寫目標與種類。
 * - 規則 3 執行（交易外）：依目標寫 Better Auth 狀態，逾時 10 秒。
 * - 規則 4 完成（短交易）：只有仍是 executing 而且租約還是自己的，才寫 done／failed（否則結果丟棄）；
 *   接著有新的 queued 就在同一次呼叫繼續（保證後到的事件在前一次回傳之後才執行），沒有就做完成後核對。
 * - 規則 5 收斂核對：沒有未結的列時比對 `users.status` 與 `banned`，不一致就插一筆收斂工作
 *   （每人同時最多一筆，靠部分唯一鍵③＋`ON CONFLICT DO NOTHING`）；自動輪次到 10 直接 failed
 *   `RECONCILE_LIMIT`＋稽核＋告警，之後同一個狀態事件不再自動插入。
 *
 * 背景工作每 5 分鐘呼叫 `periodic()`：先回收過期租約、再把排著的工作做掉、最後對觀察集合做核對。
 */

type OpenRow = {
  id: string
  status_event_id: string
  state: 'queued' | 'executing'
  lease_expires_at: Date | null
  requested_real_at: Date
}

type Claimed = { id: string; target: RevocationTargetStatus }

export type ClaimResult =
  | { readonly kind: 'claimed'; readonly job: Claimed }
  | { readonly kind: 'busy' }
  | { readonly kind: 'none' }
  | { readonly kind: 'cancelled' }

export type ReconcileResult = 'busy' | 'consistent' | 'skipped' | 'limit_reached' | 'inserted' | 'limit' | 'already_queued'

export type RunSummary = { executed: number; failed: number; reconcileInserted: number }

export type PeriodicSummary = {
  leasesRecovered: number
  usersRun: number
  checked: number
  reconcileInserted: number
  limits: number
}

type Deps = {
  pool: () => Pick<Pool, 'connect' | 'query'>
  gateway: BanStateGateway
  audit: AuditWriter<PoolClient>
  events: EventPublisher<PoolClient>
  businessClock: BusinessClockSource
  /** 執行者識別（`lease_owner`），例如 `worker:<hostname>:<pid>`。 */
  owner: string
  realClock?: Clock
  leaseSeconds?: number
  callTimeoutMs?: number
  log?: (message: string, detail?: Record<string, unknown>) => void
}

/** 同一次 `runForUser` 最多連續處理幾筆（防呆：正常情況 2–3 筆就結束）。 */
const MAX_STEPS_PER_RUN = RECONCILE_ROUND_LIMIT + 5

export class PgSessionRevocationExecutor {
  readonly #pool: () => Pick<Pool, 'connect' | 'query'>
  readonly #gateway: BanStateGateway
  readonly #audit: AuditWriter<PoolClient>
  readonly #events: EventPublisher<PoolClient>
  readonly #businessClock: BusinessClockSource
  readonly #owner: string
  readonly #realClock: Clock
  readonly #leaseSeconds: number
  readonly #callTimeoutMs: number
  readonly #log: (message: string, detail?: Record<string, unknown>) => void

  constructor(deps: Deps) {
    this.#pool = deps.pool
    this.#gateway = deps.gateway
    this.#audit = deps.audit
    this.#events = deps.events
    this.#businessClock = deps.businessClock
    this.#owner = deps.owner
    this.#realClock = deps.realClock ?? new RealClock()
    this.#leaseSeconds = deps.leaseSeconds ?? REVOCATION_LEASE_SECONDS
    this.#callTimeoutMs = deps.callTimeoutMs ?? REVOCATION_CALL_TIMEOUT_MS
    this.#log = deps.log ?? ((message, detail) => console.log(`[worker] ${message}`, detail ?? ''))
  }

  get owner(): string {
    return this.#owner
  }

  /** 規則 2–5：把這個人排著的工作依序做完，最後做一次完成後核對。 */
  async runForUser(userId: string): Promise<RunSummary> {
    const summary: RunSummary = { executed: 0, failed: 0, reconcileInserted: 0 }
    /**
     * 最後一次外部呼叫有沒有成功回傳。完成後核對只在「成功」之後做：外部呼叫失敗時若立刻核對、
     * 立刻插收斂工作再呼叫一次，Better Auth 持續掛掉時一次呼叫就會把 10 輪收斂額度燒完。
     * 失敗的列留給背景工作每 5 分鐘的週期核對（規則 5 的觀察期就是為這個設計的）。
     */
    let lastSucceeded = false
    for (let step = 0; step < MAX_STEPS_PER_RUN; step += 1) {
      const claim = await this.claim(userId)
      if (claim.kind === 'busy' || claim.kind === 'cancelled') return summary
      if (claim.kind === 'none') {
        if (!lastSucceeded) return summary
        const reconciled = await this.reconcile(userId, 'after_completion')
        if (reconciled !== 'inserted') return summary
        summary.reconcileInserted += 1
        lastSucceeded = false
        continue
      }

      const succeeded = await this.#execute(userId, claim.job)
      const recorded = await this.complete(claim.job.id, succeeded)
      if (recorded) {
        if (succeeded.ok) summary.executed += 1
        else summary.failed += 1
      }
      lastSucceeded = recorded && succeeded.ok
    }
    this.#log('撤 session 工作在一次呼叫裡處理太多筆，先停下，下一輪再看', { userId })
    return summary
  }

  /** 規則 2（認領，短交易）。公開是為了讓測試能一步一步驗（租約、fencing）。 */
  async claim(userId: string): Promise<ClaimResult> {
    return this.#tx(async (tx) => {
      const open = await tx.query<OpenRow>(
        `select id, status_event_id, state, lease_expires_at, requested_real_at
           from session_revocations
          where user_id = $1 and state in ('queued', 'executing')
          order by requested_real_at, id
          for update`,
        [userId],
      )
      const now = this.#realClock.now()

      for (const row of open.rows.filter((r) => r.state === 'executing')) {
        if (row.lease_expires_at && row.lease_expires_at > now) return { kind: 'busy' }
        await this.#expireLease(tx, row.id, now)
      }

      const queued = open.rows.filter((r) => r.state === 'queued')
      const latest = queued.at(-1)
      if (!latest) return { kind: 'none' }
      for (const older of queued.slice(0, -1)) {
        await this.#cancel(tx, older.id, 'superseded_by_event', now)
      }

      const latestEvent = await latestStatusEventId(tx, userId)
      const status = await accountStatusOf(tx, userId)
      const target = status ? revocationTargetOf(status) : null
      if (latest.status_event_id !== latestEvent || !target) {
        await this.#cancel(tx, latest.id, 'status_mismatch', now)
        return { kind: 'cancelled' }
      }

      await tx.query(
        `update session_revocations
            set state = 'executing', lease_owner = $2, lease_expires_at = $3,
                expected_user_status = $4, kind = $5,
                revision = revision + 1, updated_at = $6
          where id = $1`,
        [latest.id, this.#owner, new Date(now.getTime() + this.#leaseSeconds * 1000), target, revocationKindFor(target), now],
      )
      return { kind: 'claimed', job: { id: latest.id, target } }
    })
  }

  /** 規則 4（完成，短交易）：租約已被接手（不是自己的）就丟棄結果，回 false。 */
  async complete(jobId: string, result: { ok: true } | { ok: false; error: string }): Promise<boolean> {
    return this.#tx(async (tx) => {
      const found = await tx.query<{ state: string; lease_owner: string | null }>(
        'select state, lease_owner from session_revocations where id = $1 for update',
        [jobId],
      )
      const row = found.rows[0]
      if (!row || row.state !== 'executing' || row.lease_owner !== this.#owner) {
        this.#log('撤 session 工作的租約已被接手，這次的結果丟棄', { jobId })
        return false
      }
      const now = this.#realClock.now()
      if (result.ok) {
        await tx.query(
          `update session_revocations set state = 'done', completed_real_at = $2, last_error = null,
                  revision = revision + 1, updated_at = $2
            where id = $1`,
          [jobId, now],
        )
      } else {
        await tx.query(
          `update session_revocations set state = 'failed', outcome_unknown = true, completed_real_at = $2,
                  last_error = $3, revision = revision + 1, updated_at = $2
            where id = $1`,
          [jobId, now, result.error],
        )
      }
      return true
    })
  }

  /** 規則 5（收斂核對，短交易）。 */
  async reconcile(userId: string, reason: ReconcileReason): Promise<ReconcileResult> {
    return this.#tx(async (tx) => {
      const rows = await tx.query<{
        id: string
        state: string
        trigger: string
        status_event_id: string
        reconcile_reason: string | null
        reconcile_round: number
        last_error: string | null
        completed_real_at: Date | null
        requested_real_at: Date
      }>(
        `select id, state, trigger, status_event_id, reconcile_reason, reconcile_round, last_error,
                completed_real_at, requested_real_at
           from session_revocations where user_id = $1
          order by requested_real_at, id
          for update`,
        [userId],
      )
      if (rows.rows.some((r) => r.state === 'queued' || r.state === 'executing')) return 'busy'

      const status = await accountStatusOf(tx, userId)
      const expected = status ? expectedBannedFor(status) : null
      if (expected === null || !status) return 'skipped'
      if ((await readBanned(tx, userId)) === expected) return 'consistent'

      const latestEvent = await latestStatusEventId(tx, userId)
      const terminal = rows.rows
        .filter((r) => r.state === 'done' || r.state === 'failed')
        .sort((a, b) => (a.completed_real_at?.getTime() ?? 0) - (b.completed_real_at?.getTime() ?? 0))
        .at(-1)
      // 收斂工作一定要指向某個狀態事件與某筆終態列（CHECK 與 FK）；兩者缺一就沒有東西可以收斂。
      if (!latestEvent || !terminal) return 'skipped'

      const sameEvent = rows.rows.filter((r) => r.trigger === 'reconcile' && r.status_event_id === latestEvent)
      if (reason !== 'manual_retry' && sameEvent.some((r) => r.last_error === 'RECONCILE_LIMIT')) return 'limit_reached'

      const previous = reason === 'manual_retry' ? sameEvent : sameEvent.filter((r) => r.reconcile_reason !== 'manual_retry')
      const previousRound = previous.length ? Math.max(...previous.map((r) => r.reconcile_round)) : null
      const round = nextReconcileRound(previousRound, reason)
      const limit = reachesReconcileLimit(round, reason)
      const target = revocationTargetOf(status)!
      const now = this.#realClock.now()

      const inserted = await tx.query(
        `insert into session_revocations
           (id, user_id, status_event_id, trigger, reconcile_reason, reconcile_of_id, reconcile_round,
            kind, state, expected_user_status, last_error, requested_real_at, completed_real_at, created_at, updated_at)
         values ($1, $2, $3, 'reconcile', $4, $5, $6, $7, $8, $9, $10, $11, $12, $11, $11)
         on conflict do nothing`,
        [
          uuidv7(),
          userId,
          latestEvent,
          reason,
          terminal.id,
          round,
          revocationKindFor(target),
          limit ? 'failed' : 'queued',
          target,
          limit ? 'RECONCILE_LIMIT' : null,
          now,
          limit ? now : null,
        ],
      )
      if ((inserted.rowCount ?? 0) === 0) return 'already_queued'

      if (!limit) {
        this.#log('撤 session 狀態與帳號狀態不一致，排入收斂工作', { userId, reason, round })
        return 'inserted'
      }

      const businessAt = await this.#businessClock.now()
      await this.#audit.append(tx, {
        actorKind: 'worker',
        action: 'account.session_revocation.reconcile_limit',
        targetType: 'user',
        targetId: userId,
        scope: 'global',
        realAt: now,
        businessAt,
        payload: { statusEventId: latestEvent, round, expectedUserStatus: target },
      })
      await publishWorkerAlert(tx, this.#events, {
        title: '有一個帳號的停用／恢復自動核對 10 次仍不一致，需要人工處理',
        source: { type: 'user', id: userId },
        detail: { reason: 'session_reconcile_limit', userId, statusEventId: latestEvent },
        realAt: now,
        businessAt,
      })
      this.#log('撤 session 自動收斂到上限，已告警', { userId, round })
      return 'limit'
    })
  }

  /** 過期回收：租約到期還在 executing 的列一律標 failed（外部結果未知）。回傳回收的使用者。 */
  async recoverExpiredLeases(): Promise<string[]> {
    return this.#tx(async (tx) => {
      const now = this.#realClock.now()
      const rows = await tx.query<{ user_id: string }>(
        `update session_revocations
            set state = 'failed', cancel_reason = 'lease_expired', outcome_unknown = true,
                completed_real_at = $1, revision = revision + 1, updated_at = $1
          where state = 'executing' and lease_expires_at < $1
          returning user_id`,
        [now],
      )
      return [...new Set(rows.rows.map((r) => r.user_id))]
    })
  }

  /** 背景工作每 5 分鐘一次（規則 5「時機與觀察集合」）。 */
  async periodic(): Promise<PeriodicSummary> {
    const summary: PeriodicSummary = { leasesRecovered: 0, usersRun: 0, checked: 0, reconcileInserted: 0, limits: 0 }
    const recovered = await this.recoverExpiredLeases()
    summary.leasesRecovered = recovered.length
    if (recovered.length) this.#log('回收了過期的撤 session 租約', { users: recovered.length })

    // 排著沒人做的工作（例如用例 commit 後的立即呼叫沒跑成）先做掉。
    const now = this.#realClock.now()
    const backlog = await this.#pool().query<{ user_id: string }>(
      `select distinct user_id from session_revocations where state = 'queued'`,
    )
    for (const { user_id } of backlog.rows) {
      await this.runForUser(user_id)
      summary.usersRun += 1
    }

    const observed = await this.#pool().query<{ user_id: string }>(
      `select distinct user_id from session_revocations
        where greatest(requested_real_at, updated_at) >= $1
           or (outcome_unknown and greatest(requested_real_at, updated_at) >= $2)`,
      [
        new Date(now.getTime() - RECONCILE_RECENT_HOURS * 3600 * 1000),
        new Date(now.getTime() - RECONCILE_UNKNOWN_OUTCOME_DAYS * 24 * 3600 * 1000),
      ],
    )
    for (const { user_id } of observed.rows) {
      summary.checked += 1
      const result = await this.reconcile(user_id, 'periodic')
      if (result === 'limit') summary.limits += 1
      if (result === 'inserted') {
        summary.reconcileInserted += 1
        await this.runForUser(user_id)
      }
    }
    return summary
  }

  async #execute(userId: string, job: Claimed): Promise<{ ok: true } | { ok: false; error: string }> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await reachFaultPoint('revocation.before-call')
      await Promise.race([
        this.#gateway.apply(userId, job.target),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`外部呼叫超過 ${this.#callTimeoutMs}ms`)), this.#callTimeoutMs)
        }),
      ])
      return { ok: true }
    } catch (error) {
      this.#log('撤 session 的外部呼叫失敗', { userId, jobId: job.id, error: errorText(error) })
      return { ok: false, error: errorText(error) }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async #expireLease(tx: PoolClient, id: string, now: Date) {
    await tx.query(
      `update session_revocations
          set state = 'failed', cancel_reason = 'lease_expired', outcome_unknown = true,
              completed_real_at = $2, revision = revision + 1, updated_at = $2
        where id = $1`,
      [id, now],
    )
  }

  async #cancel(tx: PoolClient, id: string, reason: 'superseded_by_event' | 'status_mismatch', now: Date) {
    await tx.query(
      `update session_revocations
          set state = 'cancelled', cancel_reason = $2, completed_real_at = $3, revision = revision + 1, updated_at = $3
        where id = $1`,
      [id, reason, now],
    )
  }

  async #tx<T>(body: (tx: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.#pool().connect()
    try {
      await client.query('begin')
      const result = await body(client)
      await client.query('commit')
      return result
    } catch (error) {
      await client.query('rollback').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }
}

async function latestStatusEventId(tx: Pick<PoolClient, 'query'>, userId: string): Promise<string | null> {
  const rows = await tx.query<{ id: string }>(
    'select id from user_status_events where user_id = $1 order by real_at desc, id desc limit 1',
    [userId],
  )
  return rows.rows[0]?.id ?? null
}

/** 業務狀態只看 `users.status`；去識別化過的帳號一律當成 deidentified（同 `account-state.ts`）。 */
async function accountStatusOf(tx: Pick<PoolClient, 'query'>, userId: string): Promise<AccountStatus | null> {
  const rows = await tx.query<{ status: AccountStatus; deidentified_at: Date | null }>(
    'select status, deidentified_at from users where id = $1',
    [userId],
  )
  const row = rows.rows[0]
  if (!row) return null
  return row.deidentified_at ? 'deidentified' : row.status
}
