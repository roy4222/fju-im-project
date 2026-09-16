import type { ErrorCode } from '@/shared/errors'

/**
 * 本人帳號用例（模組 01 §5 `SelfAccountCommand`）。
 *
 * 本切片只做改密碼；連結 Google、設定密碼、改聯絡資料由後面的票補上同一個介面。
 */

/**
 * 新密碼的規則**不在這裡**。
 *
 * 2026-09-16 review 重現過：規則寫在用例層的話，直接打 `POST /api/auth/change-password`
 * 就整組繞過去。所以長度、不可與舊密碼相同、限速、撤其他裝置、清 must-change 旗標與稽核
 * 全部移到 Better Auth 的 hook（`infrastructure/auth/change-password-rules.ts`），
 * HTTP 與 Server Action 走同一段程式。這個檔只留介面與結果型別。
 */

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
