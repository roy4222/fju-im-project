/**
 * 模組 10 檔案與服務維運的公開入口（母 spec §4.3）。
 *
 * 本切片只交付稽核與帳本兩個 port；檔案能力（`FileStorage`）在後面的票。
 */
export type {
  ActorKind,
  AuditEventInput,
  LedgerBeginResult,
  LedgerOperation,
  Scope,
  VerificationMethod,
} from '@/application/ops/records'
export { canonicalJson, RECEIPT_TTL_DAYS, receiptExpiryFrom } from '@/application/ops/records'
export type { AuditWriter, OperationLedger } from '@/application/ops/ports'
