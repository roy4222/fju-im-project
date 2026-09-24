import 'server-only'
import type { ChangePasswordInput, ChangePasswordOutcome, SelfAccountCommand } from '@/application/accounts'
import { changeOwnPassword, getSessionFromHeaders } from '@/infrastructure/auth/wrapper'

/**
 * 本人改密碼（S01-05；模組 01 §3 的 must-change → normal）。
 *
 * **業務規則不在這裡**：長度、不可與舊密碼相同、限速、撤其他裝置、清 must-change 旗標
 * 與稽核，全部在 Better Auth 的 hook 裡（`change-password-rules.ts`）。
 *
 * 原因是 2026-09-16 review 重現過的缺口：規則只寫在這個用例上的話，
 * 持有效 session 直接 `POST /api/auth/change-password` 就整組繞過去。
 * 現在這個類別只做兩件事：確認有 session、把 hook 丟出來的錯誤翻成 `Result`。
 */
export class BetterAuthSelfAccountCommand implements SelfAccountCommand {
  async changePassword(headers: Headers, input: ChangePasswordInput): Promise<ChangePasswordOutcome> {
    let session: Awaited<ReturnType<typeof getSessionFromHeaders>> = null
    try {
      session = await getSessionFromHeaders(headers)
    } catch {
      // `/get-session` 被狀態矩陣擋下（停用、去識別化）＝沒有有效登入。
      return { ok: false, code: 'UNAUTHENTICATED', message: '請先登入。' }
    }
    if (!session?.user?.id) {
      return { ok: false, code: 'UNAUTHENTICATED', message: '請先登入。' }
    }

    try {
      await changeOwnPassword(headers, input)
      return { ok: true }
    } catch (error) {
      return translate(error)
    }
  }
}

/** 把 hook 或套件丟出來的錯誤翻成畫面看得懂的結果。 */
function translate(error: unknown): ChangePasswordOutcome {
  const status = (error as { status?: string; statusCode?: number })?.status
  const message = (error as { body?: { message?: string } })?.body?.message

  if (status === 'TOO_MANY_REQUESTS') {
    return { ok: false, code: 'VALIDATION_FAILED', message: message ?? '改密碼的次數太多，請稍後再試。' }
  }
  if (status === 'BAD_REQUEST' && message) {
    // 規則類的訊息（長度、與舊密碼相同）由 hook 給，直接照用。
    return { ok: false, code: 'VALIDATION_FAILED', message }
  }
  if (status === 'UNAUTHORIZED') {
    return { ok: false, code: 'UNAUTHENTICATED', message: '請重新登入。' }
  }
  // 其餘（含舊密碼錯）一律同一句：分辨得太細就變成一個可以拿來試密碼的通道。
  return { ok: false, code: 'VALIDATION_FAILED', message: '目前的密碼不正確。' }
}
