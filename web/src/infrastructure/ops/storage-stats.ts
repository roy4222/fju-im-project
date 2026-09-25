import 'server-only'
import fs from 'node:fs/promises'
import path from 'node:path'
import { uuidv7 } from 'uuidv7'
import type { Pool } from 'pg'
import {
  storageAlertLevel,
  usageFromStatfs,
  type StorageAlertLevel,
  type StorageMeasurement,
} from '@/application/ops'

/**
 * 磁碟量測的讀寫（票 28；模組 10 附錄 A `storage_stats`）。
 *
 * **存在哪**：規格的 `storage_stats` 表還沒建，這一票不加 migration（資料庫線由票 23 使用中）。
 * 先寫進既有的 `audit_events`——`fju_app` 本來就能 INSERT、表是不可變的、`actor_kind` 允許 `worker`、
 * `payload` 是 jsonb——一筆量測＝一列 `action='storage.measured'`、`scope='global'`。
 * payload 的欄位名與 `storage_stats` 的欄位一一對應，之後補表時可以直接搬。
 * 讀的時候只取最新一筆。
 *
 * 量什麼：`FILES_ROOT` 所在檔案系統的總量／已用／可用（`statfs`，跟 `df` 同算法），
 * 加上 `FILES_ROOT/files`、`FILES_ROOT/tmp` 兩個目錄各佔多少、資料庫大小（`pg_database_size`）。
 * 資料庫的 volume 沒掛進 worker 容器，所以量不到「資料庫那顆磁碟還剩多少」；VM 上它跟附件目錄
 * 在同一顆系統碟，`FILES_ROOT` 的數字就是整顆碟的狀況。
 */

export const STORAGE_AUDIT_ACTION = 'storage.measured'

type Statfs = (target: string) => Promise<{ bsize: number; blocks: number; bfree: number; bavail: number }>

export type MeasureStorageOptions = {
  /** 要量哪個目錄所在的檔案系統（預設 `FILES_ROOT`）。 */
  readonly root: string
  readonly db: Pick<Pool, 'query'>
  readonly now?: Date
  readonly drill?: boolean
  /** 測試用：換掉 statfs。 */
  readonly statfs?: Statfs
}

/** 目錄底下所有一般檔案的大小總和（不跟隨符號連結）。目錄不存在回 0。 */
export async function directoryBytes(dir: string): Promise<number> {
  let total = 0
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      total += await directoryBytes(full)
    } else if (entry.isFile()) {
      try {
        total += (await fs.lstat(full)).size
      } catch (error) {
        // 量的途中被刪掉（例如上傳失敗清暫存）：略過這一個。
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }
  return total
}

/** 量一次（不寫入）。 */
export async function measureStorage(options: MeasureStorageOptions): Promise<StorageMeasurement> {
  const statfs: Statfs = options.statfs ?? ((target) => fs.statfs(target))
  const usage = usageFromStatfs(await statfs(options.root))
  const [filesBytes, tmpBytes, dbBytes] = await Promise.all([
    directoryBytes(path.join(options.root, 'files')),
    directoryBytes(path.join(options.root, 'tmp')),
    options.db
      .query<{ size: string }>('select pg_database_size(current_database())::text as size')
      .then((result) => Number(result.rows[0]?.size ?? Number.NaN))
      .then((size) => (Number.isFinite(size) ? size : null))
      .catch(() => null),
  ])
  return {
    measuredRealAt: options.now ?? new Date(),
    path: options.root,
    ...usage,
    filesBytes,
    tmpBytes,
    dbBytes,
    alertLevel: storageAlertLevel(usage.usedPercent),
    drill: options.drill ?? false,
  }
}

/** 寫一筆量測（`audit_events`，見檔頭）。 */
export async function recordStorageMeasurement(db: Pick<Pool, 'query'>, m: StorageMeasurement): Promise<void> {
  await db.query(
    `insert into audit_events (id, actor_kind, action, target_type, scope, real_at, business_at, payload)
     values ($1, 'worker', $2, 'storage', 'global', $3, $3, $4::jsonb)`,
    [
      uuidv7(),
      STORAGE_AUDIT_ACTION,
      m.measuredRealAt,
      JSON.stringify({
        path: m.path,
        total_bytes: m.totalBytes,
        used_bytes: m.usedBytes,
        free_bytes: m.freeBytes,
        used_percent: m.usedPercent,
        files_bytes: m.filesBytes,
        tmp_bytes: m.tmpBytes,
        db_bytes: m.dbBytes,
        alert_level: m.alertLevel,
        drill: m.drill,
      }),
    ],
  )
}

type Payload = {
  path?: string
  total_bytes?: number
  used_bytes?: number
  free_bytes?: number
  used_percent?: number
  files_bytes?: number
  tmp_bytes?: number
  db_bytes?: number | null
  alert_level?: StorageAlertLevel
  drill?: boolean
}

/** 最新一筆量測；還沒量過回 null。 */
export async function readLatestStorage(db: Pick<Pool, 'query'>): Promise<StorageMeasurement | null> {
  const result = await db.query<{ real_at: Date; payload: Payload }>(
    `select real_at, payload from audit_events
      where action = $1 and target_type = 'storage'
      order by real_at desc, id desc
      limit 1`,
    [STORAGE_AUDIT_ACTION],
  )
  const row = result.rows[0]
  if (!row) return null
  const p = row.payload
  const usedPercent = Number(p.used_percent ?? 0)
  return {
    measuredRealAt: row.real_at,
    path: p.path ?? '',
    totalBytes: Number(p.total_bytes ?? 0),
    usedBytes: Number(p.used_bytes ?? 0),
    freeBytes: Number(p.free_bytes ?? 0),
    usedPercent,
    filesBytes: Number(p.files_bytes ?? 0),
    tmpBytes: Number(p.tmp_bytes ?? 0),
    dbBytes: p.db_bytes == null ? null : Number(p.db_bytes),
    // 等級以寫入當下的判定為準；舊資料缺欄位時才用百分比重算。
    alertLevel: p.alert_level ?? storageAlertLevel(usedPercent),
    drill: p.drill === true,
  }
}
