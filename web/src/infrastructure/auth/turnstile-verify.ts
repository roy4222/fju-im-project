import 'server-only'

/**
 * Turnstile 伺服器驗證（契約 03 §7；visitor-r3 設計方案 §3.8，Q46）。
 *
 * 只有三個寄信表單要過 Turnstile：Email 註冊（`signup`）、忘記密碼（`reset`）、重寄驗證碼（`resend`）。
 * 掛進 Better Auth `hooks.before` 是 VB-2 的事；這裡只提供：
 *
 * - `readTurnstileConfig`：兩個金鑰**都沒設**＝功能關閉（本機、CI）；**只設一個**＝丟錯，不准半套。
 * - `verifyTurnstile`：打 Cloudflare siteverify，逾時 5 秒；只認 `success === true`，
 *   再比對 `action` 與 `hostname`。連不上、逾時、回應壞掉一律 `unavailable`（fail closed）。
 *
 * 呼叫端的對應：`unavailable` → 503（請稍後再試）；其他失敗 → 400 `TURNSTILE_REQUIRED`
 * （「請完成人機驗證」）。token 只能驗一次是 Cloudflare 那邊保證的（`timeout-or-duplicate`），
 * 所以同一個 token 第二次送來會回 `rejected`。
 */

export const TURNSTILE_ACTIONS = ['signup', 'reset', 'resend'] as const
export type TurnstileAction = (typeof TURNSTILE_ACTIONS)[number]

export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
export const SITEVERIFY_TIMEOUT_MS = 5_000
/** Cloudflare 規定 token 最長 2048 字；超過的不必送出去就知道是假的。 */
const MAX_TOKEN_LENGTH = 2048

/**
 * Cloudflare 官方的測試 secret（永遠通過／永遠失敗／已用過）。
 * 測試金鑰回的 `hostname`、`action` 是假值，不能拿來比對，所以只有這幾把跳過那兩項；
 * 真的金鑰一律比對。
 */
const CLOUDFLARE_TEST_SECRETS = new Set([
  '1x0000000000000000000000000000000AA',
  '2x0000000000000000000000000000000AA',
  '3x0000000000000000000000000000000AA',
])

export type TurnstileConfig = { enabled: false } | { enabled: true; siteKey: string; secretKey: string }

type Env = Record<string, string | undefined>

/** 讀兩個環境鍵。空字串當作沒設（Compose 會把沒值的鍵傳成空字串）。 */
export function readTurnstileConfig(env: Env = process.env): TurnstileConfig {
  const siteKey = env.TURNSTILE_SITE_KEY?.trim() || ''
  const secretKey = env.TURNSTILE_SECRET_KEY?.trim() || ''
  if (!siteKey && !secretKey) return { enabled: false }
  if (!siteKey || !secretKey) {
    const missing = siteKey ? 'TURNSTILE_SECRET_KEY' : 'TURNSTILE_SITE_KEY'
    throw new Error(`Turnstile 金鑰只設了一個（缺 ${missing}）：兩個都設才會啟用，兩個都不設則關閉。`)
  }
  return { enabled: true, siteKey, secretKey }
}

/** 前台 widget 用的 site key；功能關閉時回 null（不渲染、不載 api.js）。 */
export function turnstileSiteKey(env: Env = process.env): string | null {
  const config = readTurnstileConfig(env)
  return config.enabled ? config.siteKey : null
}

export type TurnstileFailure = 'missing-token' | 'rejected' | 'action-mismatch' | 'hostname-mismatch' | 'unavailable'

export type TurnstileVerdict =
  | { ok: true; skipped: boolean }
  | { ok: false; reason: TurnstileFailure; errorCodes?: string[] }

export type VerifyTurnstileOptions = {
  /** 預設讀環境變數；測試直接給。 */
  config?: TurnstileConfig
  /** 允許的 hostname；預設取 `BETTER_AUTH_URL` 的 host。 */
  expectedHostname?: string | null
  fetch?: typeof fetch
  timeoutMs?: number
}

type SiteverifyResponse = {
  success?: unknown
  action?: unknown
  hostname?: unknown
  'error-codes'?: unknown
}

function defaultHostname(): string | null {
  const url = process.env.BETTER_AUTH_URL
  if (!url) return null
  try {
    return new URL(url).hostname
  } catch {
    return null
  }
}

export async function verifyTurnstile(
  token: string | null | undefined,
  remoteIp: string | null | undefined,
  action: TurnstileAction,
  options: VerifyTurnstileOptions = {},
): Promise<TurnstileVerdict> {
  const config = options.config ?? readTurnstileConfig()
  // 兩個鍵都沒設：本機與 CI 照常通過（AC-VI-67）。
  if (!config.enabled) return { ok: true, skipped: true }

  const response = token?.trim() ?? ''
  if (!response || response.length > MAX_TOKEN_LENGTH) return { ok: false, reason: 'missing-token' }

  const body = new URLSearchParams({
    secret: config.secretKey,
    response,
    // 同一次驗證若要重送，Cloudflare 靠這個認出是同一筆，不會當成重播。
    idempotency_key: crypto.randomUUID(),
  })
  if (remoteIp) body.set('remoteip', remoteIp)

  const doFetch = options.fetch ?? fetch
  let result: SiteverifyResponse
  try {
    const res = await doFetch(SITEVERIFY_URL, {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(options.timeoutMs ?? SITEVERIFY_TIMEOUT_MS),
    })
    if (!res.ok) return { ok: false, reason: 'unavailable' }
    result = (await res.json()) as SiteverifyResponse
  } catch {
    // 逾時、DNS、連線中斷、回應不是 JSON：一律拒絕（fail closed）。
    return { ok: false, reason: 'unavailable' }
  }
  if (typeof result !== 'object' || result === null) return { ok: false, reason: 'unavailable' }

  if (result.success !== true) {
    const errorCodes = Array.isArray(result['error-codes'])
      ? result['error-codes'].filter((code): code is string => typeof code === 'string')
      : []
    return { ok: false, reason: 'rejected', errorCodes }
  }

  if (CLOUDFLARE_TEST_SECRETS.has(config.secretKey)) return { ok: true, skipped: false }

  if (result.action !== action) return { ok: false, reason: 'action-mismatch' }
  const expectedHostname = options.expectedHostname === undefined ? defaultHostname() : options.expectedHostname
  if (!expectedHostname || result.hostname !== expectedHostname) return { ok: false, reason: 'hostname-mismatch' }

  return { ok: true, skipped: false }
}
