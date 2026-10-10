import 'server-only'
import type { PoolClient } from 'pg'
import type {
  AssignmentsForTeacherQuery,
  GradebookQuery,
  GradingCommand,
  GradingDissolutionHook,
  GradingQuery,
  GradingResultsCommand,
} from '@/application/grading'
import { getBusinessClock } from '@/composition/cohorts'
import { getEventPublisher } from '@/composition/notifications'
import { getAuditWriter, getOperationLedger } from '@/composition/ops'
import { MAX_REQUIRED_COUNT, PgGradingCommand, PgGradingQuery } from '@/infrastructure/grading/pg-grading'
import { PgGradingDissolution } from '@/infrastructure/grading/pg-grading-dissolution'
import { PgGradebookQuery, PgGradingResultsCommand } from '@/infrastructure/grading/pg-grading-results'

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

let resultsCommand: GradingResultsCommand | undefined
let gradebookQuery: GradebookQuery | undefined

/** 票 24：退回、改派三選一、更正與復核、套用新方案版本。 */
export function getGradingResultsCommand(): GradingResultsCommand {
  resultsCommand ??= new PgGradingResultsCommand({
    audit: getAuditWriter(),
    ledger: getOperationLedger(),
    events: getEventPublisher(),
    businessClock: getBusinessClock(),
  })
  return resultsCommand
}

/** 票 24：成績表、計算明細、改派預覽、套用新版本預覽。 */
export function getGradebookQuery(): GradebookQuery {
  gradebookQuery ??= new PgGradebookQuery()
  return gradebookQuery
}

export { MAX_REQUIRED_COUNT }

/** app 對 application 只能帶型別；畫面要用的標籤與回饋句子經這裡拿（母 spec §4.3）。 */
export {
  adoptedFinal,
  DEFAULT_GRADE_EXPORT_FILTER,
  DEFAULT_LETTER_MAP,
  describeAssignEvaluatorReceipt,
  describeFinalFormula,
  describeMissing,
  describeOverride,
  describeOverrideReceipt,
  describeRemoveAssignmentReceipt,
  describeReturnReceipt,
  describeStageFormula,
  describeStageStatus,
  normalizeGradeExportFilter,
  OVERRIDE_STATE_LABEL,
  REMOVAL_CHOICE_LABEL,
  selectExportGroups,
  unassignedSlots,
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

let dissolutionHook: GradingDissolutionHook<PoolClient> | undefined

/** 組別解散時停止評分工作（開站後；由 `composition/groups.ts` 注入分組的解散用例，同交易）。 */
export function getGradingDissolutionHook(): GradingDissolutionHook<PoolClient> {
  dissolutionHook ??= new PgGradingDissolution()
  return dissolutionHook
}
