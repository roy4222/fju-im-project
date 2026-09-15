import 'server-only'
import {
  validateNewPassword,
  MIN_PASSWORD_LENGTH,
  type ChangePasswordInput,
  type ChangePasswordOutcome,
  type SelfAccountCommand,
} from '@/application/accounts'
import { getPool } from '@/infrastructure/db/client'
import { changeOwnPassword, getSessionFromHeaders } from '@/infrastructure/auth/wrapper'
import { PgAuditWriter } from '@/infrastructure/ops/audit-writer'
import { createRateLimiter, RATE_LIMITS } from '@/shared/rate-limit'

/**
 * 本人改密碼（S01-05；模組 01 §3 的 must-change → normal）。
 *
 * 順序是有意的：
 * 1. 先確認有 session（沒有就不用往下）。
 * 2. 限速（契約 03 §6：每人每小時 5 次）。
 * 3. 規則檢查（長度、不能跟舊的一樣）。
 * 4. 呼叫 Better Auth 改密並**撤掉其他裝置的 session**。
 * 5. 交易內清 `must_change_password` 並寫稽核。
 *
 * 第 4 步一定要在第 5 步之前：密碼沒改成功就不該清旗標。反過來如果第 5 步失敗，
 * 密碼已經換了但旗標還在——使用者會被要求再改一次，這比「密碼沒換卻放行」安全。
 */

const limiter = createRateLimiter(RATE_LIMITS.changePassword)

/** 測試用：把限速計數清掉。 */
export function resetChangePasswordLimiter(): void {
  limiter.clear()
}

const audit = new PgAuditWriter()

export class BetterAuthSelfAccountCommand implements SelfAccountCommand {
  async changePassword(headers: Headers, input: ChangePasswordInput): Promise<ChangePasswordOutcome> {
    const session = await getSessionFromHeaders(headers)
    if (!session?.user?.id) {
      return { ok: false, code: 'UNAUTHENTICATED', message: '請先登入。' }
    }
    const userId = session.user.id

    const verdict = limiter.hit(`change-password:${userId}`)
    if (!verdict.allowed) {
      return {
        ok: false,
        code: 'VALIDATION_FAILED',
        message: '改密碼的次數太多，請稍後再試。',
        retryAfterMs: verdict.retryAfterMs,
      }
    }

    const problem = validateNewPassword(input.newPassword, input.currentPassword)
    if (problem === 'too_short') {
      return { ok: false, code: 'VALIDATION_FAILED', message: `新密碼至少要 ${MIN_PASSWORD_LENGTH} 個字元。` }
    }
    if (problem === 'same_as_current') {
      return { ok: false, code: 'VALIDATION_FAILED', message: '新密碼不能跟目前的密碼一樣。' }
    }

    try {
      await changeOwnPassword(headers, input)
    } catch {
      // 不分辨「舊密碼錯」與其他失敗：分辨得太細就變成一個可以拿來試密碼的通道。
      return { ok: false, code: 'VALIDATION_FAILED', message: '目前的密碼不正確。' }
    }

    const client = await getPool().connect()
    try {
      await client.query('begin')
      await client.query('update users set must_change_password = false, updated_at = now() where id = $1', [
        userId,
      ])
      await audit.append(client, {
        actorKind: 'user',
        actorUserId: userId,
        action: 'account.change_password',
        targetType: 'user',
        targetId: userId,
        scope: 'global',
        realAt: new Date(),
        businessAt: new Date(),
        // 稽核紀錄不含密碼，連長度都不記（母 spec §4.12）。
        payload: { revokedOtherSessions: true },
      })
      await client.query('commit')
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }

    return { ok: true }
  }
}
