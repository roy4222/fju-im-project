import 'server-only'
import type { PoolClient } from 'pg'
import { rosterFileDownloadable, type ResolvedActor } from '@/application/accounts'
import {
  normalizeAuditWho,
  parseAuditQuery,
  type AuditLog,
  type AuditWriter,
  type DownloadPolicies,
  type FileStorage,
  type OperationLedger,
} from '@/application/ops'
import { getPool } from '@/infrastructure/db/client'
import { createAttachmentPolicy } from '@/infrastructure/items/attachment-policy'
import { PgAuditWriter } from '@/infrastructure/ops/audit-writer'
import { readAuditLog } from '@/infrastructure/ops/pg-audit-log'
import { avatarImageTransform } from '@/infrastructure/ops/avatar-image'
import { FsFileStorage } from '@/infrastructure/ops/file-storage'
import { PgOperationLedger } from '@/infrastructure/ops/operation-ledger'
import { createPosterPolicy } from '@/infrastructure/showcase/poster-policy'
import { createHeroPhotoPolicy } from '@/infrastructure/site/hero-photo-policy'
import { createSubmissionFilePolicy } from '@/infrastructure/submissions/submission-file-policy'

// 操作紀錄頁（票 36）要的顯示規則：app 對 application 只能帶型別，值經 composition 轉出去。
export {
  AUDIT_PAGE_LIMIT,
  AUDIT_WHO_FILTERS,
  AUDIT_WHO_LABEL,
  AUDIT_WINDOW_DAYS,
  auditActionLabel,
  auditActionTitle,
  auditWhoOf,
  describeAuditTarget,
} from '@/application/ops'
export { AUDIT_QUERY_MAX_LENGTH, AuditQueryInvalidError } from '@/application/ops'

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
 * 沒登記的用途一律「無法存取」。附件（票 15）、繳交（票 21）、精選海報（票 25）、匯出（票 26）、首頁大圖（第三波 W3）已加。
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
  // 精選海報（票 25）：管理員；草稿上的＝那一組此刻的組員與主指導；簽核版本凍結的＝那一版的參與者。
  // 公開頁的海報走 S12 的公開閘門，不是這一條。
  poster: createPosterPolicy(getPool),
  // 匯出檔（票 26 簽核匯出）：只有有效的管理員；而且要真的被某筆匯出紀錄引用著。
  // 匯出當下已經直接串流給按的人，這一條是事後從檔案編號再拿一次用的。
  export: (actor, file) =>
    actor.kind === 'authenticated' &&
    actor.status === 'active' &&
    actor.roles.includes('admin') &&
    file.references.some((r) => r.refType === 'export'),
  // 首頁大圖（第三波 W3）：只有目前首頁設定指到的那一張對所有人（含訪客）公開；換圖後舊圖回到「無法存取」。
  // 上傳憑證由首頁設定用例發（只給管理員，`scope = 'global'`），不寫 file_references。
  photo: createHeroPhotoPolicy(getPool),
  // 上傳的頭像（SH-9）：任何狀態正常的登入者都看得到（頭像出現在組員座位、表態列、帳號列表）；訪客 401。
  // 換掉或清掉的頭像已標刪，在政策之前就回 404（`FILE_GONE`）。
  avatar: (actor) => actor.kind === 'authenticated' && actor.status === 'active',
}

/**
 * 「操作紀錄」頁（票 36；模組 10「系辦進操作紀錄」、FIL-07「一般學生不可讀管理稽核」）。
 * 只給狀態正常的管理員：其他人一律回 null（頁面本身已經先用 `requireRole` 擋過一次）。
 */
export function getAuditLogQuery() {
  return {
    /** `options.q`：搜尋字（網址 `?q=`）；trim 後超過 50 字丟 `AuditQueryInvalidError`（`VALIDATION_FAILED`）。 */
    async recent(actor: ResolvedActor, who: unknown, options: { q?: string } = {}): Promise<AuditLog | null> {
      if (actor.kind !== 'authenticated' || actor.status !== 'active' || !actor.roles.includes('admin')) return null
      return readAuditLog(getPool(), normalizeAuditWho(who), parseAuditQuery(options.q))
    },
  }
}

export function getFileStorage(): FileStorage<PoolClient> {
  fileStorage ??= new FsFileStorage({
    root: filesRoot,
    environmentMaxBytes,
    ticketSecret,
    policies: DOWNLOAD_POLICIES,
    // 待審、必須改密的人比照訪客：首頁大圖、公告封面與附件、精選海報仍走各用途的訪客政策，訪客拿得到的才拿得到。
    publicReadPurposes: ['photo', 'attachment', 'poster'],
    db: getPool,
    // 頭像收檔時縮成 256×256 WebP、清掉 EXIF；處理不了的圖不收（SH-9）。
    transforms: { avatar: avatarImageTransform },
  })
  return fileStorage
}
