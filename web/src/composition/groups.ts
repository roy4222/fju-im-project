import 'server-only'
import type {
  AdvisorCommand,
  AdvisorGradingLookup,
  GroupCommand,
  GroupQuery,
  ProposalExpiryHandler,
} from '@/application/groups'
import { getBusinessClock } from '@/composition/cohorts'
import { getDueWorkScheduler, getEventPublisher } from '@/composition/notifications'
import { getAuditWriter, getFileStorage, getOperationLedger } from '@/composition/ops'
import { PgAdvisorCommand } from '@/infrastructure/groups/pg-advisors'
import { PgGroupCommand, PgGroupQuery } from '@/infrastructure/groups/pg-groups'

/**
 * 模組 03 分組的實例組裝（票 13：找組員、提案與成組；票 14：管理員調整組員與換組長；
 * 票 19：指導老師指派、認領與重派）。
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
  })
  return groupCommand
}

export function getGroupCommand(): GroupCommand {
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
  })
  return advisorCommand
}

/**
 * 重派對話框要列的「原老師在本組的評分指派」（模組 06 `listAssignmentsForTeacher`）。
 * 評分模組還沒做：現在一律空清單。評分的票接上時，在這裡換成真的查詢。
 */
const NO_GRADING_YET: AdvisorGradingLookup = { assignmentsFor: async () => [] }

export function getAdvisorGradingLookup(): AdvisorGradingLookup {
  return NO_GRADING_YET
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
} from '@/application/groups'
