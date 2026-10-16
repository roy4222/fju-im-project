/**
 * 備份與儲存頁（DV 設計方案 §5.4）要畫的東西。純函式：吃 vm.json 與「現在」，回畫面直接用的資料。
 * 兩站備份與主機儲存的正本在這頁（§2）；總覽 KPI、G4 卡只放結論。
 */
import type { BackupInfo, DiskUsage, IsoTime, Site, VmData } from '@/lib/data/types'
import { evaluateBackup } from '@/lib/gate/gates'
import type { GateResult } from '@/lib/gate/types'

/** 主機儲存的兩條門檻線：超過 80% 要清，90% 會影響備份（跟系辦原磚、模組 10 的告警一致）。 */
export const THRESHOLDS = [80, 90] as const

export type BackupState = 'green' | 'red' | 'grey'
export type DiskState = 'green' | 'yellow' | 'red' | 'grey'

export type BackupSiteView = {
  state: BackupState
  /** 「成功」「失敗」「0 bytes」「沒有」「沒有資料」 */
  label: string
  /** 最近一次備份的時間（紀錄時間，沒有紀錄才用異地檔時間） */
  at: IsoTime | null
  /** 最近一次備份的大小；失敗那次沒有檔就是 null */
  bytes: number | null
  /** 錯誤欄：為什麼不算成功；成功是 null */
  error: string | null
  /**
   * 最近一次不成功時另列「上次成功」（失敗不覆蓋成功時間）。
   * `'never'`＝collector 說從沒成功過；null＝不用列（最近一次就是成功，或舊版 collector 沒寫這欄）。
   */
  lastOk: { at: IsoTime; bytes: number | null } | 'never' | null
  /**
   * 異地：有檔就列最新檔；collector 有寫 `offsiteDir` 但沒有檔，就列目錄狀態（不存在／空的）。
   * null＝舊版 collector 沒寫 `offsiteDir` 也沒有檔，不畫。
   */
  offsite: OffsiteView | null
}

export type OffsiteView = { status: 'ok'; name: string; bytes: number; mtime: IsoTime } | { status: 'missing' | 'empty' }

/** collector 有寫、`types.ts` 的 `BackupInfo` 還沒列的欄位（`collector/lib/vm.mjs`、`shapes.mjs`）。 */
type BackupInfoRead = BackupInfo & { offsiteDir?: 'missing' | 'ok' | 'empty' }

export type DiskView = {
  state: DiskState
  /** 0～100；從沒量成功是 null */
  percent: number | null
  usedBytes: number | null
  availBytes: number | null
  totalBytes: number | null
  path: string | null
  checkedAt: IsoTime | null
  /** 本輪 statfs 失敗的分類文字；不是 null 時上面的數字是上次成功值 */
  error: string | null
}

export type BackupView = {
  sites: Record<Site, BackupSiteView>
  disk: DiskView
  /** G4 的判定（同 `/go-live`） */
  gate: GateResult
}

const NO_DATA: BackupSiteView = { state: 'grey', label: '沒有資料', at: null, bytes: null, error: null, lastOk: null, offsite: null }

function offsiteView(b: BackupInfoRead | null | undefined): OffsiteView | null {
  const file = b?.latest ?? null
  if (file) return { status: 'ok', name: file.name, bytes: file.bytes, mtime: file.mtime }
  return b?.offsiteDir === 'missing' || b?.offsiteDir === 'empty' ? { status: b.offsiteDir } : null
}

export function backupSiteView(b: BackupInfoRead | null | undefined): BackupSiteView {
  const file = b?.latest ?? null
  const record = b?.lastRecord ?? null
  const offsite = offsiteView(b)
  const lastOk = b?.lastOk === undefined ? null : b.lastOk === null ? ('never' as const) : b.lastOk
  const at = record?.at ?? file?.mtime ?? null

  if (!record && !file) return { state: 'red', label: '沒有', at: null, bytes: null, error: '還沒有任何備份', lastOk, offsite }
  if (record && !record.ok) {
    // 失敗那次留下的檔通常是 0 bytes；異地最新檔有大小時，那是更早一次成功的檔，不是這次的大小。
    const zero = file?.bytes === 0
    return {
      state: 'red',
      label: zero ? '0 bytes' : '失敗',
      at,
      bytes: zero ? 0 : null,
      error: zero ? `備份檔 ${file.name} 是 0 bytes` : '最近一次備份紀錄是失敗',
      lastOk,
      offsite,
    }
  }
  if (file && !(file.bytes > 0)) {
    return { state: 'red', label: '0 bytes', at, bytes: 0, error: `備份檔 ${file.name} 是 0 bytes`, lastOk, offsite }
  }
  // 大小要跟時間是同一筆：有紀錄就用同一筆成功紀錄的 lastOk.bytes（異地可能還沒同步到這次的檔）；
  // 舊版 collector 沒有 lastOk 時不知道這次多大，寧可顯示「—」也不拿異地舊檔充數。沒有紀錄只有檔才用檔的大小。
  const bytes = !record ? (file?.bytes ?? null) : b?.lastOk && b.lastOk.at === record.at ? b.lastOk.bytes : null
  return { state: 'green', label: '成功', at, bytes, error: null, lastOk: null, offsite }
}

export function diskView(disk: DiskUsage | null | undefined, error: string | null | undefined): DiskView {
  const err = error ?? null
  if (!disk) {
    return { state: 'grey', percent: null, usedBytes: null, availBytes: null, totalBytes: null, path: null, checkedAt: null, error: err }
  }
  const percent = Math.min(100, Math.max(0, Math.round(disk.percent)))
  const state: DiskState = err ? 'grey' : percent >= THRESHOLDS[1] ? 'red' : percent >= THRESHOLDS[0] ? 'yellow' : 'green'
  return {
    state,
    percent,
    usedBytes: disk.usedBytes,
    availBytes: disk.availBytes,
    totalBytes: disk.totalBytes,
    path: disk.path,
    checkedAt: disk.checkedAt,
    error: err,
  }
}

export function buildBackupView(vm: VmData | null, now: Date): BackupView {
  return {
    sites: {
      test: vm ? backupSiteView(vm.backups?.test) : NO_DATA,
      prod: vm ? backupSiteView(vm.backups?.prod) : NO_DATA,
    },
    disk: diskView(vm?.disk, vm?.diskError),
    gate: evaluateBackup(vm, now),
  }
}

const UNITS = ['KB', 'MB', 'GB', 'TB'] as const

/** 「120.6 KB」「47.1 GB」：1024 進位、一位小數（跟 `df -h` 同一套）。 */
export function formatBytes(bytes: number): string {
  if (!(bytes >= 1024)) return `${Math.max(0, Math.round(bytes || 0))} bytes`
  let n = bytes
  let unit = 'bytes'
  for (const u of UNITS) {
    if (n < 1024) break
    n /= 1024
    unit = u
  }
  return `${n.toFixed(1)} ${unit}`
}
