import 'server-only'
import type {
  BusinessClockCommand,
  BusinessClockQuery,
  BusinessClockSource,
  CohortCommand,
  CohortStatusQuery,
  TimelineCommand,
  TimelineQuery,
} from '@/application/cohorts'
import { businessClockOverrideEnabled, getEventPublisher } from '@/composition/notifications'
import { getAuditWriter, getOperationLedger } from '@/composition/ops'
import { PgBusinessClock } from '@/infrastructure/cohorts/pg-business-clock'
import { PgCohortCommand, PgCohortStatusQuery } from '@/infrastructure/cohorts/pg-cohorts'
import { PgTimelineCommand, PgTimelineQuery } from '@/infrastructure/cohorts/pg-timeline'

/** 模組 02 屆別的實例組裝（票 5、票 11）。 */
let cohortCommand: CohortCommand | undefined
let cohortStatusQuery: CohortStatusQuery | undefined
let timelineCommand: PgTimelineCommand | undefined
let timelineQuery: TimelineQuery | undefined
let businessClock: PgBusinessClock | undefined

function clock(): PgBusinessClock {
  businessClock ??= new PgBusinessClock({
    enabled: businessClockOverrideEnabled(),
    environment: process.env.NODE_ENV === 'development' ? 'local' : 'staging',
    audit: getAuditWriter(),
    ledger: getOperationLedger(),
  })
  return businessClock
}

/**
 * 全站唯一的業務時間來源。凡是「今天第幾階段」「截止了沒」「到期了沒」都從這裡拿，
 * 不要自己 `new Date()`（那是真實時間，給登入、稽核、備份用）。
 */
export function getBusinessClock(): BusinessClockSource {
  return clock()
}

export function getBusinessClockQuery(): BusinessClockQuery {
  return clock()
}

export function getBusinessClockCommand(): BusinessClockCommand {
  return clock()
}

export function getCohortCommand(): CohortCommand {
  cohortCommand ??= new PgCohortCommand({
    audit: getAuditWriter(),
    ledger: getOperationLedger(),
    events: getEventPublisher(),
    businessClock: clock(),
  })
  return cohortCommand
}

export function getCohortStatusQuery(): CohortStatusQuery {
  cohortStatusQuery ??= new PgCohortStatusQuery()
  return cohortStatusQuery
}

function pgTimelineCommand(): PgTimelineCommand {
  timelineCommand ??= new PgTimelineCommand({
    audit: getAuditWriter(),
    ledger: getOperationLedger(),
    events: getEventPublisher(),
    businessClock: clock(),
  })
  return timelineCommand
}

export function getTimelineCommand(): TimelineCommand {
  return pgTimelineCommand()
}

/** 甘特拖階段分界放開後的預覽（③ §9.2 確認框；C3-13）：不寫入，跟 `saveSchedule` 同一個實例。 */
export function getSchedulePreview(): Pick<PgTimelineCommand, 'previewSchedule'> {
  return pgTimelineCommand()
}

export function getTimelineQuery(): TimelineQuery {
  timelineQuery ??= new PgTimelineQuery()
  return timelineQuery
}

export { businessClockOverrideEnabled } from '@/composition/notifications'

/** app 對 application 只能帶型別；畫面要用的標籤、回饋句子與純函式經這裡拿（母 spec §4.3）。 */
export {
  ACTIVITY_AUDIENCE_LABEL,
  ACTIVITY_AUDIENCES,
  ACTIVITY_DESCRIPTION_MAX_LENGTH,
  ACTIVITY_STATUS_LABEL,
  ACTIVITY_TITLE_MAX_LENGTH,
  activityFormValues,
  CLOCK_REASON_MAX_LENGTH,
  COHORT_CODE_MAX_LENGTH,
  COHORT_FLAG_LABEL,
  COHORT_NAME_MAX_LENGTH,
  COHORT_STATUS_LABEL,
  COHORT_STATUS_REASON_MAX_LENGTH,
  cohortLabel,
  describeActivateReceipt,
  describeFlagReceipt,
  describeGroupingSettingsReceipt,
  describeGroupSize,
  describeStagePosition,
  formatActivityWhen,
  GROUP_SIZE_LIMIT,
  groupingDeadline,
  PROPOSAL_DAYS_LIMIT,
  STAGE_COUNT,
  STAGE_DESCRIPTION_MAX_LENGTH,
  STAGE_NAME_MAX_LENGTH,
  stageLastDate,
  stagePositionAt,
  timelineView,
} from '@/application/cohorts'
