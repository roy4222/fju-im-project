import { err, type Err } from '@/shared/result'
import { parseTaipeiDateTime } from '@/shared/time'

/**
 * 模擬業務鐘的純規則（產品模組 02 §4「模擬業務日期規則」2026-09-12 定案；模組實作設計 02 §2、§6）。
 *
 * - 只有測試站（`BUSINESS_CLOCK_OVERRIDE_ENABLED=true`）有；正式站連用例都拒絕。
 * - 可以前進也可以倒退，精確到秒（才能驗截止前後一秒）。
 * - 每次設定留操作者、原因、真實時間、設定前後的業務時間；紀錄只增不改，取最新一筆。
 * - 設定後業務鐘**繼續走**：業務時間＝最新一筆設定的時刻＋從那次設定到現在的真實經過時間。
 * - 只影響階段、開放、截止、到期這些業務判斷；登入、session、稽核的真實時間不受影響。
 */

export const CLOCK_REASON_MAX_LENGTH = 200

/** 一筆設定紀錄（`business_clock_overrides`）。 */
export type ClockOverride = {
  readonly id: string
  readonly environment: 'local' | 'staging'
  readonly businessAt: Date
  readonly realAt: Date
  readonly previousBusinessAt: Date | null
  readonly setByUserId: string
  /** 畫面顯示用；查詢時 join 使用者名稱。 */
  readonly setByName: string | null
  readonly reason: string
}

/** 業務時間＝最新設定的時刻＋自那時起的真實經過時間；沒有任何設定就等於真實時間。 */
export function businessNowFrom(
  latest: Pick<ClockOverride, 'businessAt' | 'realAt'> | null,
  realNow: Date,
): Date {
  if (!latest) return new Date(realNow.getTime())
  return new Date(latest.businessAt.getTime() + (realNow.getTime() - latest.realAt.getTime()))
}

export type SetBusinessClockInput = {
  /** `datetime-local` 的值，當作臺灣時間，例如 `2027-03-01T10:00:00`。 */
  readonly businessAt: string
  readonly reason: string
}

export function normalizeClockInput(
  input: SetBusinessClockInput,
): { ok: true; value: { businessAt: Date; reason: string } } | Err {
  const businessAt = parseTaipeiDateTime(input.businessAt)
  if (!businessAt) {
    return err('VALIDATION_FAILED', '請填要設定的業務時間（年月日與時分秒）。', { details: { field: 'businessAt' } })
  }
  const reason = input.reason.trim()
  if (!reason) return err('VALIDATION_FAILED', '請填原因：為什麼要調整業務時間。', { details: { field: 'reason' } })
  if (reason.length > CLOCK_REASON_MAX_LENGTH) {
    return err('VALIDATION_FAILED', `原因最多 ${CLOCK_REASON_MAX_LENGTH} 個字。`, { details: { field: 'reason' } })
  }
  return { ok: true, value: { businessAt, reason } }
}
