import 'server-only'
import { createRateLimiter, RATE_LIMITS } from '@/shared/rate-limit'

/**
 * 註冊限速（契約 03 §6：同一個 IP 每小時 30 次；2026-09-23 Roy 定案，取代舊的 5 次）。
 *
 * 跟登入限速同一個作法：**放在 Better Auth 的 hook 裡**，所以註冊頁的 Server Action
 * （伺服器端呼叫 `auth.api.signUpEmail`）與直接打 `POST /api/auth/sign-up/email`
 * 算的是**同一個桶**，兩條路加起來一小時 30 次，不是各 30 次。
 *
 * 鍵只有 IP（契約寫的就是「每 IP」）。來源 IP 由 `clientIpFrom` 取：正式環境 Caddy 用
 * `header_up X-Real-IP {remote_host}` **覆寫**使用者自己帶的同名標頭，所以偽造不了
 * （見 Caddyfile、ops/Caddyfile.vm）。
 *
 * 每一次「進到註冊端點」都算一次，不論成功或失敗（例如 Email 已被用過）：
 * 不然「這個 Email 有沒有註冊過」就能被無限次地試。表單欄位格式錯誤在用例層就擋掉了，
 * 那種不會打到端點，也就不算——打錯字的學生不會把全班的額度用完。
 */

const limiter = createRateLimiter(RATE_LIMITS.register)

export function signUpKey(ip: string): string {
  return `sign-up:${ip}`
}

export function checkSignUpRate(ip: string) {
  return limiter.hit(signUpKey(ip))
}

/** 測試用：清空全部。 */
export function resetSignUpLimiter(): void {
  limiter.clear()
}
