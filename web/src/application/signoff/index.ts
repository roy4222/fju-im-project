/**
 * 模組 07 線上簽核的公開入口（母 spec §4.3）。票 25：建版（參與者快照、授權範圍凍結）、參與者變更時的失效、三角色讀取。
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
  readParticipants,
  scopeContent,
  SIGNOFF_PURPOSES,
  STATE_LABEL,
} from '@/application/signoff/version'
export type {
  AdminGroupRow,
  AdminSignoffBoard,
  CreateVersionInput,
  CreateVersionReceipt,
  SignoffCommand,
  SignoffParticipantHook,
  SignoffQuery,
  StudentSignoffView,
  TeacherSignoffCard,
  VersionDetail,
  VersionSummary,
} from '@/application/signoff/ports'
export { describeCreateVersionReceipt } from '@/application/signoff/receipts'
