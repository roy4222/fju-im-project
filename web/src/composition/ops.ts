import 'server-only'
import type { PoolClient } from 'pg'
import { rosterFileDownloadable, type ResolvedActor } from '@/application/accounts'
import {
  storageTileText,
  type AuditWriter,
  type DownloadPolicies,
  type FileStorage,
  type OperationLedger,
  type StorageMeasurement,
} from '@/application/ops'
import { formatTaipeiMinute } from '@/shared/time'
import { getPool } from '@/infrastructure/db/client'
import { createAttachmentPolicy } from '@/infrastructure/items/attachment-policy'
import { PgAuditWriter } from '@/infrastructure/ops/audit-writer'
import { FsFileStorage } from '@/infrastructure/ops/file-storage'
import { PgOperationLedger } from '@/infrastructure/ops/operation-ledger'
import { readLatestStorage } from '@/infrastructure/ops/storage-stats'
import { createSubmissionFilePolicy } from '@/infrastructure/submissions/submission-file-policy'

/** 模組 10 的共用 port（稽核、帳本、檔案）。 */
let auditWriter: AuditWriter<PoolClient> | undefined
let operationLedger: OperationLedger<PoolClient> | undefined
let fileStorage: FileStorage<PoolClient> | undefined

export function getAuditWriter(): AuditWriter<PoolClient> {
  auditWriter ??= new PgAuditWriter()
  return auditWriter
}

export function getOperationLedger(): OperationLedger<PoolClient> {
  operationLedger ??= new PgOperationLedger()
  return operationLedger
}

/** 環境單檔上限的預設值（契約 05：`FILE_MAX_BYTES=104857600`，100 MiB）。 */
const DEFAULT_FILE_MAX_BYTES = 100 * 1024 * 1024

function filesRoot(): string {
  const root = process.env.FILES_ROOT
  // 第一次真的要碰檔案才檢查：少了它 /api/health 與其他頁面照樣起得來。
  if (!root) throw new Error('缺少 FILES_ROOT（檔案存放根目錄）')
  return root
}

function environmentMaxBytes(): number {
  const raw = Number(process.env.FILE_MAX_BYTES)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_FILE_MAX_BYTES
}

function ticketSecret(): string {
  const secret = process.env.BETTER_AUTH_SECRET
  if (!secret) throw new Error('缺少 BETTER_AUTH_SECRET（上傳 ticket 的簽章用）')
  return secret
}

/**
 * 每個用途的下載政策（模組 10 §5 `authorizeDownload`）。**新用途要在這裡登記**，
 * 沒登記的用途一律「無法存取」。附件（票 15）、繳交（票 21）已加。
 */
export const DOWNLOAD_POLICIES: DownloadPolicies = {
  // 名單原檔：只有狀態正常的管理員（契約 03 §1「帳號」列），而且檔案已經匯入成某個名單版本。
  // 上傳了但沒匯入的原檔誰都拿不到（票 6 審查建議 3）。
  roster_csv: (actor, file) => rosterFileDownloadable(actor, file.references),
  // 專題事務的附件與封面（票 15）：誰看得到那個項目誰就能下載；草稿、下架、沒綁項目的一律拒絕。
  attachment: createAttachmentPolicy(getPool),
  // 繳交附件（票 21）：共用草稿＝此刻有效組員（個人＝本人）；正式版本再加目前主指導（個人回答要項目開放閱覽）；管理員。
  // 沒被任何草稿或版本引用的檔（剛傳完還沒存、從草稿拿掉）一律拒絕。
  submission: createSubmissionFilePolicy(getPool),
}

/**
 * 維運狀態查詢（模組 10 §5 `OpsStatusQuery`；票 28 先做 `storage()`）。只給管理員：
 * 非管理員一律回 null（頁面本身已經先擋過一次）。
 */
export function getOpsStatusQuery() {
  return {
    /** 最新一筆磁碟量測；還沒量過回 null。 */
    async storage(actor: ResolvedActor): Promise<StorageMeasurement | null> {
      if (actor.kind !== 'authenticated' || actor.status !== 'active' || !actor.roles.includes('admin')) return null
      return readLatestStorage(getPool())
    },
    /** 系辦首頁「儲存與備份」磚的數字與說明（時間以台北時區顯示）。 */
    async storageTile(actor: ResolvedActor): Promise<{ value: string; hint: string }> {
      const measurement = await this.storage(actor)
      return storageTileText(
        measurement,
        new Date(),
        measurement ? formatTaipeiMinute(measurement.measuredRealAt) : '',
      )
    },
  }
}

export function getFileStorage(): FileStorage<PoolClient> {
  fileStorage ??= new FsFileStorage({
    root: filesRoot,
    environmentMaxBytes,
    ticketSecret,
    policies: DOWNLOAD_POLICIES,
    db: getPool,
  })
  return fileStorage
}
