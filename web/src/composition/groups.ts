import 'server-only'
import type { PoolClient } from 'pg'
import type {
  AdvisorCommand,
  AdvisorGradingLookup,
  GroupCommand,
  GroupQuery,
  LeaderSuccessionHook,
  OpportunityCommand,
  OpportunityQuery,
  ProposalExpiryHandler,
} from '@/application/groups'
import { getBusinessClock } from '@/composition/cohorts'
import { getAssignmentsForTeacherQuery } from '@/composition/grading'
import { getDueWorkScheduler, getEventPublisher } from '@/composition/notifications'
import { getAuditWriter, getFileStorage, getOperationLedger } from '@/composition/ops'
import { getSignoffParticipantHook } from '@/composition/signoff'
import { PgAdvisorCommand } from '@/infrastructure/groups/pg-advisors'
import { PgGroupCommand, PgGroupQuery } from '@/infrastructure/groups/pg-groups'
import { PgOpportunityCommand, PgOpportunityQuery } from '@/infrastructure/groups/pg-opportunities'

/**
 * 模組 03 分組的實例組裝（票 13：找組員、提案與成組；票 14：管理員調整組員與換組長；
 * 票 19：指導老師指派、認領與重派；票 20：產學合作案、組別連結、改類型。名單匯出在 `group-roster.ts`）。
 */
let groupCommand: PgGroupCommand | undefined
let groupQuery: GroupQuery | undefined
let advisorCommand: AdvisorCommand | undefined

function command(): PgGroupCommand {
  groupCommand ??= new PgGroupCommand({
    audit: getAuditWriter(),
    ledger: getOperationLedger(),
    events: getEventPublisher(),
    dueWork: getDueWorkScheduler(),
    businessClock: getBusinessClock(),
    // 票 25：加入／移出組員時同交易讓目前簽核版本失效。
    signoff: getSignoffParticipantHook(),
  })
  return groupCommand
}

export function getGroupCommand(): GroupCommand {
  return command()
}

/**
 * 票 42：停用帳號時的組長接任（模組 01 的停用用例在它的交易裡呼叫；見 `composition/accounts.ts`）。
 * 這裡不 import 帳號的 composition（不會繞成循環）。
 */
export function getLeaderSuccessionHook(): LeaderSuccessionHook<PoolClient> {
  return command()
}

export function getGroupQuery(): GroupQuery {
  groupQuery ??= new PgGroupQuery()
  return groupQuery
}

export function getAdvisorCommand(): AdvisorCommand {
  advisorCommand ??= new PgAdvisorCommand({
    audit: getAuditWriter(),
    ledger: getOperationLedger(),
    events: getEventPublisher(),
    files: getFileStorage(),
    businessClock: getBusinessClock(),
    // 票 26：改主指導時同交易讓目前簽核版本失效。
    signoff: getSignoffParticipantHook(),
  })
  return advisorCommand
}

/**
 * 重派對話框要列的「原老師在本組的評分指派」（模組 06 `AssignmentsForTeacherQuery.listForGroup`；票 23 接上）。
 * 只列、不移轉：新主指導不會自動取得評分權限，勾選處理評分指派（保留／替換／新增）在票 24。
 */
export function getAdvisorGradingLookup(): AdvisorGradingLookup {
  const assignments = getAssignmentsForTeacherQuery()
  return { assignmentsFor: (groupId, teacherUserId) => assignments.listForGroup(groupId, teacherUserId) }
}

// ── 產學合作案、組別連結、改類型、組別名單匯出（票 20） ──

let opportunityCommand: OpportunityCommand | undefined
let opportunityQuery: OpportunityQuery | undefined

export function getOpportunityCommand(): OpportunityCommand {
  opportunityCommand ??= new PgOpportunityCommand({
    audit: getAuditWriter(),
    ledger: getOperationLedger(),
    events: getEventPublisher(),
    businessClock: getBusinessClock(),
  })
  return opportunityCommand
}

export function getOpportunityQuery(): OpportunityQuery {
  opportunityQuery ??= new PgOpportunityQuery({ businessClock: getBusinessClock() })
  return opportunityQuery
}

/**
 * `due_work(kind='proposal_expiry', subject_type='group_proposal')` 的處理器。
 * 背景工作（票 12）到期時以 `expire(subject_id, deadline_version)` 呼叫；重跑安全。
 */
export function getProposalExpiryHandler(): ProposalExpiryHandler {
  return command()
}

/** app 對 application 只能帶型別；畫面要用的標籤與回饋句子經這裡拿（母 spec §4.3）。 */
export {
  ADVISOR_BATCH_KIND_LABEL,
  ADVISOR_BATCH_KINDS,
  ADVISOR_BATCH_OUTCOME_LABEL,
  ADVISOR_CSV_MAX_BYTES,
  ADVISOR_SOURCE_LABEL,
  CHANGE_REASON_MAX_LENGTH,
  describeAdvisorBatchReceipt,
  describeAdvisorChangeReceipt,
  describeGroupHistory,
  describeConfirmReceipt,
  describeLeaderChangeReceipt,
  describeMemberChangeReceipt,
  describeTerminateReceipt,
  GROUP_TYPE_LABEL,
  GROUP_TYPES,
  groupSizeWarning,
  INVITATION_STATE_LABEL,
  PROPOSAL_STATE_LABEL,
  STUDENT_NO_MAX_LENGTH,
  studentCohortOf,
  TERMINATION_KIND_LABEL,
  VOID_REASON_MAX_LENGTH,
  // 票 20
  describeGroupTypeReceipt,
  describeLinkReceipt,
  describeOpportunityReceipt,
  groupEmailList,
  NOTES_VISIBILITY_LABEL,
  normalizeRosterFilter,
  OPPORTUNITY_FIELD_LABEL,
  OPPORTUNITY_LIMITS,
  OPPORTUNITY_STATUS_LABEL,
  opportunityName,
  applyRosterFilter,
  ROSTER_SEARCH_MAX_LENGTH,
  ROSTER_SORT_LABEL,
  ROSTER_SORTS,
  ROSTER_STATUS_FILTER_LABEL,
  ROSTER_STATUS_FILTERS,
  ROSTER_TYPE_FILTER_LABEL,
  ROSTER_TYPE_FILTERS,
  rosterQueryString,
} from '@/application/groups'
