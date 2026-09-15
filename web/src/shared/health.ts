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
