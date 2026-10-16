/**
 * 總覽一次請求要讀的檔（DV 設計方案 §8.3）：`loadGateInput` 的六個檔＋最新一夜 run／summary，再加 metrics、collector，共 10 次。
 * 各區塊只吃這裡讀好的物件，不准自己再 `readData`（AC-DV-30 數 readFile）。
 */
import { dataOrNull, readData } from '@/lib/data/read'
import { loadGateInput } from '@/lib/gate/load'

import type { OverviewData } from './overview'

export async function loadOverview(env?: NodeJS.ProcessEnv): Promise<OverviewData> {
  const [gate, metrics, collector] = await Promise.all([
    loadGateInput(env),
    readData('metrics.json', env).then(dataOrNull),
    readData('collector.json', env).then(dataOrNull),
  ])
  return { gate, metrics, collector }
}
