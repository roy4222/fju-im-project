/**
 * 契約 02 §1 的錯誤碼清單與預設下一步。
 *
 * 這裡是全站唯一的錯誤碼來源：application 用例回 Err 時只能用這裡的代碼，
 * UI 依 `next` 決定把使用者帶去哪裡。新增代碼要先改契約 02 §1 再回來。
 */

export const ERROR_CODES = [
  // 身分
  'UNAUTHENTICATED',
  'ACCOUNT_PENDING',
  'ACCOUNT_DISABLED',
  'PASSWORD_CHANGE_REQUIRED',
  'FRESH_SESSION_REQUIRED',
  'TURNSTILE_REQUIRED',
  // 授權
  'FORBIDDEN',
  'NOT_MEMBER',
  'NOT_ASSIGNED',
  'NOT_IN_ROSTER',
  'EXEMPTED',
  'COHORT_ARCHIVED',
  'COHORT_MISMATCH',
  'NOT_PARTICIPANT',
  // 狀態
  'ITEM_NOT_OPEN',
  'DEADLINE_PASSED',
  'VERSION_SUPERSEDED',
  'PROPOSAL_NOT_OPEN',
  'GROUP_DISSOLVED',
  'SCHEME_LOCKED',
  'ALREADY_CLAIMED',
  'ALREADY_MEMBER',
  'INVITED_ELSEWHERE',
  'STUDENT_NO_TAKEN',
  'STUDENTS_PENDING',
  'ALREADY_VOTED',
  'ITEM_HAS_RESPONSES',
  'OPPORTUNITY_NOT_LINKABLE',
  'AUTHORIZATION_NOT_COVERED',
  'ASSET_NOT_APPROVED',
  'PII_DETECTED',
  'FILE_REFERENCED',
  'FINAL_INCOMPLETE',
  // 併發
  'CONFLICT',
  'REQUEST_MISMATCH',
  // 輸入
  'VALIDATION_FAILED',
  'SCHEMA_INVALID',
  'FILE_NOT_READY',
  'FILE_NOT_OWNED',
  'FILE_TYPE_REJECTED',
  'FILE_TOO_LARGE',
  'DRAFT_NEEDS_REVIEW',
  // 帳本
  'RECEIPT_EXPIRED',
  // 系統
  'INTERNAL',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

/** 前端專用狀態：伺服器不會回這個碼，是 client 在結果未知時自己進的狀態（契約 02 §1、§4）。 */
export const CLIENT_ONLY_STATUS = 'RESULT_UNKNOWN' as const
export type ClientOnlyStatus = typeof CLIENT_ONLY_STATUS

export type ErrorCategory =
  | 'identity'
  | 'authorization'
  | 'state'
  | 'concurrency'
  | 'input'
  | 'ledger'
  | 'system'

export type NextStepKind =
  | 'reload'
  | 'login'
  | 'home'
  | 'contact_office'
  | 'retry_same_request'
  | 'query_result'
  | 'change_password'
  | 'pending_page'

export type NextStep = { kind: NextStepKind; href?: string }

const CATEGORY: Record<ErrorCode, ErrorCategory> = {
  UNAUTHENTICATED: 'identity',
  ACCOUNT_PENDING: 'identity',
  ACCOUNT_DISABLED: 'identity',
  PASSWORD_CHANGE_REQUIRED: 'identity',
  FRESH_SESSION_REQUIRED: 'identity',
  TURNSTILE_REQUIRED: 'identity',
  FORBIDDEN: 'authorization',
  NOT_MEMBER: 'authorization',
  NOT_ASSIGNED: 'authorization',
  NOT_IN_ROSTER: 'authorization',
  EXEMPTED: 'authorization',
  COHORT_ARCHIVED: 'authorization',
  COHORT_MISMATCH: 'authorization',
  NOT_PARTICIPANT: 'authorization',
  ITEM_NOT_OPEN: 'state',
  DEADLINE_PASSED: 'state',
  VERSION_SUPERSEDED: 'state',
  PROPOSAL_NOT_OPEN: 'state',
  GROUP_DISSOLVED: 'state',
  SCHEME_LOCKED: 'state',
  ALREADY_CLAIMED: 'state',
  ALREADY_MEMBER: 'state',
  INVITED_ELSEWHERE: 'state',
  STUDENT_NO_TAKEN: 'state',
  STUDENTS_PENDING: 'state',
  ALREADY_VOTED: 'state',
  ITEM_HAS_RESPONSES: 'state',
  OPPORTUNITY_NOT_LINKABLE: 'state',
  AUTHORIZATION_NOT_COVERED: 'state',
  ASSET_NOT_APPROVED: 'state',
  PII_DETECTED: 'state',
  FILE_REFERENCED: 'state',
  FINAL_INCOMPLETE: 'state',
  CONFLICT: 'concurrency',
  REQUEST_MISMATCH: 'concurrency',
  VALIDATION_FAILED: 'input',
  SCHEMA_INVALID: 'input',
  FILE_NOT_READY: 'input',
  FILE_NOT_OWNED: 'input',
  FILE_TYPE_REJECTED: 'input',
  FILE_TOO_LARGE: 'input',
  DRAFT_NEEDS_REVIEW: 'input',
  RECEIPT_EXPIRED: 'ledger',
  INTERNAL: 'system',
}

/**
 * 契約 02 §1「下一步」欄。沒有列在這裡的代碼一律 reload；
 * `REQUEST_MISMATCH` 明確不自動重試，所以是 reload 而不是 retry_same_request。
 */
const NEXT_STEP: Partial<Record<ErrorCode, NextStepKind>> = {
  UNAUTHENTICATED: 'login',
  ACCOUNT_PENDING: 'pending_page',
  ACCOUNT_DISABLED: 'contact_office',
  PASSWORD_CHANGE_REQUIRED: 'change_password',
  FRESH_SESSION_REQUIRED: 'login',
  FORBIDDEN: 'home',
  NOT_MEMBER: 'home',
  NOT_ASSIGNED: 'home',
  NOT_IN_ROSTER: 'home',
  EXEMPTED: 'home',
  COHORT_ARCHIVED: 'home',
  COHORT_MISMATCH: 'home',
  NOT_PARTICIPANT: 'home',
  INTERNAL: 'query_result',
}

export function errorCategory(code: ErrorCode): ErrorCategory {
  return CATEGORY[code]
}

export function defaultNextStep(code: ErrorCode): NextStep {
  return { kind: NEXT_STEP[code] ?? 'reload' }
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value)
}
