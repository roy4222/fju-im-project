import 'server-only'
import { RATE_LIMITS, sharedRateLimiter } from '@/shared/rate-limit'

/**
 * Google 登入入口限速（票 10b；票 10 審查建議）。
 *
 * 套件對 `/sign-in/social` 的限速在 `auth-instance.ts` 關掉了（`customRules: false`：套件的
 * 「10 秒 3 次／IP」會讓同一個校園出口後面的第四個人按 Google 鈕就吃 429）。但關掉之後這條路
 * **完全不限速**，而每按一次都會寫一列 `verifications`（state＋PKCE）。所以跟註冊一樣，
 * 在 `hooks.before` 裡自己算一個粗粒度的每 IP 桶：登入頁的 Server Action（伺服器端呼叫
 * `auth.api.signInSocial`）與直接打 `POST /api/auth/sign-in/social` 走同一段、算同一個桶。
 *
 * 門檻與理由見 `RATE_LIMITS.signInSocial`。
 */

// 登入頁（Server Action）與直接打 API 在不同的 chunk，限速器要共用同一份（見 sharedRateLimiter）。
const limiter = sharedRateLimiter('sign-in-social', RATE_LIMITS.signInSocial)

export function socialSignInKey(ip: string): string {
  return `sign-in-social:${ip}`
}

export function checkSocialSignInRate(ip: string) {
  return limiter.hit(socialSignInKey(ip))
}

/** 測試用：清空全部。 */
export function resetSocialSignInLimiter(): void {
  limiter.clear()
}
