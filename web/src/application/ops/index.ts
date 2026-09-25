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
  AttachExpectation,
  ContentInspector,
  DeclaredUpload,
  DownloadPolicies,
  DownloadPolicy,
  FileDownload,
  FileFacts,
  FileListRow,
  FilePurpose,
  FileRef,
  FileRefType,
  FileStorage,
  FileTypeId,
  GeneratedFile,
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
export type { StorageAlertLevel, StorageMeasurement } from '@/application/ops/storage'
export {
  formatGiB,
  isStorageMeasurementStale,
  STORAGE_CRITICAL_PERCENT,
  STORAGE_MEASURE_INTERVAL_MS,
  STORAGE_STALE_AFTER_MS,
  STORAGE_WARN_PERCENT,
  storageAlertLabel,
  storageAlertLevel,
  storageTileText,
  usageFromStatfs,
} from '@/application/ops/storage'
