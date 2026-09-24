import 'server-only'
import { getPool } from '@/infrastructure/db/client'
import { readWorkerHealth } from '@/infrastructure/notifications/worker-runtime'
import { isWorkerStale, type HealthSnapshot } from '@/shared/health'

/**
 * 組出 `/api/health` 的回應（契約 05 §1、§3、§5）。
 *
 * `version`、`commit`、`imageDigest` 在 build 時由環境變數注入（Dockerfile 的 ARG）。
 * `schemaVersion` 每次請求讀 `schema_meta`——這是「這個容器連到的資料庫真的升到哪一版」，
 * 不能快取，`deploy.sh` 靠它判斷 migrate 有沒有生效。
 * `worker` 讀背景工作的心跳（票 12）：`version` 是 worker 映像的 commit、`lastTickAt` 是最後一次心跳。
 * 心跳有過、之後超過 5 分鐘沒更新＝worker 停擺，`ok` 變 false（回 503）。
 */
export async function readHealth(now: Date = new Date()): Promise<HealthSnapshot> {
  const pool = getPool()
  const [schema, worker] = await Promise.all([
    pool.query<{ value: string }>("select value from schema_meta where key = 'schema_version'"),
    readWorkerHealth(pool),
  ])
  // 鍵的順序照契約 05 §1 寫，讓人直接對照。
  return {
    ok: !isWorkerStale(worker, now),
    version: process.env.APP_VERSION ?? '0.0.0',
    commit: process.env.GIT_COMMIT ?? 'unknown',
    imageDigest: process.env.IMAGE_DIGEST ?? null,
    schemaVersion: schema.rows[0]?.value ?? null,
    worker,
  }
}

/** DB 不可用時的回應：ok=false，而且不帶任何連線設定。 */
export function unavailableHealth(): HealthSnapshot {
  return {
    ok: false,
    version: process.env.APP_VERSION ?? '0.0.0',
    commit: process.env.GIT_COMMIT ?? 'unknown',
    imageDigest: process.env.IMAGE_DIGEST ?? null,
    schemaVersion: null,
    worker: { version: null, lastTickAt: null },
  }
}
