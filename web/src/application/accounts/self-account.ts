import type { ErrorCode } from '@/shared/errors'

/**
 * 本人帳號用例（模組 01 §5 `SelfAccountCommand`）。
 *
 * 本切片只做改密碼；連結 Google、設定密碼、改聯絡資料由後面的票補上同一個介面。
 */

/** 新密碼的規則。放在這裡是因為它是規則，不是儲存方式，可以單獨測。 */
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

export type ChangePasswordInput = {
  readonly currentPassword: string
  readonly newPassword: string
}

export type ChangePasswordOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: ErrorCode; readonly message: string; readonly retryAfterMs?: number }

export interface SelfAccountCommand {
  /**
   * 改自己的密碼。
   *
   * 成功時：新密碼生效、舊密碼失效、**其他裝置的登入全部撤銷**、`must_change_password`
   * 清掉、留一筆稽核。目前這一台的 session 留著（不然使用者剛改完就被踢出去）。
   */
  changePassword(headers: Headers, input: ChangePasswordInput): Promise<ChangePasswordOutcome>
}
