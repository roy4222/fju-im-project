/**
 * Google 登入／連結失敗時，套件把人導回來帶的 `?error=<代碼>` 翻成一句話（票 10）。
 *
 * 只挑規格要求講清楚的幾種；其餘一律同一句——代碼本身是套件內部的東西，
 * 分得太細沒有幫助，還可能變成探測帳號狀態的管道（例如停用帳號在建 session 時被擋，
 * 回來的是 `unable_to_create_session`，這裡不能說「你被停用了」）。
 */

/** 登入頁、註冊頁：未登入時用 Google 進來失敗。 */
export function googleSignInErrorMessage(code: unknown): string | null {
  if (typeof code !== 'string' || code === '') return null
  if (code === 'account_not_linked') {
    // §2.3：同 Email 已經有帳號時一律拒絕，並提示改用原方式登入後再連結。
    return '這個 Google 帳號的 Email 已經有帳號了，系統不會自動合併。請先用原本的 Email 與密碼登入，再到「我的帳號」連結 Google。'
  }
  if (code === 'access_denied') return '你取消了 Google 登入。可以再試一次，或改用 Email 與密碼。'
  return 'Google 登入沒有完成，請再試一次；一直不行的話請改用 Email 與密碼，或聯絡系辦。'
}

/** 帳號頁：連結 Google 失敗。 */
export function googleLinkErrorMessage(code: unknown): string | null {
  if (typeof code !== 'string' || code === '') return null
  if (code === 'account_already_linked_to_different_user') {
    // 模組 01 §3 `ACCOUNT_LINK_CONFLICT`：已綁定其他帳號的 Google 身分不能再被連結。
    return '這個 Google 帳號已經連結到另一個帳號，不能再連到這裡。如果那不是你的帳號，請聯絡系辦。'
  }
  if (code === 'email_does_not_match') {
    return '要連結的 Google 帳號 Email 必須和你的登入 Email 相同。請換一個 Google 帳號再試。'
  }
  if (code === 'access_denied') return '你取消了 Google 連結，帳號沒有任何改變。'
  return 'Google 連結沒有完成，帳號沒有任何改變。請再試一次。'
}
