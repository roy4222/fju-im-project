import 'server-only'
import { uuidv7 } from 'uuidv7'
import { getPool } from '@/infrastructure/db/client'
import { createRateLimiter, RATE_LIMITS } from '@/shared/rate-limit'

/**
 * 改密碼的業務規則（模組 01 §3、契約 03 §2、§6）。
 *
 * **放在 Better Auth 的 hook 裡，不是放在用例裡。**
 * 2026-09-16 review（Spec 3）重現過：規則只寫在 `SelfAccountCommand` 上的話，
 * 持有效 session 直接 `POST /api/auth/change-password` 就整組繞過去——
 * 8 個字元的新密碼被接受、另一台裝置的登入還在、稽核一筆都沒有。
 * 寫在 hook 裡，HTTP 與 Server Action 走的是同一段程式。
 */

/** 新密碼長度下限。 */
export const MIN_PASSWORD_LENGTH = 12

export type PasswordProblem = 'too_short' | 'same_as_current'

export function validateNewPassword(
  newPassword: string,
  currentPassword: string,
): PasswordProblem | null {
  if (newPassword.length < MIN_PASSWORD_LENGTH) return 'too_short'
  // 「改密碼」卻填一樣的，等於沒改——一次性密碼還是有效的，這不是我們要的結果。
  if (newPassword === currentPassword) return 'same_as_current'
  return null
}

const limiter = createRateLimiter(RATE_LIMITS.changePassword)

/** 契約 03 §6：每人每小時 5 次。 */
export function checkChangePasswordRate(userId: string) {
  return limiter.hit(`change-password:${userId}`)
}

/** 測試用：清掉改密的限速計數。 */
export function resetChangePasswordLimiter(): void {
  limiter.clear()
}

/**
 * 改密成功之後要留下的痕跡：清掉 must-change 旗標、寫一筆稽核。
 *
 * 同一個交易；稽核**不含密碼**，連長度都不記（母 spec §4.12）。
 */
export async function recordPasswordChanged(userId: string): Promise<void> {
  const client = await getPool().connect()
  try {
    await client.query('begin')
    await client.query(
      'update users set must_change_password = false, updated_at = now() where id = $1',
      [userId],
    )
    await client.query(
      `insert into audit_events
         (id, actor_kind, actor_user_id, action, target_type, target_id, scope, real_at, business_at, payload)
       values ($1, 'user', $2, 'account.change_password', 'user', $2, 'global', now(), now(), $3::jsonb)`,
      [uuidv7(), userId, JSON.stringify({ revokedOtherSessions: true })],
    )
    await client.query('commit')
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    client.release()
  }
}
