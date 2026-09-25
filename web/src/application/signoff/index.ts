/**
 * 模組 07 線上簽核的公開入口（母 spec §4.3）。票 25：建版（參與者快照、授權範圍凍結）、參與者變更時的失效、三角色讀取；
 * 票 26：逐人表態、老師同意／退回、重置、重開、作廢、提醒、匯出。
 *
 * 跨模組只能從這裡引用，而且只能帶型別；執行期的實作由 composition 注入。
 */
export type {
  AdvisorParticipant,
  AttachmentVersion,
  AuthorizationScope,
  DraftSnapshot,
  Participants,
  ScopeAsset,
  SignoffPurpose,
  SignoffState,
  StudentParticipant,
  SupersedeCause,
} from '@/application/signoff/version'
export {
  ACCEPTANCE_NOTICE,
  buildParticipants,
  CAUSE_LABEL,
  causeForNewVersion,
  describeCause,
  freezeAuthorizationScope,
  hasVisibleText,
  isTerminal,
  MAX_ATTACHMENTS,
  MAX_CONTENT_CHARS,
  PURPOSE_LABEL,
  readAuthorizationScope,
  participantUserIds,
  readParticipants,
  withPseudonyms,
  scopeContent,
  SIGNOFF_PURPOSES,
  STATE_LABEL,
} from '@/application/signoff/version'
export type {
  ExportLifecycle,
  ExportVote,
  SignoffExportData,
} from '@/application/signoff/export'
export { buildSignoffCsv, buildSignoffPrintable, CSV_HEADER, stateText } from '@/application/signoff/export'
export type {
  ParticipantProgress,
  RestartKind,
  VersionProgress,
  VoteDecision,
  VoteFacts,
  VoteRecord,
  VoteResult,
  VoteRole,
} from '@/application/signoff/approval'
export {
  BUTTON_TEXT,
  buildProgress,
  causeForRestart,
  checkVoid,
  checkVote,
  MAX_REASON_CHARS,
  nextRemindAt,
  nextStateAfterVote,
  normalizeReason,
  REMIND_COOLDOWN_MS,
  remindable,
  remindRecipients,
  RESTART_LABEL,
  restartKindFor,
  resultFor,
  roleIn,
  supersedesOnRestart,
  VOTE_RESULT_LABEL,
} from '@/application/signoff/approval'
export type {
  AdminGroupRow,
  AdminSignoffBoard,
  CreateVersionInput,
  CreateVersionReceipt,
  ReasonedVersionInput,
  RemindReceipt,
  RespondInput,
  RespondReceipt,
  RestartReceipt,
  SignoffCommand,
  SignoffExportFile,
  SignoffExportFormat,
  SignoffParticipantHook,
  SignoffQuery,
  StudentSignoffView,
  TeacherSignoffCard,
  VersionDetail,
  VersionSummary,
  VoidReceipt,
} from '@/application/signoff/ports'
export {
  describeCreateVersionReceipt,
  describeRemindReceipt,
  describeRespondReceipt,
  describeRestartReceipt,
  describeVoidReceipt,
} from '@/application/signoff/receipts'
