import 'server-only'
import { getPool } from '@/infrastructure/db/client'

/** 帳號狀態（契約 01 §4.1 `users.status`；`deidentified` 由去識別化用例寫）。 */
export type AccountStatus = 'pending' | 'active' | 'disabled' | 'deidentified'

/**
 * 帳號的業務狀態（契約 03 §2、§3）。
 *
 * **一律從資料庫讀**，不看 session 物件上的快照，也不看 Better Auth 的 `banned`。
 * 理由寫在契約 03 §3 與模組 01 v2.4 規則 6：`banUser` 是 commit 後的外部呼叫，
 * 可能還沒完成或失敗重試中；業務上已經停用的人**在那段落差期間不能被放行**。
 * 所以入口層的判斷來源只有 `users.status` 與 `users.must_change_password`。
 */

export type AccountState = {
  readonly status: AccountStatus
  readonly mustChangePassword: boolean
}

/** 讀某個人現在的業務狀態；查不到（列不存在）回 null，呼叫端當成未登入。 */
export async function readAccountState(userId: string): Promise<AccountState | null> {
  const rows = await getPool().query<{
    status: string
    must_change_password: boolean
    deidentified_at: Date | null
  }>('select status, must_change_password, deidentified_at from users where id = $1', [userId])

  const row = rows.rows[0]
  if (!row) return null
  return {
    // 去識別化過的帳號即使 `status` 還沒改，也一律當作已失效（契約 03 §3）。
    status: row.deidentified_at ? 'deidentified' : (row.status as AccountStatus),
    mustChangePassword: row.must_change_password,
  }
}

/** 這個狀態還算不算「有效的登入」。停用與去識別化一律當作未登入。 */
export function isUsableSession(state: AccountState): boolean {
  return state.status === 'pending' || state.status === 'active'
}

/** 這個狀態能不能用只給 active 的能力（連結另一種登入方式、列出登入方式）。 */
export function isFullyActive(state: AccountState): boolean {
  return state.status === 'active' && !state.mustChangePassword
}
