/**
 * 模組 10 檔案與服務維運的公開入口（母 spec §4.3）。
 *
 * 稽核與帳本兩個 port（S01-03），以及共用檔案能力 `FileStorage`（票 6）。
 */
export type {
  ActorKind,
  AuditEventInput,
  LedgerBeginResult,
  LedgerState,
  LedgerOperation,
  Scope,
  VerificationMethod,
} from '@/application/ops/records'
export { canonicalJson, RECEIPT_TTL_DAYS, receiptExpiryFrom } from '@/application/ops/records'
export type { AuditWriter, OperationLedger } from '@/application/ops/ports'
export type {
  ContentInspector,
  DeclaredUpload,
  DownloadPolicies,
  DownloadPolicy,
  FileDownload,
  FileFacts,
  FilePurpose,
  FileRef,
  FileRefType,
  FileStorage,
  FileTypeId,
  StoredFileContent,
  StoredFileReceipt,
  UploadRules,
  UploadTicket,
} from '@/application/ops/files'
export {
  checkDeclaredUpload,
  contentDispositionFor,
  createContentInspector,
  effectiveMaxBytes,
  extensionOf,
  FILE_TYPES,
  formatBytes,
  isUuid,
  sanitizeDisplayName,
  storageKeyFor,
  tempKeyFor,
  typeForExtension,
} from '@/application/ops/files'
