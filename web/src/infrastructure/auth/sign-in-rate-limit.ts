import 'server-only'
import { RATE_LIMITS, sharedRateLimiter } from '@/shared/rate-limit'

/**
 * 登入限速（契約 03 §6：同一個 IP 對同一個帳號，10 分鐘 10 次）。
 *
 * **放在 Better Auth 的 hook 裡。** 2026-09-16 review（Spec 4）重現過：
 * 只掛在 Server Action 門面上的話，直接打 `/api/auth/sign-in/email` 就只剩套件的預設視窗，
 * 132 秒內錯 11 次之後正確的密碼照樣放行。
 *
 * 用 IP＋帳號而不是只用 IP：系上都在同一個對外 IP 後面，只看 IP 會擋到無辜的人；
 * 只看帳號則擋不住從很多 IP 打同一個帳號。
 *
 * 另有一個**每 IP 的失敗桶**（票 T3）：同一個 IP 換帳號打（密碼噴灑）會繞過上面那個桶，
 * 所以再數這個 IP 不分帳號的**失敗**次數。只算失敗，校內 NAT 後面的人正常登入不耗桶。
 */

// 登入表單（Server Action）與直接打 API 在不同的 chunk，限速器要共用同一份（見 sharedRateLimiter）。
const limiter = sharedRateLimiter('sign-in', RATE_LIMITS.signIn)
const ipFailures = sharedRateLimiter('sign-in-ip-failures', RATE_LIMITS.signInFailuresPerIp)

export function signInKey(ip: string, email: string): string {
  return `sign-in:${ip}:${email.toLowerCase()}`
}

export function checkSignInRate(key: string) {
  return limiter.hit(key)
}

/** 登入成功就把計數清掉，不會因為之前打錯幾次而慢慢累積到被鎖。 */
export function resetSignInRate(key: string): void {
  limiter.reset(key)
}

/**
 * 這個 IP 還能不能登入：只看不計。已經失敗滿 `max` 次就擋，**連正確的密碼也擋**——
 * 不然「有沒有被擋」就成了密碼對不對的訊號。
 */
export function checkIpFailures(ip: string): { allowed: boolean } {
  return { allowed: ipFailures.count(ip) < RATE_LIMITS.signInFailuresPerIp.max }
}

/** 記一次這個 IP 的登入失敗（帳密錯）。成功登入**不清**這個桶，否則穿插一次正確登入就能歸零。 */
export function recordIpFailure(ip: string): void {
  ipFailures.hit(ip)
}

/** 測試用：清空全部（IP＋帳號桶與每 IP 失敗桶）。 */
export function resetSignInLimiter(): void {
  limiter.clear()
  ipFailures.clear()
}

/**
 * 從請求標頭取來源 IP。
 *
 * Caddy 會帶 `X-Real-IP`（見 Caddyfile）；本機直連時退回 `X-Forwarded-For` 的第一段。
 * 兩個都沒有就回 `unknown`——所有沒帶來源的請求共用一個桶，比完全不限速安全。
 */
export function clientIpFrom(headers: Headers | undefined): string {
  if (!headers) return 'unknown'
  return (
    headers.get('x-real-ip') ?? headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
  )
}
