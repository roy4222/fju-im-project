import type { ResolvedActor } from '@/application/accounts'
import { err, type Err } from '@/shared/result'

/**
 * 屆別的型別與純規則（模組 02 §4「11.3 屆別與封存」「開放註冊屆別」；模組實作設計 02 §2、§3）。
 *
 * 這個檔沒有資料庫也沒有框架：代碼怎麼驗、誰能管理屆別、兩個旗標叫什麼，
 * 都是規則問題，放在這裡單獨測。寫入與交易在 infrastructure。
 *
 * 票 5 交付「建立屆別」與「設預設工作屆別／開放註冊屆別」；票 11 加上「轉進行中」
 * （留 `cohort_status_events`）、階段與活動。封存與解封在後面的票（S13）。
 */

export type CohortStatus = 'preparing' | 'active' | 'archived'

export const COHORT_STATUS_LABEL: Record<CohortStatus, string> = {
  preparing: '籌備中',
  active: '進行中',
  archived: '已封存',
}

export type Cohort = {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly status: CohortStatus
  readonly isDefaultWorking: boolean
  readonly isRegistrationOpen: boolean
  /** 年度結束日（臺灣日期，含當天）；還沒設是 null。 */
  readonly yearEndDate: string | null
  /** 提案預設有效天數（票 13；預設 7）。 */
  readonly proposalDefaultDays: number
  /** 每組人數下限與上限（2026-09-24 定案；預設都是 5）。學生提案的人數（含自己）要落在這個範圍。 */
  readonly groupSizeMin: number
  readonly groupSizeMax: number
  readonly revision: number
  readonly createdAt: Date
}

/**
 * 全系同時只能各有一個屆別的兩個旗標（`cohorts` 上各有一條部分唯一索引）。
 *
 * - 預設工作屆別：管理員操作時預設看哪一屆。
 * - 開放註冊屆別：沒命中名單的註冊者，核准時預設帶入哪一屆。
 *
 * 兩件事刻意分開：新生開始註冊時上一屆可能還沒結束（模組 02 §4「開放註冊屆別」）。
 */
export type CohortFlag = 'defaultWorking' | 'registrationOpen'

export const COHORT_FLAG_LABEL: Record<CohortFlag, string> = {
  defaultWorking: '預設工作屆別',
  registrationOpen: '開放註冊屆別',
}

export const COHORT_FLAGS: readonly CohortFlag[] = ['defaultWorking', 'registrationOpen']

export type CreateCohortInput = {
  readonly code: string
  readonly name: string
}

export const COHORT_CODE_MAX_LENGTH = 20
export const COHORT_NAME_MAX_LENGTH = 40

/** 代碼只收英數、連字號與底線（例如 `115`、`115-TEST`），網址與匯出檔名才不會出事。 */
const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

/**
 * 驗證並整理「新增屆別」的輸入。前後空白一律去掉；代碼大小寫照使用者輸入保留。
 */
export function normalizeCreateInput(input: CreateCohortInput): { ok: true; value: CreateCohortInput } | Err {
  const code = input.code.trim()
  const name = input.name.trim()

  if (!code) return err('VALIDATION_FAILED', '請填屆別代碼。', { details: { field: 'code' } })
  if (code.length > COHORT_CODE_MAX_LENGTH) {
    return err('VALIDATION_FAILED', `屆別代碼最多 ${COHORT_CODE_MAX_LENGTH} 個字元。`, {
      details: { field: 'code' },
    })
  }
  if (!CODE_PATTERN.test(code)) {
    return err('VALIDATION_FAILED', '屆別代碼只能用英文字母、數字、連字號（-）與底線（_），而且要以英數開頭。', {
      details: { field: 'code' },
    })
  }
  if (!name) return err('VALIDATION_FAILED', '請填屆別名稱。', { details: { field: 'name' } })
  if (name.length > COHORT_NAME_MAX_LENGTH) {
    return err('VALIDATION_FAILED', `屆別名稱最多 ${COHORT_NAME_MAX_LENGTH} 個字元。`, {
      details: { field: 'name' },
    })
  }

  return { ok: true, value: { code, name } }
}

/**
 * 誰能管理屆別：有 admin 角色的人。
 *
 * 帳號狀態（停用、待審、必須改密）由模組 01 的狀態閘門先擋；這裡只回答角色。
 * 刻意不引用 accounts 的 `hasRole`：跨模組只能帶型別（母 spec §4.3）。
 */
export function canManageCohorts(actor: ResolvedActor): boolean {
  return actor.kind === 'authenticated' && actor.roles.includes('admin')
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 請求編號必須是 uuid（`operation_records.request_id` 的型別）。 */
export function isRequestId(value: string): boolean {
  return UUID_PATTERN.test(value)
}

/** 屆別 id 也是 uuid；格式不對直接當作找不到，不丟給資料庫報型別錯。 */
export function isCohortId(value: string): boolean {
  return UUID_PATTERN.test(value)
}

/** 建立成功的回執內容。 */
export type CreateCohortReceipt = {
  readonly cohortId: string
  readonly code: string
  readonly name: string
}

/** 設旗標成功的回執內容：一併說清楚原本是哪一屆被取消。 */
export type SetCohortFlagReceipt = {
  readonly flag: CohortFlag
  readonly cohortId: string
  readonly code: string
  /** 原本持有這個旗標的屆別；原本就沒有，或原本就是這一屆時為 null。 */
  readonly previousCohortId: string | null
  readonly previousCode: string | null
}

/** 畫面上的一句回饋。放這裡是為了讓「重播」與「第一次」講同一句話。 */
export function describeFlagReceipt(receipt: SetCohortFlagReceipt): string {
  const label = COHORT_FLAG_LABEL[receipt.flag]
  if (receipt.previousCode) {
    return `已把 ${receipt.code} 設為${label}；${receipt.previousCode} 的${label}已自動取消。`
  }
  return `已把 ${receipt.code} 設為${label}。`
}

/** 轉進行中的回執。 */
export type ActivateCohortReceipt = {
  readonly cohortId: string
  readonly code: string
  /** 原本就是進行中：沒有改任何資料、也沒有多一筆狀態紀錄。 */
  readonly alreadyActive: boolean
}

export function describeActivateReceipt(receipt: ActivateCohortReceipt): string {
  return receipt.alreadyActive
    ? `${receipt.code} 本來就是進行中。`
    : `已把 ${receipt.code} 轉為進行中，狀態紀錄多了一筆。`
}

/**
 * 分組設定（票 13；2026-09-24 Roy 定案＋產品模組 03「提案終止」）：每組最少／最多人數、提案預設天數。
 *
 * 欄位在 `cohorts` 上（模組 02 附錄 A `proposal_default_days`，加上每組人數兩欄）。
 * 上限只是防呆：人數最多 10、天數最多 60；到期時間本來就會被「成組截止」截短。
 */
export const GROUP_SIZE_LIMIT = 10
export const PROPOSAL_DAYS_LIMIT = 60

export type GroupingSettingsInput = {
  readonly groupSizeMin: number
  readonly groupSizeMax: number
  readonly proposalDefaultDays: number
}

export type SetGroupingSettingsReceipt = {
  readonly cohortId: string
  readonly code: string
  readonly groupSizeMin: number
  readonly groupSizeMax: number
  readonly proposalDefaultDays: number
}

function wholeNumber(value: number): boolean {
  return Number.isInteger(value)
}

export function normalizeGroupingSettings(
  input: GroupingSettingsInput,
): { ok: true; value: GroupingSettingsInput } | Err {
  const { groupSizeMin, groupSizeMax, proposalDefaultDays } = input
  if (!wholeNumber(groupSizeMin) || groupSizeMin < 1 || groupSizeMin > GROUP_SIZE_LIMIT) {
    return err('VALIDATION_FAILED', `每組最少人數要是 1 到 ${GROUP_SIZE_LIMIT} 的整數。`, {
      details: { field: 'groupSizeMin' },
    })
  }
  if (!wholeNumber(groupSizeMax) || groupSizeMax < 1 || groupSizeMax > GROUP_SIZE_LIMIT) {
    return err('VALIDATION_FAILED', `每組最多人數要是 1 到 ${GROUP_SIZE_LIMIT} 的整數。`, {
      details: { field: 'groupSizeMax' },
    })
  }
  if (groupSizeMin > groupSizeMax) {
    return err('VALIDATION_FAILED', `最少人數（${groupSizeMin}）不能比最多人數（${groupSizeMax}）多。`, {
      details: { field: 'groupSizeMin' },
    })
  }
  if (!wholeNumber(proposalDefaultDays) || proposalDefaultDays < 1 || proposalDefaultDays > PROPOSAL_DAYS_LIMIT) {
    return err('VALIDATION_FAILED', `提案預設天數要是 1 到 ${PROPOSAL_DAYS_LIMIT} 的整數。`, {
      details: { field: 'proposalDefaultDays' },
    })
  }
  return { ok: true, value: { groupSizeMin, groupSizeMax, proposalDefaultDays } }
}

/** 「每組 5 人」或「每組 3–5 人」。 */
export function describeGroupSize(min: number, max: number): string {
  return min === max ? `每組 ${min} 人` : `每組 ${min}–${max} 人`
}

export function describeGroupingSettingsReceipt(receipt: SetGroupingSettingsReceipt): string {
  return `已儲存 ${receipt.code} 的分組設定：${describeGroupSize(receipt.groupSizeMin, receipt.groupSizeMax)}、提案 ${receipt.proposalDefaultDays} 天內要全員確認。`
}
