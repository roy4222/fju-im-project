import type { ResolvedActor } from '@/application/accounts'
import type { Activity, ActivityInput } from '@/application/cohorts/activities'
import type { ClockOverride, SetBusinessClockInput } from '@/application/cohorts/business-clock'
import type {
  ActivateCohortReceipt,
  Cohort,
  CreateCohortInput,
  CreateCohortReceipt,
  GroupingSettingsInput,
  SetCohortFlagReceipt,
  SetGroupingSettingsReceipt,
} from '@/application/cohorts/cohorts'
import type { CohortSchedule, ScheduleInput, StagePosition } from '@/application/cohorts/stages'
import type { Result } from '@/shared/result'

/**
 * 模組 02 對外提供的 port（模組實作設計 02 §5）。
 *
 * 實作在 infrastructure，實例由 composition 注入。寫入的 port 自己做授權（admin），
 * 查詢的 port 不做授權——呼叫它的頁面或用例自己守門。
 */

export interface CohortCommand {
  /** 新增屆別（狀態一律從「籌備中」開始）。代碼重複回 `CONFLICT`。 */
  create(actor: ResolvedActor, input: CreateCohortInput, requestId: string): Promise<Result<CreateCohortReceipt>>
  /** 設為預設工作屆別；原本持有旗標的屆別在同一個交易裡自動取消。 */
  setDefaultWorking(
    actor: ResolvedActor,
    cohortId: string,
    requestId: string,
  ): Promise<Result<SetCohortFlagReceipt>>
  /** 設為開放註冊屆別；原本持有旗標的屆別在同一個交易裡自動取消。 */
  setRegistrationOpen(
    actor: ResolvedActor,
    cohortId: string,
    requestId: string,
  ): Promise<Result<SetCohortFlagReceipt>>
  /**
   * 籌備中→進行中（票 11）。要先設好階段與年度結束日，否則 `VALIDATION_FAILED`；
   * 同一筆交易寫 `cohort_status_events`、發 `cohort.activated` 事件、留稽核。
   */
  activate(actor: ResolvedActor, cohortId: string, requestId: string): Promise<Result<ActivateCohortReceipt>>
  /**
   * 分組設定（票 13；模組 02 §5 `setProposalDefaultDays` 加上每組人數）：管理員限定、
   * `expectedRevision` 是畫面讀到的屆別 revision，別人先改過回 `CONFLICT`。已封存的屆別不能改。
   */
  setGroupingSettings(
    actor: ResolvedActor,
    cohortId: string,
    input: GroupingSettingsInput,
    expectedRevision: number,
    requestId: string,
  ): Promise<Result<SetGroupingSettingsReceipt>>
}

/**
 * 屆別的查詢。這是系統內部的 port，不做授權——呼叫它的頁面或用例自己守門。
 */
export interface CohortStatusQuery {
  /** 全部屆別，新的在前。 */
  list(): Promise<Cohort[]>
  /** 某一屆；找不到回 `null`。 */
  get(cohortId: string): Promise<Cohort | null>
  /** 目前的預設工作屆別；沒有設定時回 `null`。 */
  defaultWorking(): Promise<Cohort | null>
  /**
   * 目前的開放註冊屆別；沒有設定時回 `null`。
   *
   * 呼叫端拿到 `null` 時**不要自己猜**一屆（例如挑最新的）：模組 02 §4 規定
   * 沒有設定時要提示管理員處理。審核畫面（票 7）就靠這個判斷要不要顯示提示。
   */
  registrationOpen(): Promise<Cohort | null>
}

/** 階段與年度結束日一起存：遞增要一起驗。 */
export type SaveScheduleReceipt = {
  readonly cohortId: string
  readonly code: string
  /** 日期範圍有變、期限版本 +1 的階段序號（1 起）。 */
  readonly changedStages: readonly number[]
}

export type ActivityReceipt = {
  readonly activityId: string
  readonly title: string
  readonly action: 'created' | 'updated' | 'cancelled'
}

/** 階段、年度結束日、獨立活動的寫入（模組 02 §5 `upsertStages`／`setYearEnd`／`upsertEvent`／`cancelEvent`）。 */
export interface TimelineCommand {
  /**
   * 一次存四個階段開始日與年度結束日。開始日不遞增回 `VALIDATION_FAILED`，原資料不動。
   * `expectedRevision` 是畫面讀到的屆別 revision；別人先改過回 `CONFLICT`。
   */
  saveSchedule(
    actor: ResolvedActor,
    cohortId: string,
    input: ScheduleInput,
    expectedRevision: number,
    requestId: string,
  ): Promise<Result<SaveScheduleReceipt>>
  createActivity(
    actor: ResolvedActor,
    cohortId: string,
    input: ActivityInput,
    requestId: string,
  ): Promise<Result<ActivityReceipt>>
  /** 改期或改內容；同一個活動，不是刪掉重建。 */
  updateActivity(
    actor: ResolvedActor,
    activityId: string,
    input: ActivityInput,
    expectedRevision: number,
    requestId: string,
  ): Promise<Result<ActivityReceipt>>
  /** 取消：只標「已取消」，不刪除。 */
  cancelActivity(
    actor: ResolvedActor,
    activityId: string,
    expectedRevision: number,
    requestId: string,
  ): Promise<Result<ActivityReceipt>>
}

/** 階段與活動的查詢（模組 02 §5 `StageQuery`）；不做授權。 */
export interface TimelineQuery {
  schedule(cohortId: string): Promise<CohortSchedule>
  /** 依時間排序；含已取消的，畫面自己分。 */
  activities(cohortId: string): Promise<Activity[]>
  /** 某個業務時間落在哪一段。 */
  currentStage(cohortId: string, businessAt: Date): Promise<StagePosition>
}

/**
 * 業務時間的唯一來源（模組 02 §5 `BusinessClock`）。所有「今天」的判斷都從這裡拿。
 *
 * 正式站＝真實時間；測試站＝最新一筆模擬設定＋之後的真實經過時間。
 * 讀資料庫，所以是非同步；一個用例（或一次頁面渲染）開頭讀一次，之後都用那個值。
 */
export interface BusinessClockSource {
  now(): Promise<Date>
}

export type SetBusinessClockReceipt = {
  readonly businessAt: string
  readonly previousBusinessAt: string
}

export type BusinessClockState = {
  /** 這個環境有沒有模擬業務鐘（`BUSINESS_CLOCK_OVERRIDE_ENABLED`）。 */
  readonly enabled: boolean
  readonly realNow: Date
  readonly businessNow: Date
  readonly latest: ClockOverride | null
}

export interface BusinessClockCommand {
  /** 正式站一律 `FORBIDDEN`（先於角色檢查）；測試站只有管理員能設。 */
  set(actor: ResolvedActor, input: SetBusinessClockInput, requestId: string): Promise<Result<SetBusinessClockReceipt>>
}

export interface BusinessClockQuery {
  state(): Promise<BusinessClockState>
  /** 設定紀錄，新的在前。 */
  history(limit: number): Promise<ClockOverride[]>
}
