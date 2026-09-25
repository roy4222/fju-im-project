/**
 * 模組 02 屆別與年度流程的公開入口（母 spec §4.3）。
 *
 * 跨模組只能從這裡引用，而且只能帶型別；執行期的實作由 composition 注入。
 */
export type {
  ActivateCohortReceipt,
  Cohort,
  CohortFlag,
  CohortStatus,
  CreateCohortInput,
  CreateCohortReceipt,
  GroupingSettingsInput,
  SetCohortFlagReceipt,
  SetGroupingSettingsReceipt,
} from '@/application/cohorts/cohorts'
export {
  canManageCohorts,
  COHORT_CODE_MAX_LENGTH,
  COHORT_FLAG_LABEL,
  COHORT_FLAGS,
  COHORT_NAME_MAX_LENGTH,
  COHORT_STATUS_LABEL,
  describeActivateReceipt,
  describeFlagReceipt,
  describeGroupingSettingsReceipt,
  describeGroupSize,
  GROUP_SIZE_LIMIT,
  isCohortId,
  isRequestId,
  normalizeCreateInput,
  normalizeGroupingSettings,
  PROPOSAL_DAYS_LIMIT,
} from '@/application/cohorts/cohorts'
export type {
  CohortSchedule,
  ScheduleInput,
  Stage,
  StageInput,
  StagePlan,
  StagePosition,
  StageStatus,
  TimelineStage,
  TimelineView,
} from '@/application/cohorts/stages'
export {
  describeStagePosition,
  groupingDeadline,
  normalizeScheduleInput,
  planStageVersions,
  STAGE_COUNT,
  STAGE_NAME_MAX_LENGTH,
  stageLastDate,
  stagePositionAt,
  timelineView,
} from '@/application/cohorts/stages'
export type {
  Activity,
  ActivityAudience,
  ActivityInput,
  ActivityStatus,
  NormalizedActivity,
} from '@/application/cohorts/activities'
export {
  ACTIVITY_AUDIENCE_LABEL,
  ACTIVITY_AUDIENCES,
  ACTIVITY_DESCRIPTION_MAX_LENGTH,
  ACTIVITY_STATUS_LABEL,
  ACTIVITY_TITLE_MAX_LENGTH,
  activityFormValues,
  formatActivityWhen,
  normalizeActivityInput,
} from '@/application/cohorts/activities'
export type { ClockOverride, SetBusinessClockInput } from '@/application/cohorts/business-clock'
export { businessNowFrom, CLOCK_REASON_MAX_LENGTH, normalizeClockInput } from '@/application/cohorts/business-clock'
export type {
  ActivityReceipt,
  BusinessClockCommand,
  BusinessClockQuery,
  BusinessClockSource,
  BusinessClockState,
  CohortCommand,
  CohortStatusQuery,
  SaveScheduleReceipt,
  SetBusinessClockReceipt,
  StudentTimeline,
  TimelineCommand,
  TimelineQuery,
} from '@/application/cohorts/ports'
