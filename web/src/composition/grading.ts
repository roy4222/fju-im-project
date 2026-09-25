import 'server-only'
import type { AssignmentsForTeacherQuery, GradingCommand, GradingQuery } from '@/application/grading'
import { getBusinessClock } from '@/composition/cohorts'
import { getEventPublisher } from '@/composition/notifications'
import { getAuditWriter, getOperationLedger } from '@/composition/ops'
import { MAX_REQUIRED_COUNT, PgGradingCommand, PgGradingQuery } from '@/infrastructure/grading/pg-grading'

/**
 * 模組 06 評分的實例組裝（票 23：評分方案、要求份數、指派、老師暫存與正式送出）。
 * 票 19 重派對話框的「原老師在本組的評分指派」也由這裡的查詢供應（見 `composition/groups.ts`）。
 */
let gradingCommand: GradingCommand | undefined
let gradingQuery: PgGradingQuery | undefined

export function getGradingCommand(): GradingCommand {
  gradingCommand ??= new PgGradingCommand({
    audit: getAuditWriter(),
    ledger: getOperationLedger(),
    events: getEventPublisher(),
    businessClock: getBusinessClock(),
  })
  return gradingCommand
}

function query(): PgGradingQuery {
  gradingQuery ??= new PgGradingQuery()
  return gradingQuery
}

export function getGradingQuery(): GradingQuery {
  return query()
}

export function getAssignmentsForTeacherQuery(): AssignmentsForTeacherQuery {
  return query()
}

export { MAX_REQUIRED_COUNT }

/** app 對 application 只能帶型別；畫面要用的標籤與回饋句子經這裡拿（母 spec §4.3）。 */
export {
  DEFAULT_LETTER_MAP,
  describeAssignEvaluatorReceipt,
  describeDraftReceipt,
  describeFinalReceipt,
  describeFormula,
  describeRequirementReceipt,
  describeSchemeVersionReceipt,
  EVALUATION_STATE_LABEL,
  ITEM_TYPE_LABEL,
  SCHEME_LIMITS,
  SCHEME_STATUS_LABEL,
} from '@/application/grading'
