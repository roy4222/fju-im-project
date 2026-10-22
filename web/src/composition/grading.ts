import 'server-only'
import type {
  AssignmentsForTeacherQuery,
  GradebookQuery,
  GradingCommand,
  GradingQuery,
  GradingResultsCommand,
  GradingSettlementCommand,
  GradingSettlementQuery,
  GradingSnapshotQuery,
  GradingStageSettingCommand,
  GradingStageSettingQuery,
  PublicGradingQuery,
} from '@/application/grading'
import { getBusinessClock } from '@/composition/cohorts'
import { getEventPublisher } from '@/composition/notifications'
import { getAuditWriter, getOperationLedger } from '@/composition/ops'
import { getAdvisorSubmissionQuery } from '@/composition/submissions'
import { getPool } from '@/infrastructure/db/client'
import { PgGradingSettlementCommand, PgGradingSettlementQuery } from '@/infrastructure/grading/pg-grade-settlements'
import { MAX_COMMENT_LENGTH, MAX_REQUIRED_COUNT, PgGradingCommand, PgGradingQuery } from '@/infrastructure/grading/pg-grading'
import { PgGradebookQuery, PgGradingResultsCommand } from '@/infrastructure/grading/pg-grading-results'
import { PgGradingSnapshotQuery } from '@/infrastructure/grading/pg-grading-snapshot'
import { PgPublicGradingQuery } from '@/infrastructure/grading/pg-public-grading'
import { PgGradingStageSettingCommand, PgGradingStageSettingQuery } from '@/infrastructure/grading/pg-stage-settings'

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

let teacherGradingQuery: PgGradingQuery | undefined

/** 老師評分頁用：多注入模組 05 的繳交查詢（`teacherBenchPage` 的本組正式繳交與附件，TE-11）。 */
export function getGradingQuery(): GradingQuery {
  teacherGradingQuery ??= new PgGradingQuery(getPool, getAdvisorSubmissionQuery())
  return teacherGradingQuery
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

let settlementCommand: GradingSettlementCommand | undefined
let settlementQuery: GradingSettlementQuery | undefined

/** B 階段 TE-B2a：系辦結算、解除結算（不發通知）。 */
export function getGradingSettlementCommand(): GradingSettlementCommand {
  settlementCommand ??= new PgGradingSettlementCommand({
    audit: getAuditWriter(),
    ledger: getOperationLedger(),
    businessClock: getBusinessClock(),
  })
  return settlementCommand
}

/** B 階段 TE-B2a：老師與系辦讀現行結算；系辦讀結算紀錄。 */
export function getGradingSettlementQuery(): GradingSettlementQuery {
  settlementQuery ??= new PgGradingSettlementQuery()
  return settlementQuery
}

let snapshotQuery: GradingSnapshotQuery | undefined

/**
 * B 階段 TE-B6：屆別評分快照（設計方案 §4.2）。**只給系辦成績管理頁**（`app/dashboard/admin/grading/page.tsx`）用；
 * 首頁、評分規則頁、計算明細頁照舊用 `adminBoard`／`gradebook`。
 */
export function getGradingSnapshotQuery(): GradingSnapshotQuery {
  snapshotQuery ??= new PgGradingSnapshotQuery()
  return snapshotQuery
}

let stageSettingCommand: GradingStageSettingCommand | undefined
let stageSettingQuery: GradingStageSettingQuery | undefined
let publicGradingQuery: PublicGradingQuery | undefined

/** C 階段 C1-04：系辦設定評分項目的對應作業、說明、評審組（側表；不建新版、不鎖）。 */
export function getGradingStageSettingCommand(): GradingStageSettingCommand {
  stageSettingCommand ??= new PgGradingStageSettingCommand({
    audit: getAuditWriter(),
    ledger: getOperationLedger(),
    businessClock: getBusinessClock(),
  })
  return stageSettingCommand
}

/** C 階段 C1-04：系辦讀一屆的側表（評分規則分頁）。 */
export function getGradingStageSettingQuery(): GradingStageSettingQuery {
  stageSettingQuery ??= new PgGradingStageSettingQuery()
  return stageSettingQuery
}

/** C 階段 C1-04（X7）：前台 /rules「評分方式」區塊；訪客可讀，不帶任何分數。 */
export function getPublicGradingQuery(): PublicGradingQuery {
  publicGradingQuery ??= new PgPublicGradingQuery()
  return publicGradingQuery
}

export { MAX_COMMENT_LENGTH, MAX_REQUIRED_COUNT }

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
  deriveStageRows,
  normalizeGradeExportFilter,
  OVERRIDE_STATE_LABEL,
  REMOVAL_CHOICE_LABEL,
  selectExportGroups,
  unassignedSlotDetails,
  unassignedSlots,
  MAX_PANEL_KEY_LENGTH,
  MAX_STAGE_DESCRIPTION_LENGTH,
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
