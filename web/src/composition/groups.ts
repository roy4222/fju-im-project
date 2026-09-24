import 'server-only'
import type { GroupCommand, GroupQuery, ProposalExpiryHandler } from '@/application/groups'
import { getBusinessClock } from '@/composition/cohorts'
import { getDueWorkScheduler, getEventPublisher } from '@/composition/notifications'
import { getAuditWriter, getOperationLedger } from '@/composition/ops'
import { PgGroupCommand, PgGroupQuery } from '@/infrastructure/groups/pg-groups'

/** 模組 03 分組的實例組裝（票 13：找組員、提案與成組；票 14：管理員調整組員與換組長）。 */
let groupCommand: PgGroupCommand | undefined
let groupQuery: GroupQuery | undefined

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

/**
 * `due_work(kind='proposal_expiry', subject_type='group_proposal')` 的處理器。
 * 背景工作（票 12）到期時以 `expire(subject_id, deadline_version)` 呼叫；重跑安全。
 */
export function getProposalExpiryHandler(): ProposalExpiryHandler {
  return command()
}

/** app 對 application 只能帶型別；畫面要用的標籤與回饋句子經這裡拿（母 spec §4.3）。 */
export {
  CHANGE_REASON_MAX_LENGTH,
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
