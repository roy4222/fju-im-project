import 'server-only'
import type { Pool, PoolClient } from 'pg'
import type { WorkerHealth } from '@/shared/health'

/**
 * 背景工作進程的兩個基礎件：單一實例鎖與心跳（模組實作設計 08 §6；契約 05 §5；ADR 0005）。
 */

/** 正式環境的鎖名。測試會換成自己 schema 的名字：advisory lock 是整個資料庫共用的，不分 schema。 */
export const WORKER_LOCK_NAME = 'fju.worker'

export type WorkerLock = {
  /** 拿著鎖的那條連線；它斷掉＝鎖沒了，進程要自己結束讓 Compose 重啟。 */
  readonly client: PoolClient
  release(): Promise<void>
}

/**
 * 搶單一實例鎖（`pg_try_advisory_lock`，session 層級）。拿不到回 null——另一個 worker 正在跑。
 *
 * 鎖綁在一條專用連線上，進程活多久就拿多久；進程死掉、連線斷掉，PostgreSQL 自動放鎖，
 * 下一個起來的 worker 就拿得到，不會有「鎖卡住沒人能跑」。
 */
export async function acquireWorkerLock(pool: Pick<Pool, 'connect'>, name = WORKER_LOCK_NAME): Promise<WorkerLock | null> {
  const client = await pool.connect()
  try {
    const result = await client.query<{ locked: boolean }>(
      'select pg_try_advisory_lock(hashtextextended($1, 0)) as locked',
      [name],
    )
    if (!result.rows[0]?.locked) {
      client.release()
      return null
    }
  } catch (error) {
    client.release()
    throw error
  }
  let released = false
  return {
    client,
    async release() {
      if (released) return
      released = true
      try {
        await client.query('select pg_advisory_unlock(hashtextextended($1, 0))', [name])
      } finally {
        client.release()
      }
    },
  }
}

/** 心跳（`worker_heartbeat` 固定一列）。`version`＝映像的 commit，部署健康判定拿它跟 tag 比。 */
export async function writeHeartbeat(
  db: Pick<Pool, 'query'>,
  beat: { version: string; tickAt: Date; projectionAt?: Date | null; dueWorkAt?: Date | null },
): Promise<void> {
  await db.query(
    `insert into worker_heartbeat (id, version, last_tick_real_at, last_projection_at, last_due_work_at, updated_at)
     values (1, $1, $2, $3, $4, $2)
     on conflict (id) do update set
       version = excluded.version,
       last_tick_real_at = excluded.last_tick_real_at,
       last_projection_at = coalesce(excluded.last_projection_at, worker_heartbeat.last_projection_at),
       last_due_work_at = coalesce(excluded.last_due_work_at, worker_heartbeat.last_due_work_at),
       updated_at = excluded.updated_at`,
    [beat.version, beat.tickAt, beat.projectionAt ?? null, beat.dueWorkAt ?? null],
  )
}

/** `/api/health` 的 `worker` 欄。worker 從來沒跑過（沒有那一列）回兩個 null。 */
export async function readWorkerHealth(db: Pick<Pool, 'query'>): Promise<WorkerHealth> {
  const rows = await db.query<{ version: string; last_tick_real_at: Date }>(
    'select version, last_tick_real_at from worker_heartbeat where id = 1',
  )
  const row = rows.rows[0]
  if (!row) return { version: null, lastTickAt: null }
  return { version: row.version, lastTickAt: row.last_tick_real_at.toISOString() }
}
