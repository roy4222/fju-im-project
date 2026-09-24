import type { AccountStatus } from '@/application/accounts/actor'
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@/application/accounts/registration'
import type { ErrorCode } from '@/shared/errors'

/**
 * 本人帳號用例（模組 01 §5 `SelfAccountCommand`）。
 *
 * S01-05 做了改密碼；票 10 補上「看自己的帳號」、改手機與聯絡 Email、連結 Google、
 * 替 Google 帳號設密碼。登入 Email 本人不能改（§2.3 Q3）——這裡刻意沒有那個方法。
 */

/**
 * 新密碼的規則**不在這裡**。
 *
 * 2026-09-16 review 重現過：規則寫在用例層的話，直接打 `POST /api/auth/change-password`
 * 就整組繞過去。所以長度、不可與舊密碼相同、限速、撤其他裝置、清 must-change 旗標與稽核
 * 全部移到 Better Auth 的 hook（`infrastructure/auth/change-password-rules.ts`），
 * HTTP 與 Server Action 走同一段程式。這個檔只留介面與結果型別。
 *
 * 例外是「設定密碼」：套件的 `setPassword` 是 server-only，HTTP 打不到（`/set-password` 封鎖），
 * 唯一的入口就是這個用例，所以它的規則（`checkNewOwnPassword`）放在這裡。
 */

export type ChangePasswordInput = {
  readonly currentPassword: string
  readonly newPassword: string
}

export type ChangePasswordOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: ErrorCode; readonly message: string; readonly retryAfterMs?: number }

/** 帳號頁看到的自己（票 10；原型 `/account`）。 */
export type MyAccount = {
  readonly userId: string
  readonly status: AccountStatus
  /** 登入 Email：本人不能改。 */
  readonly loginEmail: string
  readonly name: string
  /** 個人資料列（核准後才有；老師由系辦建立）。沒有就是 null。 */
  readonly profile: {
    readonly displayName: string
    readonly studentNo: string | null
    readonly departmentClass: string | null
    readonly cohortName: string | null
    readonly phone: string | null
    readonly contactEmail: string
    readonly revision: number
  } | null
  readonly loginMethods: { readonly google: boolean; readonly password: boolean }
  /** 這個 session 是不是 10 分鐘內登入的（連結 Google、設密碼要）。 */
  readonly sessionFresh: boolean
}

export type ContactInput = {
  readonly phone: string
  readonly contactEmail: string
  /** 畫面上看到的版本；別的地方先改過就回 CONFLICT。 */
  readonly expectedRevision: number
}

export type SelfAccountOutcome<T = unknown> =
  | ({ readonly ok: true } & T)
  | { readonly ok: false; readonly code: ErrorCode; readonly message: string; readonly field?: string }

export type SetPasswordInput = {
  readonly newPassword: string
  readonly passwordConfirm: string
}

/** 設定密碼的欄位規則（與註冊、改密碼同一個長度下限）。 */
export function checkNewOwnPassword(input: SetPasswordInput): { field: string; message: string } | null {
  if (input.newPassword.length < PASSWORD_MIN_LENGTH) {
    return { field: 'newPassword', message: `密碼至少要 ${PASSWORD_MIN_LENGTH} 個字元。` }
  }
  if (input.newPassword.length > PASSWORD_MAX_LENGTH) {
    return { field: 'newPassword', message: `密碼最多 ${PASSWORD_MAX_LENGTH} 個字元。` }
  }
  if (input.newPassword !== input.passwordConfirm) {
    return { field: 'passwordConfirm', message: '兩次輸入的密碼不一樣。' }
  }
  return null
}

export interface SelfAccountCommand {
  /**
   * 改自己的密碼。
   *
   * 成功時：新密碼生效、舊密碼失效、**其他裝置的登入全部撤銷**、`must_change_password`
   * 清掉、留一筆稽核。目前這一台的 session 留著（不然使用者剛改完就被踢出去）。
   */
  changePassword(headers: Headers, input: ChangePasswordInput): Promise<ChangePasswordOutcome>

  /** 看自己的帳號；沒有有效登入回 null。 */
  viewMine(headers: Headers): Promise<MyAccount | null>

  /** 改手機與聯絡 Email（已開通的本人；寫 `user_profiles`＋稽核）。 */
  updateContact(headers: Headers, input: ContactInput): Promise<SelfAccountOutcome<{ readonly revision: number }>>

  /**
   * 開始把 Google 連到自己的帳號：回傳要導去的 Google 授權網址。
   * 已開通、fresh session（否則 `FRESH_SESSION_REQUIRED`）、還沒連過 Google。
   */
  startGoogleLink(headers: Headers): Promise<SelfAccountOutcome<{ readonly url: string }>>

  /**
   * 替只有 Google 的帳號設一組密碼。
   * 已開通、fresh session、還沒有密碼；長度規則見 `checkNewOwnPassword`。
   */
  setPassword(headers: Headers, input: SetPasswordInput): Promise<SelfAccountOutcome>
}
