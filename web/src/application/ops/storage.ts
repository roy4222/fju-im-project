/**
 * 磁碟用量的純規則（票 28；模組 10 附錄 A `storage_stats`；SOP 05 步驟 2；契約 05 §8 v2.5）。
 *
 * 背景工作每小時量一次檔案存放區（`FILES_ROOT`）所在的檔案系統，寫一筆量測；
 * 系辦首頁「儲存與備份」磚顯示最新一筆的用量與等級。**只看站內、不推播**（D-04、C23）：
 * 到 80% 不發站內通知、不發外部告警，只在畫面上標「警戒」。
 */

/** 等級（與 `storage_stats.alert_level` 的 CHECK 同一組字：之後補表時直接照抄）。 */
export type StorageAlertLevel = 'ok' | 'warn80' | 'critical'

/** 警戒線：用量 ≥ 80%。 */
export const STORAGE_WARN_PERCENT = 80
/** 危險線：用量 ≥ 90%。 */
export const STORAGE_CRITICAL_PERCENT = 90

/** 背景工作多久量一次（每小時）。 */
export const STORAGE_MEASURE_INTERVAL_MS = 60 * 60 * 1000

/** 最新一筆超過這麼久（三個量測週期）就提示「量測過期」：多半是背景工作停了。 */
export const STORAGE_STALE_AFTER_MS = 3 * STORAGE_MEASURE_INTERVAL_MS

/** 一次量測的結果。位元組都是整數；`usedPercent` 取到小數一位。 */
export type StorageMeasurement = {
  readonly measuredRealAt: Date
  /** 量的是哪個目錄所在的檔案系統（容器內路徑）。 */
  readonly path: string
  /** 檔案系統總容量、已用、一般使用者還能用的空間（同 `df` 的 Size／Used／Avail）。 */
  readonly totalBytes: number
  readonly usedBytes: number
  readonly freeBytes: number
  readonly usedPercent: number
  /** `FILES_ROOT/files`（正式檔）與 `FILES_ROOT/tmp`（上傳暫存）各佔多少。 */
  readonly filesBytes: number
  readonly tmpBytes: number
  /** 資料庫大小（`pg_database_size`）。資料庫 volume 不在 worker 容器裡，量不到它那顆磁碟的剩餘空間。 */
  readonly dbBytes: number | null
  readonly alertLevel: StorageAlertLevel
  /** 故障演練寫的量測（`--label drill`）：畫面會標「演練」，下一次正常量測就蓋過去。 */
  readonly drill: boolean
}

/** 用量百分比對到等級。 */
export function storageAlertLevel(usedPercent: number): StorageAlertLevel {
  if (usedPercent >= STORAGE_CRITICAL_PERCENT) return 'critical'
  if (usedPercent >= STORAGE_WARN_PERCENT) return 'warn80'
  return 'ok'
}

/**
 * 從 statfs 的區塊數算出 `df` 那三個數字。
 *
 * 跟 `df` 一樣：已用＝總區塊－空閒區塊；百分比的分母是「已用＋一般使用者可用」，
 * 不含只保留給 root 的那 5%——所以 root 保留區被吃掉時百分比會超過 100，照實回報。
 */
export function usageFromStatfs(stat: { bsize: number; blocks: number; bfree: number; bavail: number }): {
  totalBytes: number
  usedBytes: number
  freeBytes: number
  usedPercent: number
} {
  const totalBytes = stat.blocks * stat.bsize
  const usedBytes = (stat.blocks - stat.bfree) * stat.bsize
  const freeBytes = stat.bavail * stat.bsize
  const denominator = usedBytes + freeBytes
  const usedPercent = denominator > 0 ? Math.round((usedBytes / denominator) * 1000) / 10 : 0
  return { totalBytes, usedBytes, freeBytes, usedPercent }
}

/** 等級的中文（畫面與 log 用）。 */
export function storageAlertLabel(level: StorageAlertLevel): string {
  switch (level) {
    case 'ok':
      return '正常'
    case 'warn80':
      return '警戒（≥80%）'
    case 'critical':
      return '危險（≥90%）'
  }
}

/** 最新一筆是不是太舊了（背景工作可能停了）。 */
export function isStorageMeasurementStale(measuredRealAt: Date, now: Date): boolean {
  return now.getTime() - measuredRealAt.getTime() > STORAGE_STALE_AFTER_MS
}

/**
 * 系辦首頁「儲存與備份」磚的兩行字。`measuredAtText` 由畫面層依時區格式化好再傳進來。
 * 等級寫在說明的最前面（顏色只留系網橘一個主軸，警戒靠字）。
 */
export function storageTileText(
  m: StorageMeasurement | null,
  now: Date,
  measuredAtText: string,
): { value: string; hint: string } {
  if (!m) return { value: '—', hint: '還沒有量測（背景工作啟動後會先量一次，之後每小時一次）' }
  const parts = [
    storageAlertLabel(m.alertLevel),
    `已用 ${formatGiB(m.usedBytes)}／${formatGiB(m.usedBytes + m.freeBytes)}`,
    `${measuredAtText} 量測${m.drill ? '（故障演練）' : ''}`,
  ]
  if (isStorageMeasurementStale(m.measuredRealAt, now)) parts.push('量測過期：背景工作可能停了')
  return { value: `${m.usedPercent}%`, hint: parts.join('・') }
}

/** GiB，取到小數一位（磚上的數字）。 */
export function formatGiB(bytes: number): string {
  return `${Math.round((bytes / 1024 ** 3) * 10) / 10} GiB`
}
