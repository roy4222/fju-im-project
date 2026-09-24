/**
 * 模組 01 帳號與權限的公開入口（母 spec §4.3）。
 *
 * 跨模組只能從這裡引用，而且只能帶型別；執行期的實作由 composition 注入。
 */
export type {
  AccountStatus,
  Actor,
  AnonymousActor,
  Capability,
  CohortMembership,
  ResolvedActor,
  Role,
} from '@/application/accounts/actor'
export { ANONYMOUS, canPerform, hasRole, statusGate } from '@/application/accounts/actor'
export type { ActorResolver } from '@/application/accounts/ports'
export type {
  ChangePasswordInput,
  ChangePasswordOutcome,
  SelfAccountCommand,
} from '@/application/accounts/self-account'
export type {
  CohortOption,
  CohortValueMatch,
  RosterAnalysis,
  RosterCommand,
  RosterCounts,
  RosterEntryDraft,
  RosterImportReceipt,
  RosterIssue,
  RosterIssueKind,
  RosterPreview,
  RosterUploadTicket,
  RosterVersionRow,
} from '@/application/accounts/roster'
export {
  analyzeRoster,
  normalizeName,
  pickCohort,
  ROSTER_MAX_BYTES,
  ROSTER_MAX_ROWS,
  rosterAccessDenied,
} from '@/application/accounts/roster'
export type {
  ReconcileReason,
  RevocationKind,
  RevocationTargetStatus,
} from '@/application/accounts/session-revocation'
export {
  expectedBannedFor,
  nextReconcileRound,
  reachesReconcileLimit,
  RECONCILE_INTERVAL_SECONDS,
  RECONCILE_RECENT_HOURS,
  RECONCILE_ROUND_LIMIT,
  RECONCILE_UNKNOWN_OUTCOME_DAYS,
  REVOCATION_CALL_TIMEOUT_MS,
  REVOCATION_LEASE_SECONDS,
  revocationKindFor,
  revocationTargetOf,
} from '@/application/accounts/session-revocation'
