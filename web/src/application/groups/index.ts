/**
 * 模組 03 分組、指導與產學的公開入口（母 spec §4.3）。票 13：找組員、提案與成組。
 *
 * 跨模組只能從這裡引用，而且只能帶型別；執行期的實作由 composition 注入。
 */
export type {
  ConfirmReceipt,
  ExpireOutcome,
  GroupType,
  InvitationState,
  NormalizedProposal,
  ProposalState,
  ProposeInput,
  ProposeReceipt,
  SetOpenToJoinReceipt,
  TeammateListing,
  TerminateReceipt,
  TerminationKind,
} from '@/application/groups/proposals'
export {
  canViewTeammates,
  describeConfirmReceipt,
  describeTerminateReceipt,
  GROUP_TYPE_LABEL,
  GROUP_TYPES,
  INVITATION_STATE_LABEL,
  isAdmin,
  isUuid,
  nextGroupCode,
  normalizeProposeInput,
  normalizeVoidReason,
  PROPOSAL_STATE_LABEL,
  proposalExpiry,
  STUDENT_NO_MAX_LENGTH,
  studentCohortOf,
  TERMINATION_KIND_LABEL,
  VOID_REASON_MAX_LENGTH,
} from '@/application/groups/proposals'
export type {
  CohortGroupingOverview,
  GroupCommand,
  GroupMember,
  GroupQuery,
  GroupSummary,
  ProposalExpiryHandler,
  ProposalInvitation,
  ProposalSummary,
  StudentGroupView,
  UngroupedStudent,
} from '@/application/groups/ports'
