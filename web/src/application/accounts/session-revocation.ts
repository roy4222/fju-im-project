import type { AccountStatus } from '@/application/accounts/actor'

/**
 * 撤 session 的工作列與收斂核對的純規則（模組實作設計 01 附錄 A `session_revocations` v2.4，規則 1–6）。
 *
 * 業務狀態只看 `users.status`（入口層一律以它拒絕，規則 6）；Better Auth 的 `banned` 是第二層，
 * 由 `SessionRevocationExecutor` 依工作列把它拉到跟業務狀態一致。這個檔只放「該怎麼判」：
 * 應有的 banned 值、工作種類、收斂輪次與上限，資料庫與外部呼叫在 infrastructure。
 */

export type RevocationKind = 'ban' | 'unban' | 'revoke_all'

/** 工作成立時使用者應處的狀態（`expected_user_status`）。pending 不做撤 session。 */
export type RevocationTargetStatus = 'disabled' | 'active' | 'deidentified'

export type ReconcileReason = 'after_completion' | 'periodic' | 'manual_retry'

/** 租約：認領後 30 秒內沒完成＝外部結果未知，允許他人接手（規則 2）。 */
export const REVOCATION_LEASE_SECONDS = 30

/** 外部呼叫逾時（規則 3）。 */
export const REVOCATION_CALL_TIMEOUT_MS = 10_000

/** 自動收斂（after_completion／periodic）的輪次上限（規則 5）。 */
export const RECONCILE_ROUND_LIMIT = 10

/** worker 週期核對的觀察集合：24 小時內有任何工作列，或 7 天內有結果未知的列（規則 5）。 */
export const RECONCILE_RECENT_HOURS = 24
export const RECONCILE_UNKNOWN_OUTCOME_DAYS = 7

/** worker 週期核對的間隔（規則 5：每 5 分鐘）。 */
export const RECONCILE_INTERVAL_SECONDS = 5 * 60

/** 業務狀態 → 撤 session 工作的目標狀態。pending 不核對（回 null）。 */
export function revocationTargetOf(status: AccountStatus): RevocationTargetStatus | null {
  if (status === 'pending') return null
  return status
}

/** disabled→ban、active→unban、deidentified→revoke_all（附錄 A `kind` 欄）。 */
export function revocationKindFor(target: RevocationTargetStatus): RevocationKind {
  if (target === 'disabled') return 'ban'
  if (target === 'active') return 'unban'
  return 'revoke_all'
}

/** 依業務狀態，Better Auth 的 `banned` 應該是什麼。pending 不核對（null）。 */
export function expectedBannedFor(status: AccountStatus): boolean | null {
  if (status === 'disabled' || status === 'deidentified') return true
  if (status === 'active') return false
  return null
}

/**
 * 收斂工作的輪次（規則 5）：
 * - 自動原因：同一個 `status_event_id` 下前一筆自動收斂的 round＋1，沒有則 1。
 * - `manual_retry`：沿用前一筆的 round（不加），沒有則 1。
 */
export function nextReconcileRound(previousRound: number | null, reason: ReconcileReason): number {
  if (previousRound === null || previousRound < 1) return 1
  return reason === 'manual_retry' ? previousRound : previousRound + 1
}

/** 自動收斂算出的輪次到上限：仍插入該列但直接 failed `RECONCILE_LIMIT`＋稽核＋告警。 */
export function reachesReconcileLimit(round: number, reason: ReconcileReason): boolean {
  return reason !== 'manual_retry' && round >= RECONCILE_ROUND_LIMIT
}
