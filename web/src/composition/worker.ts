import 'server-only'
import os from 'node:os'
import type { Pool, PoolClient } from 'pg'
import { RECONCILE_INTERVAL_SECONDS } from '@/application/accounts'
import type { DueWorkHandlers } from '@/application/notifications'
import { getBusinessClock } from '@/composition/cohorts'
import { businessClockOverrideEnabled, getEventPublisher } from '@/composition/notifications'
import { getAuditWriter } from '@/composition/ops'
import { SqlBanStateGateway } from '@/infrastructure/accounts/ban-state'
import { PgSessionRevocationExecutor } from '@/infrastructure/accounts/session-revocation-executor'
import { getPool } from '@/infrastructure/db/client'
import { PgDueWorkRunner, testNoopHandler } from '@/infrastructure/notifications/pg-due-work-runner'
import { PgNotificationProjector } from '@/infrastructure/notifications/pg-projector'
import {
  acquireWorkerLock,
  WORKER_LOCK_NAME,
  writeHeartbeat,
} from '@/infrastructure/notifications/worker-runtime'

/**
 * 背景工作進程的組裝與迴圈（票 12；模組實作設計 08 §6；契約 05 §5；ADR 0005）。
 *
 * 三個迴圈，都由同一個進程跑，同一時間整個資料庫只有一個進程在跑（advisory lock）：
 * - 投影：每 5 秒把事件投影成通知；每一輪都寫心跳（`/api/health` 的 `worker.lastTickAt`）。
 * - 到期工作：每 30 秒看業務鐘，撿到期的工作交給 handler（目前只有測試站的 `test_noop`）。
 * - 撤 session 收斂：每 5 分鐘回收過期租約、做掉排著的工作、核對停用／恢復是否真的生效。
 *
 * 啟動時三個迴圈都先立刻跑一次：部署的健康判定只等 60 秒，心跳要在那之前出現。
 */

export type WorkerOptions = {
  /** 寫進心跳的版本＝映像的 commit（部署健康判定拿它跟 tag 比）。 */
  version: string
  lockName?: string
  pool?: () => Pool
  projectionIntervalMs?: number
  dueWorkIntervalMs?: number
  reconcileIntervalMs?: number
  /** 拿著鎖的連線斷了：鎖已經不在，進程要結束讓 Compose 重啟（不然可能兩個 worker 同時跑）。 */
  onLockLost?: (error: unknown) => void
  log?: (message: string, detail?: Record<string, unknown>) => void
}

export type RunningWorker = {
  stop(): Promise<void>
}

const defaultLog = (message: string, detail?: Record<string, unknown>) =>
  console.log(`[worker] ${new Date().toISOString()} ${message}`, detail ? JSON.stringify(detail) : '')

/** 測試站才註冊 `test_noop`（契約 01 §4.7）；真實 handler 由後面的票加在這裡。 */
export function dueWorkHandlers(log: WorkerOptions['log'] = defaultLog): DueWorkHandlers<PoolClient> {
  const handlers: DueWorkHandlers<PoolClient> = {}
  if (businessClockOverrideEnabled()) handlers.test_noop = testNoopHandler(log ?? defaultLog)
  // 票 13（PR #249）合併後在這裡接提案到期（它自己開交易、終止時自己把工作改成 cancelled）：
  //   handlers.proposal_expiry = {
  //     mode: 'own_transaction',
  //     handle: async (work) => {
  //       const result = await getProposalExpiryHandler().expire(work.subject.id, work.deadlineVersion)
  //       return result === 'not_due' ? { kind: 'defer', reason: '模擬鐘往回撥，還沒到期' } : { kind: 'done' }
  //     },
  //   }
  return handlers
}

/** 拿到鎖就開始跑並回傳控制把手；拿不到（已有另一個 worker）回 null。 */
export async function startWorker(options: WorkerOptions): Promise<RunningWorker | null> {
  const log = options.log ?? defaultLog
  const poolOf = options.pool ?? getPool
  const pool = poolOf()
  const lock = await acquireWorkerLock(pool, options.lockName ?? WORKER_LOCK_NAME)
  if (!lock) return null

  lock.client.on('error', (error) => {
    log('單一實例鎖的連線斷了', { error: String(error) })
    options.onLockLost?.(error)
  })

  const businessClock = getBusinessClock()
  const events = getEventPublisher()
  const projector = new PgNotificationProjector({ pool: poolOf, events, businessClock, log })
  const dueWork = new PgDueWorkRunner({ pool: poolOf, handlers: dueWorkHandlers(log), events, businessClock, log })
  const revocations = new PgSessionRevocationExecutor({
    pool: poolOf,
    gateway: new SqlBanStateGateway(poolOf),
    audit: getAuditWriter(),
    events,
    businessClock,
    owner: `worker:${os.hostname()}:${process.pid}`,
    log,
  })

  let stopped = false
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const running = new Set<Promise<void>>()

  /** 固定間隔跑一件事：上一輪沒跑完不會疊下一輪；出錯只記 log，下一輪照跑。 */
  function every(name: string, intervalMs: number, body: () => Promise<void>) {
    const tick = async () => {
      if (stopped) return
      const run = body().catch((error: unknown) => log(`${name} 這一輪出錯，下一輪再試`, { error: String(error) }))
      running.add(run)
      await run
      running.delete(run)
      if (stopped) return
      const timer = setTimeout(() => {
        timers.delete(timer)
        void tick()
      }, intervalMs)
      timers.add(timer)
    }
    void tick()
  }

  every('投影', options.projectionIntervalMs ?? 5_000, async () => {
    let projectionAt: Date | null = null
    try {
      const summary = await projector.runOnce()
      projectionAt = new Date()
      if (summary.done + summary.retried + summary.failed > 0) log('投影完成一輪', summary)
    } finally {
      // 心跳代表「迴圈還活著」：投影本身出錯也要寫（出錯的細節在 event_projections 與 log）。
      await writeHeartbeat(pool, { version: options.version, tickAt: new Date(), projectionAt })
    }
  })

  every('到期工作', options.dueWorkIntervalMs ?? 30_000, async () => {
    const summary = await dueWork.runOnce()
    await writeHeartbeat(pool, { version: options.version, tickAt: new Date(), dueWorkAt: new Date() })
    if (summary.done + summary.retried + summary.failed > 0) log('到期工作完成一輪', summary)
  })

  every('撤 session 收斂', options.reconcileIntervalMs ?? RECONCILE_INTERVAL_SECONDS * 1000, async () => {
    const summary = await revocations.periodic()
    if (summary.leasesRecovered + summary.usersRun + summary.reconcileInserted + summary.limits > 0) {
      log('撤 session 收斂完成一輪', summary)
    }
  })

  log('背景工作已啟動（拿到單一實例鎖）', { version: options.version })

  return {
    async stop() {
      stopped = true
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      await Promise.allSettled([...running])
      await lock.release()
      log('背景工作已停止')
    },
  }
}
