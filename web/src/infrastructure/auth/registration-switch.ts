import 'server-only'

/**
 * 註冊開關（第一段開站：正式站關閉註冊；設計方案 §5）。
 *
 * 只有一個環境變數 `REGISTRATION_OPEN`：測試站 `true`、正式站 `false`。
 * **沒設（或空字串）視為開放**——CI 與本機 e2e 靠 `/api/auth/sign-up/email` 註冊，不用另外設。
 * 有設但不是 `true` 的值（`false`、打錯字、`1`）一律當關閉：寫錯時寧可關著。
 *
 * 誰在用：Better Auth 實例（拒絕密碼註冊與 Google 新帳號，`auth-instance.ts`），
 * 以及前台的註冊入口（經 `composition/accounts.ts` 轉出）。
 * Better Auth 的實例是延後建立的單例，所以切換要重建容器（改 Doppler 後 `compose up -d`）。
 */
export function isRegistrationOpen(): boolean {
  const value = process.env.REGISTRATION_OPEN?.trim()
  return value === undefined || value === '' || value === 'true'
}

/** 註冊關閉時，API 與 Server Action 回的同一句話。 */
export const REGISTRATION_CLOSED_MESSAGE = '目前沒有開放註冊。'
