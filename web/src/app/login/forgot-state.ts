/** 忘記密碼模式送出後的狀態（`requestPasswordResetAction` 回、`login-card.tsx` 畫）。 */
export type ForgotState =
  | { status: 'sent'; email: string }
  | { status: 'error'; error: string; values: { email: string }; attempt: number }
  | undefined
