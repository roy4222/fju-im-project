import type { ResolvedActor } from '@/application/accounts'
import type {
  Cohort,
  CreateCohortInput,
  CreateCohortReceipt,
  SetCohortFlagReceipt,
} from '@/application/cohorts/cohorts'
import type { Result } from '@/shared/result'

/**
 * 模組 02 對外提供的 port（模組實作設計 02 §5；票 5 只交付其中最小的一段）。
 *
 * 實作在 infrastructure，實例由 composition 注入。
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
}

/**
 * 屆別的查詢。這是系統內部的 port，不做授權——呼叫它的頁面或用例自己守門。
 */
export interface CohortStatusQuery {
  /** 全部屆別，新的在前。 */
  list(): Promise<Cohort[]>
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
