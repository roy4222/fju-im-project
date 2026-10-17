/** 重設密碼表單的狀態（`resetPasswordAction` 回、`reset-form.tsx` 畫）。 */
export type ResetState =
  | { status: 'done' }
  | { status: 'expired' }
  | { status: 'error'; error: string; attempt: number }
  | undefined
