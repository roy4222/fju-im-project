import 'server-only'
import { getPool } from '@/infrastructure/db/client'
import { readWorkerHealth } from '@/infrastructure/notifications/worker-runtime'
import { isWorkerStale, type HealthSnapshot } from '@/shared/health'

/**
 * 映像的版本資訊：`version`、`commit`、`imageDigest`（契約 05 §1）。
 *
 * **空字串當成沒設**，回跟沒設一樣的預設值（`0.0.0`、`unknown`、null）：Compose 用 `${IMAGE_DIGEST:-}` 傳進來，
 * 沒部署 digest 時拿到的是空字串；照 `.env.example` 留空也一樣（CL-7 #823 第 11 條）。
 * VM 上 `ops/deploy.sh` 每次都會設 `IMAGE_DIGEST`，`ops/check-health.mjs` 拿它跟部署的 digest 比，那條路行為不變。
 */
export function buildInfo(env: Readonly<Record<string, string | undefined>> = process.env): Pick<HealthSnapshot, 'version' | 'commit' | 'imageDigest'> {
  const read = (name: string) => (env[name] === '' ? undefined : env[name])
  return {
    version: read('APP_VERSION') ?? '0.0.0',
    commit: read('GIT_COMMIT') ?? 'unknown',
    imageDigest: read('IMAGE_DIGEST') ?? null,
  }
}

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
    ...buildInfo(),
    schemaVersion: schema.rows[0]?.value ?? null,
    worker,
  }
}

/** DB 不可用時的回應：ok=false，而且不帶任何連線設定。 */
export function unavailableHealth(): HealthSnapshot {
  return {
    ok: false,
    ...buildInfo(),
    schemaVersion: null,
    worker: { version: null, lastTickAt: null },
  }
}
