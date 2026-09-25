import 'server-only'
import { measureAndRecordStorage, startWorker } from '@/composition/worker'
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
/**
 * 只量一次磁碟就結束（票 28 故障演練與手動重量用；不拿單一實例鎖、不跑其他迴圈）：
 *
 *   node migrate/web/dist/worker.mjs --measure-storage-once [--path <目錄>] [--drill]
 *
 * `--path` 預設 `FILES_ROOT`；`--drill` 讓這筆量測在畫面上標「演練」（ops/fault-drill.sh disk80 用）。
 */
async function measureOnce(argv: readonly string[]) {
  const pathAt = argv.indexOf('--path')
  const root = pathAt >= 0 ? argv[pathAt + 1] : process.env.FILES_ROOT
  if (!root) throw new Error('沒有 --path，也沒有 FILES_ROOT：不知道要量哪裡')
  const measurement = await measureAndRecordStorage(getPool(), root, undefined, { drill: argv.includes('--drill') })
  console.log(
    `STORAGE_MEASURED used_percent=${measurement.usedPercent} level=${measurement.alertLevel} drill=${measurement.drill}`,
  )
  await getPool().end()
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--measure-storage-once')) {
    await measureOnce(argv)
    return
  }
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
