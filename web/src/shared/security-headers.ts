/**
 * CSP 與安全標頭（契約 03 §6；母 spec §4.15）。
 *
 * T2 定案（Roy 2026-09-15）：採**方案 A — 全站動態渲染＋Proxy 產生 nonce＋`strict-dynamic`**。
 * 每個回應都帶一個一次性的 nonce；頁面自己的腳本帶著 nonce 可以跑，任何被塞進頁面、
 * 沒有 nonce 的 inline 腳本會被瀏覽器擋下。`'use cache'` 只用在資料函式（契約 02 §8）。
 *
 * 指令字串逐項對照契約 03 §6，改這裡要同步改契約。
 */

export type CspOptions = {
  nonce: string
  /** 開發模式：React 用 eval 重建伺服器錯誤堆疊，production 不需要。 */
  development?: boolean
}

/** 契約 03 §6 的指令表。值裡的 `'nonce-…'` 由 `buildContentSecurityPolicy` 填。 */
export function cspDirectives({ nonce, development = false }: CspOptions): [string, string][] {
  const scriptSrc = ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"]
  const styleSrc = ["'self'", `'nonce-${nonce}'`]
  if (development) {
    // dev 的 React 需要 eval；Turbopack 的 HMR 樣式也是 inline 注入的。
    scriptSrc.push("'unsafe-eval'")
    styleSrc.push("'unsafe-inline'")
  }
  return [
    ['default-src', "'self'"],
    ['script-src', scriptSrc.join(' ')],
    ['style-src', styleSrc.join(' ')],
    // YouTube 縮圖與 blob／data（裁切預覽）。
    ['img-src', "'self' blob: data: https://i.ytimg.com"],
    ['font-src', "'self'"],
    // 影片嵌入與 Turnstile widget。
    ['frame-src', 'https://www.youtube.com https://challenges.cloudflare.com'],
    ['connect-src', "'self' https://challenges.cloudflare.com"],
    ['object-src', "'none'"],
    ['base-uri', "'self'"],
    // Google 登入與連結（票 10）：表單送 Server Action，伺服器回 303 導去 Google 授權頁。
    // Chrome 對「表單送出後的轉址」也套 form-action，只寫 'self' 會把這一跳擋掉。
    ['form-action', "'self' https://accounts.google.com"],
    ['frame-ancestors', "'none'"],
  ]
}

export function buildContentSecurityPolicy(options: CspOptions): string {
  return cspDirectives(options)
    .map(([name, value]) => `${name} ${value}`)
    .join('; ')
}

/**
 * CSP 以外的安全標頭。
 * HSTS 只在 HTTPS 才有意義，所以由呼叫端決定要不要加（本機 http 不加）。
 */
export function staticSecurityHeaders(options?: { https?: boolean }): [string, string][] {
  const headers: [string, string][] = [
    ['x-content-type-options', 'nosniff'],
    ['referrer-policy', 'strict-origin-when-cross-origin'],
    // frame-ancestors 已經擋掉嵌入，這個是給舊瀏覽器的備援。
    ['x-frame-options', 'DENY'],
    ['permissions-policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()'],
    ['cross-origin-opener-policy', 'same-origin'],
  ]
  if (options?.https) {
    headers.push(['strict-transport-security', 'max-age=63072000; includeSubDomains'])
  }
  return headers
}

/** 產生這次請求的 nonce。每個回應都要不一樣，而且不能猜得到。 */
export function createNonce(randomValues: Uint8Array = crypto.getRandomValues(new Uint8Array(16))): string {
  return btoa(String.fromCharCode(...randomValues))
}
