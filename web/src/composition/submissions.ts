import 'server-only'
import type { RosterQuery, SubmissionCommand, SubmissionQuery } from '@/application/submissions'
import { getBusinessClock } from '@/composition/cohorts'
import { getAuditWriter, getOperationLedger } from '@/composition/ops'
import { PgRosterQuery } from '@/infrastructure/submissions/pg-roster'
import { PgSubmissionCommand, PgSubmissionQuery } from '@/infrastructure/submissions/pg-submissions'

/** 模組 05 個人與組別繳交的實例組裝（票 17：個人填報、存草稿、正式送出、自己的版本；票 18：收件名單頁）。 */
let submissionCommand: SubmissionCommand | undefined
let submissionQuery: SubmissionQuery | undefined
let rosterQuery: RosterQuery | undefined

export function getSubmissionCommand(): SubmissionCommand {
  submissionCommand ??= new PgSubmissionCommand({
    audit: getAuditWriter(),
    ledger: getOperationLedger(),
    businessClock: getBusinessClock(),
  })
  return submissionCommand
}

export function getSubmissionQuery(): SubmissionQuery {
  submissionQuery ??= new PgSubmissionQuery()
  return submissionQuery
}

export function getRosterQuery(): RosterQuery {
  rosterQuery ??= new PgRosterQuery()
  return rosterQuery
}

/** app 對 application 只能帶型別；畫面要用的狀態字、檢查與回執句子經這裡拿（母 spec §4.3）。 */
export {
  answerFields,
  categoryOf,
  completionOf,
  describeReceipt,
  FILE_UPLOAD_PENDING_MESSAGE,
  LINE_MAX_LENGTH,
  pendingCount,
  phaseOf,
  receiverStatus,
  statusOf,
  submitIssues,
  TEXTAREA_MAX_LENGTH,
} from '@/application/submissions'
