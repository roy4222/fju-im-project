/**
 * 稽核紀錄與操作帳本的共用型別與純邏輯（契約 01 §4.3、§4.4、§8；模組 10 §5）。
 *
 * 這個檔沒有資料庫、沒有框架：fingerprint 怎麼算、哪些欄位可以進 payload，
 * 都是規則問題而不是儲存問題，所以放在 application 層，單獨可測。
 */

export type ActorKind = 'user' | 'system' | 'worker'
export type Scope = 'cohort' | 'global'
export type VerificationMethod = 'id_document' | 'school_channel' | 'other'

/** 一筆稽核紀錄（契約 01 §4.3）。寫進去就改不掉。 */
export type AuditEventInput = {
  readonly actorKind: ActorKind
  readonly actorUserId?: string | null
  readonly role?: 'student' | 'teacher' | 'admin' | null
  readonly action: string
  readonly targetType: string
  readonly targetId?: string | null
  readonly scope: Scope
  readonly cohortId?: string | null
  readonly reason?: string | null
  readonly verificationMethod?: VerificationMethod | null
  /** 雙時間（契約 01 §1）：真實時間給稽核，業務時間給流程判定。 */
  readonly realAt: Date
  readonly businessAt: Date
  /** 追溯用；**不含秘密與私有正文**（契約 01 §4.3）。 */
  readonly payload?: Record<string, unknown>
}

/** 帳本的一筆操作（契約 01 §4.4）。 */
export type LedgerOperation = {
  readonly actorUserId: string
  /** 例如 `account.approve`、`submission.submit`。 */
  readonly operationKind: string
  /** 由前端產生的請求編號；同一個編號重送只做一次。 */
  readonly requestId: string
  /** 這次請求的內容指紋，用來判斷「同一個編號但內容不同」。 */
  readonly fingerprint: string
  readonly scope: Scope
  readonly cohortId?: string | null
}

export type LedgerBeginResult =
  /** 第一次看到這個 requestId：繼續執行用例。 */
  | { readonly outcome: 'fresh'; readonly recordId: string }
  /** 同編號同內容：回原本那份回執，不要再做一次。 */
  | { readonly outcome: 'replay'; readonly recordId: string; readonly receipt: unknown; readonly resultRef: unknown; readonly receiptExpired: boolean }
  /** 同編號不同內容：拒絕（契約 01 §8）。 */
  | { readonly outcome: 'mismatch' }

/** 回執保留 30 天（契約 01 §4.4）；到期由 worker 清 `receipt`，`result_ref` 永久保留。 */
export const RECEIPT_TTL_DAYS = 30

export function receiptExpiryFrom(committedAt: Date): Date {
  return new Date(committedAt.getTime() + RECEIPT_TTL_DAYS * 24 * 60 * 60 * 1000)
}

/**
 * 把請求內容變成一串穩定的 JSON，給 fingerprint 用。
 *
 * 「穩定」是重點：同樣的內容，欄位順序不同也要得到同一個字串，
 * 不然使用者按兩次送出就會被誤判成 `REQUEST_MISMATCH`。
 * `undefined` 的欄位一律當作不存在（JSON 本來就沒有 undefined）。
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value instanceof Date) return value.toISOString()

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return Object.fromEntries(entries.map(([k, v]) => [k, canonicalize(v)]))
}
