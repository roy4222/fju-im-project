/**
 * 固定視窗限速（契約 03 §6）。
 *
 * 放在應用程序的記憶體裡：本專案是單機部署（母 spec §4.1），一個 app 程序就是全部，
 * 所以不需要 Redis。重啟會清空——這是可以接受的：限速是防連續猜測，不是計費。
 * Caddy 那一層另有一道（契約 03 §6），兩層互相補。
 *
 * 鍵刻意由呼叫端組（例如「IP ＋ 帳號」），因為每條規則的鍵不一樣：
 * 登入是 IP＋帳號、註冊是 IP、改密是使用者。
 */

export type RateLimitVerdict =
  | { readonly allowed: true; readonly remaining: number }
  | { readonly allowed: false; readonly retryAfterMs: number }

export type RateLimiter = {
  /** 記一次嘗試並回答放不放行。**達到上限之後連正確的請求也會被擋**（契約 03 §6）。 */
  hit(key: string): RateLimitVerdict
  /** 成功之後把計數清掉（例如登入成功）。 */
  reset(key: string): void
  /** 測試用：清空全部。 */
  clear(): void
}

export function createRateLimiter(options: {
  max: number
  windowMs: number
  now?: () => number
}): RateLimiter {
  const { max, windowMs } = options
  const now = options.now ?? (() => Date.now())
  const windows = new Map<string, { count: number; startedAt: number }>()

  /** 順手清掉過期的桶，免得記憶體隨著不同的 IP 一直長。 */
  function sweep(current: number): void {
    for (const [key, bucket] of windows) {
      if (current - bucket.startedAt >= windowMs) windows.delete(key)
    }
  }

  return {
    hit(key) {
      const current = now()
      if (windows.size > 1_000) sweep(current)

      const bucket = windows.get(key)
      if (!bucket || current - bucket.startedAt >= windowMs) {
        windows.set(key, { count: 1, startedAt: current })
        return { allowed: true, remaining: max - 1 }
      }

      bucket.count += 1
      if (bucket.count > max) {
        return { allowed: false, retryAfterMs: bucket.startedAt + windowMs - current }
      }
      return { allowed: true, remaining: max - bucket.count }
    },
    reset(key) {
      windows.delete(key)
    },
    clear() {
      windows.clear()
    },
  }
}

/** 契約 03 §6 的門檻，寫在一起才不會散落在各處。 */
export const RATE_LIMITS = {
  /** 登入：同一個 IP 對同一個帳號，10 分鐘內 10 次。 */
  signIn: { max: 10, windowMs: 10 * 60 * 1000 },
  /** 改密：同一個使用者每小時 5 次。 */
  changePassword: { max: 5, windowMs: 60 * 60 * 1000 },
  /**
   * 註冊：同一個 IP 每小時 30 次（2026-09-23 Roy 定案，取代舊的 5 次：
   * 全班可能共用一個對外 IP，而且每一筆註冊都要系辦人工核准）。
   */
  register: { max: 30, windowMs: 60 * 60 * 1000 },
} as const
