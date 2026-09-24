import 'server-only'
import type { PoolClient } from 'pg'
import { rosterAccessDenied } from '@/application/accounts'
import type { AuditWriter, DownloadPolicies, FileStorage, OperationLedger } from '@/application/ops'
import { getPool } from '@/infrastructure/db/client'
import { createAttachmentPolicy } from '@/infrastructure/items/attachment-policy'
import { PgAuditWriter } from '@/infrastructure/ops/audit-writer'
import { FsFileStorage } from '@/infrastructure/ops/file-storage'
import { PgOperationLedger } from '@/infrastructure/ops/operation-ledger'

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
 * 沒登記的用途一律「無法存取」。附件（票 15）已加；繳交（S07）再加一列。
 */
export const DOWNLOAD_POLICIES: DownloadPolicies = {
  // 名單原檔：只有狀態正常的管理員（契約 03 §1「帳號」列）。
  roster_csv: (actor) => rosterAccessDenied(actor) === null,
  // 專題事務的附件與封面（票 15）：誰看得到那個項目誰就能下載；草稿、下架、沒綁項目的一律拒絕。
  attachment: createAttachmentPolicy(getPool),
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
