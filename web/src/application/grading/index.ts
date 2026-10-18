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
export type { GradingDissolutionHook } from '@/application/grading/dissolution'
export { EVALUATION_STATE_LABEL, normalizeScores, summarizeScores } from '@/application/grading/evaluation'
export type {
  CountedEvaluation,
  CountedLine,
  GroupResult,
  OverrideState,
  OverrideSummary,
  RemovalChoice,
  StageResult,
  StageStatus,
} from '@/application/grading/gradebook'
export {
  adoptedFinal,
  applyRemovalChoice,
  computeGroupResult,
  computeStage,
  describeFinalFormula,
  describeOverride,
  describeStageFormula,
  describeStageStatus,
  OVERRIDE_STATE_LABEL,
  REMOVAL_CHOICE_LABEL,
  STAGE_STATUS_LABEL,
} from '@/application/grading/gradebook'
export type {
  GradeExportFilter,
  GradeExportFormat,
  GradeExportRequest,
  GradeExportResult,
  GradeExportStatus,
  GradeExporter,
} from '@/application/grading/export'
export {
  buildGradeCsv,
  DEFAULT_GRADE_EXPORT_FILTER,
  describeMissing,
  gradeExportHeader,
  gradeExportRows,
  normalizeGradeExportFilter,
  normalizeGradeExportRequest,
  selectExportGroups,
  unassignedSlotDetails,
  unassignedSlots,
} from '@/application/grading/export'
export type { UnassignedSlot } from '@/application/grading/export'
export type {
  ApplySchemeInput,
  AssignmentHistoryEntry,
  EvaluationHistoryEntry,
  Gradebook,
  GradebookGroup,
  GradebookQuery,
  GradingResultsCommand,
  GroupGradeDetail,
  MissingEvaluation,
  OverrideInput,
  OverrideReceipt,
  OverrideView,
  PendingReview,
  ReassignmentOption,
  ReassignmentPreview,
  RemoveAssignmentInput,
  RemoveAssignmentReceipt,
  ResolveReviewInput,
  ReturnEvaluationInput,
  ReturnNotice,
  ReturnReceipt,
  SchemeApplyPreview,
} from '@/application/grading/ports'
export type {
  AdminAssignmentView,
  AdminGradingBoard,
  AssignEvaluatorInput,
  AssignEvaluatorReceipt,
  AssignmentsForTeacherQuery,
  BenchEntry,
  CohortGradingSnapshot,
  CreateSchemeVersionInput,
  DraftReceipt,
  FinalReceipt,
  GradingCommand,
  GradingProgressSummary,
  GradingQuery,
  GradingSettlementCommand,
  GradingSettlementQuery,
  GradingSnapshotQuery,
  ReleaseReceipt,
  RequirementReceipt,
  SchemeVersionReceipt,
  SchemeVersionView,
  ScoresInput,
  SetRequirementInput,
  Settlement,
  SettlementHistory,
  SettlementReceipt,
  TeacherBench,
  TeacherBenchPage,
  TeacherGroupAssignment,
  TeacherQueueEntry,
} from '@/application/grading/ports'
export type {
  GradingStageSettingCommand,
  GradingStageSettingQuery,
  PublicGradingQuery,
  PublicGradingWeights,
  SetStageSettingInput,
  StageSetting,
} from '@/application/grading/ports'
export type { PanelGroupFacts, StageSettingFields } from '@/application/grading/stage-settings'
export {
  describePanelMismatch,
  MAX_PANEL_KEY_LENGTH,
  MAX_STAGE_DESCRIPTION_LENGTH,
  normalizeStageSetting,
  optionalReason,
  panelMismatches,
  panelStageKeys,
} from '@/application/grading/stage-settings'
export type { StageProgressRow } from '@/application/grading/snapshot'
export { deriveStageRows } from '@/application/grading/snapshot'
export type { GroupVersionWithFiles } from '@/application/submissions'
export {
  describeAssignEvaluatorReceipt,
  describeDraftReceipt,
  describeFinalReceipt,
  describeOverrideReceipt,
  describeRemoveAssignmentReceipt,
  describeRequirementReceipt,
  describeReturnReceipt,
  describeSchemeVersionReceipt,
} from '@/application/grading/receipts'
