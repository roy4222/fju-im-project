/**
 * 註冊第 1、2 步在瀏覽器先擋的格式檢查（純函式；伺服器 hook 一樣會再擋一次）。
 * 先擋是為了「密碼 11 字送出 → 欄位下紅字、沒有打 API」（AC-VI-45）。
 */

export const OTP_LENGTH = 6

/** 第 1 步：Email 空白、密碼太短、兩次不一樣。回 `{欄位名: 訊息}`，沒錯回空物件。 */
export function signupFieldErrors(
  input: { email: string; password: string; passwordConfirm: string },
  passwordMin: number,
): Record<string, string> {
  const errors: Record<string, string> = {}
  if (!input.email.trim()) errors.email = '請填 Email'
  if (input.password.length < passwordMin) errors.password = `密碼至少 ${passwordMin} 字`
  else if (input.password !== input.passwordConfirm) errors.passwordConfirm = '兩次輸入的密碼不一樣'
  return errors
}

/** 6 格驗證碼：把第 `from` 格開始的內容換成 `text` 裡的數字（貼上整串、一格打一個字都走這裡）。 */
export function fillOtp(current: string, from: number, text: string): string {
  const digits = Array.from({ length: OTP_LENGTH }, (_, i) => current[i] ?? '')
  const clean = text.replace(/\D/g, '')
  if (!clean) {
    digits[from] = ''
  } else {
    for (let k = 0; k < clean.length && from + k < OTP_LENGTH; k += 1) digits[from + k] = clean[k]!
  }
  // 中間有空格時不往後擠：保留位置，只在送出時檢查是否 6 碼都填了。
  return digits.map((d) => d || ' ').join('').trimEnd()
}

/** 6 碼都填了才算完整（用來決定要不要自動送出）。 */
export function isCompleteOtp(value: string): boolean {
  return new RegExp(`^\\d{${OTP_LENGTH}}$`).test(value)
}
