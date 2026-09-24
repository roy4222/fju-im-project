/**
 * `/api/health` 的回應形狀（契約 05 §1、§3）。
 *
 * 欄位名要與契約逐字一致：`deploy.sh` 的健康判定會比對 `commit`、`imageDigest`、
 * `schemaVersion`、`worker.version`、`worker.lastTickAt`。改這裡等於改部署判定。
 */
export type WorkerHealth = {
  version: string | null
  lastTickAt: string | null
}

export type HealthSnapshot = {
  ok: boolean
  version: string
  commit: string
  imageDigest: string | null
  schemaVersion: string | null
  worker: WorkerHealth
}

/** 背景工作的心跳超過這麼久沒更新就算停擺（契約 05 §5「超過 5 分鐘視為不健康」）。 */
export const WORKER_STALE_AFTER_MS = 5 * 60 * 1000

/**
 * 背景工作是不是停擺了。
 *
 * 從來沒有心跳（`lastTickAt` 是 null）不算停擺：那是還沒部署 worker 的環境（本機只起 app），
 * 部署時的 `--expect-worker` 判定會另外要求心跳存在。有過心跳、之後超過 5 分鐘沒更新，才是「停掉了」。
 */
export function isWorkerStale(worker: WorkerHealth, now: Date): boolean {
  if (!worker.lastTickAt) return false
  const at = Date.parse(worker.lastTickAt)
  if (!Number.isFinite(at)) return true
  return now.getTime() - at > WORKER_STALE_AFTER_MS
}
