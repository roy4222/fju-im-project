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
export type { AuditWriter, OperationLedger, SubmissionLateFlags } from '@/application/ops/ports'
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
  isCacheableDownload,
  isUuid,
  PUBLIC_IMAGE_MAX_AGE_SECONDS,
  sanitizeDisplayName,
  storageKeyFor,
  tempKeyFor,
  typeForExtension,
} from '@/application/ops/files'
export type { AuditLog, AuditLogEntry, AuditWhoFilter } from '@/application/ops/audit-log'
export {
  AUDIT_EXCLUDED_ACTIONS,
  AUDIT_PAGE_LIMIT,
  AUDIT_QUERY_MAX_LENGTH,
  AUDIT_TARGET_TYPE_LABEL_ENTRIES,
  AuditQueryInvalidError,
  parseAuditQuery,
  AUDIT_WHO_FILTERS,
  AUDIT_WHO_LABEL,
  AUDIT_WINDOW_DAYS,
  auditActionLabel,
  auditActionTitle,
  auditTargetTypeLabel,
  auditWhoOf,
  describeAuditTarget,
  normalizeAuditWho,
} from '@/application/ops/audit-log'
