import 'server-only'
import { startWorker } from '@/composition/worker'
import { getPool } from '@/infrastructure/db/client'

/**
 * 背景工作進程的進入點（Compose 的 `worker` 服務；票 12）。
 *
 * `scripts/build-worker.mjs` 把這支打包成 `dist/worker.mjs`，映像裡用
 * `node migrate/web/dist/worker.mjs` 跑（依賴從 migrate 的 production node_modules 解析）。
 *
 * - 拿不到單一實例鎖（已經有另一個 worker 在跑）：印一行後結束，不跟它搶。
 * - 拿鎖的連線斷掉：立刻結束（exit 1），讓 Compose 重啟後重新搶鎖。
 * - 收到 SIGTERM／SIGINT（`docker compose stop`）：等這一輪跑完、放鎖後結束。
 */
async function main() {
  const version = process.env.GIT_COMMIT ?? 'unknown'
  const worker = await startWorker({
    version,
    onLockLost: () => process.exit(1),
  })
  if (!worker) {
    console.log('[worker] 另一個背景工作正在跑（拿不到單一實例鎖），這個進程結束。')
    await getPool().end()
    process.exit(0)
  }

  let stopping = false
  const shutdown = async (signal: string) => {
    if (stopping) return
    stopping = true
    console.log(`[worker] 收到 ${signal}，等這一輪跑完後結束。`)
    await worker.stop()
    await getPool().end()
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((error: unknown) => {
  console.error('[worker] 啟動失敗', error)
  process.exit(1)
})
