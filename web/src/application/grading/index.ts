/**
 * 模組 06 評分與成績的公開入口（母 spec §4.3）。票 23：評分方案、要求份數、指派、暫存與正式送出。
 *
 * 跨模組只能從這裡引用，而且只能帶型別；執行期的實作由 composition 注入。
 */
export type {
  SchemeItem,
  SchemeItemInput,
  SchemeItemType,
  SchemeStage,
  SchemeStageInput,
  SchemeVersionStatus,
  ReservedSchemeKeys,
} from '@/application/grading/scheme'
export {
  collectSchemeKeys,
  DEFAULT_LETTER_MAP,
  describeFormula,
  ITEM_TYPE_LABEL,
  normalizeSchemeStages,
  readSchemeStages,
  SCHEME_LIMITS,
  SCHEME_STATUS_LABEL,
} from '@/application/grading/scheme'
export type { EvaluationState, ScoreInput } from '@/application/grading/evaluation'
export { EVALUATION_STATE_LABEL, normalizeScores, summarizeScores } from '@/application/grading/evaluation'
export type {
  AdminAssignmentView,
  AdminGradingBoard,
  AssignEvaluatorInput,
  AssignEvaluatorReceipt,
  AssignmentsForTeacherQuery,
  BenchEntry,
  CreateSchemeVersionInput,
  DraftReceipt,
  FinalReceipt,
  GradingCommand,
  GradingQuery,
  RequirementReceipt,
  SchemeVersionReceipt,
  SchemeVersionView,
  ScoresInput,
  SetRequirementInput,
  TeacherBench,
  TeacherGroupAssignment,
  TeacherQueueEntry,
} from '@/application/grading/ports'
export {
  describeAssignEvaluatorReceipt,
  describeDraftReceipt,
  describeFinalReceipt,
  describeRequirementReceipt,
  describeSchemeVersionReceipt,
} from '@/application/grading/receipts'
