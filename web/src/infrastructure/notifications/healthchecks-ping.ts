import 'server-only'

/**
 * Healthchecks.io 打卡（⑤-06；設計方案 §5.3）：worker 每 5 分鐘打一次，過了寬限沒收到就由
 * Healthchecks.io 通知 Discord。只有拿到單一實例鎖的 worker 會跑到這裡（`startWorker` 拿不到鎖就不起迴圈）。
 *
 * - 網址從 `HEALTHCHECKS_WORKER_URL` 來（Doppler → `docker-compose.vm.yml` 只轉交給 worker）；
 *   沒設或空字串 → 不打。本機、CI 都走這條。
 * - 網址等同密碼：log 不印網址。
 * - 打不出去（網路、逾時、非 2xx）只記一行 log，不丟錯：打卡失敗不該影響 worker 本身。
 */

export type HealthchecksPingResult = 'sent' | 'skipped' | 'failed'

export type HealthchecksPingDeps = {
  url: string | undefined
  fetch?: typeof fetch
  log: (message: string, detail?: Record<string, unknown>) => void
  timeoutMs?: number
}

export async function pingHealthchecks(deps: HealthchecksPingDeps): Promise<HealthchecksPingResult> {
  const url = deps.url?.trim()
  if (!url) return 'skipped'
  const fetchImpl = deps.fetch ?? fetch
  try {
    const response = await fetchImpl(url, { method: 'GET', signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000) })
    if (!response.ok) {
      deps.log('Healthchecks.io 打卡失敗', { status: response.status })
      return 'failed'
    }
    return 'sent'
  } catch (error) {
    deps.log('Healthchecks.io 打卡失敗', { error: String(error).replaceAll(url, '（網址）') })
    return 'failed'
  }
}
