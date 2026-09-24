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
  ContactInput,
  MyAccount,
  SelfAccountCommand,
  SelfAccountOutcome,
  SetPasswordInput,
} from '@/application/accounts/self-account'
export { checkNewOwnPassword } from '@/application/accounts/self-account'
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
  STUDENT_NO_PATTERN,
} from '@/application/accounts/roster'
export type {
  ApplicationFields,
  ApprovalDecision,
  CohortChoice,
  DecisionReceipt,
  DuplicateInfo,
  EmailComparison,
  EvidenceFlag,
  MyApplication,
  PendingApplication,
  PendingList,
  RateLimited,
  RegistrationCommand,
  RegistrationInput,
  RegistrationReceipt,
  RevisionReceipt,
  RosterCandidate,
  RosterHit,
  RosterMatch,
  RosterMatchStatus,
  TextComparison,
  VerificationMethod,
} from '@/application/accounts/registration'
export {
  APPLIED_NAME_MAX_LENGTH,
  DEPARTMENT_CLASS_MAX_LENGTH,
  EVIDENCE_LABEL,
  EVIDENCE_NEEDS_ATTENTION,
  evidenceFlags,
  matchRoster,
  normalizeApplicationFields,
  normalizeApproval,
  normalizeContactFields,
  normalizeRegistrationInput,
  normalizeRejection,
  ownApplicationDenied,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  REASON_MAX_LENGTH,
  resolveApprovalCohort,
  reviewAccessDenied,
  suggestedApprovalCohort,
  VERIFICATION_LABEL,
  VERIFICATION_METHODS,
  VERIFICATION_NOTE_HINT,
  VERIFICATION_NOTE_REQUIRED,
} from '@/application/accounts/registration'
export type {
  AccountCommand,
  AccountLookup,
  NormalizedTeacherAccount,
  TeacherAccountInput,
  TeacherAccountReceipt,
  TeacherCreatedWithSecret,
  TeacherCreationMode,
  TeacherProfileInput,
  TeacherProfileView,
  TeacherSetupCommand,
  TemporaryPasswordReceipt,
} from '@/application/accounts/teachers'
export {
  accountAdminDenied,
  normalizeTeacherAccountInput,
  normalizeTeacherProfile,
  normalizeTemporaryPasswordRequest,
  TEACHER_NAME_MAX_LENGTH,
  teacherSetupDenied,
} from '@/application/accounts/teachers'
