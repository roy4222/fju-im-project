import { headers } from 'next/headers'
import { TurnstileWidget } from './turnstile-widget'

/**
 * Turnstile 人機驗證（visitor-r3 設計方案 §3.8，Q46）。只掛在三個寄信表單裡：
 * Email 註冊（`signup`）、忘記密碼（`reset`）、重寄驗證碼（`resend`）。掛載由各頁的票自己加一行
 * `<Turnstile action="signup" />`，放在 `<form>` 裡面。
 *
 * - 兩個金鑰都沒設（本機、CI）：什麼都不畫、也不載 `api.js`（AC-VI-67）。
 * - `api.js` 帶這次請求的 nonce；CSP 是 `strict-dynamic`，host 白名單不算數，所以 `script-src` 不用改。
 *   `frame-src`／`connect-src` 本來就有 `https://challenges.cloudflare.com`（契約 03 §6）。
 * - 通過後 Cloudflare 把 token 寫進表單的隱藏欄 `cf-turnstile-response`；Server Action 再把它放進
 *   傳給 `auth.api.*` 的 `x-turnstile-token` 標頭（VB-2）。
 */
export async function Turnstile({ action }: { action: TurnstileAction }) {
  const siteKey = siteKeyFromEnv(process.env)
  if (!siteKey) return null
  const nonce = (await headers()).get('x-nonce') ?? undefined
  return <TurnstileView siteKey={siteKey} action={action} nonce={nonce} />
}

/** 跟伺服器驗證同一組（`infrastructure/auth/turnstile-verify.ts` 的 `TURNSTILE_ACTIONS`）。 */
export type TurnstileAction = 'signup' | 'reset' | 'resend'

/**
 * 前台用的 site key；兩個鍵都沒設回 null。app 層不能 import infrastructure，所以這裡自己讀，
 * 規則與 `readTurnstileConfig` 相同：空字串當沒設、只設一個就丟錯（secret 只看有沒有，不讀值出去）。
 */
export function siteKeyFromEnv(env: Record<string, string | undefined>): string | null {
  const siteKey = env.TURNSTILE_SITE_KEY?.trim() || ''
  const hasSecret = Boolean(env.TURNSTILE_SECRET_KEY?.trim())
  if (!siteKey && !hasSecret) return null
  if (!siteKey || !hasSecret) {
    const missing = siteKey ? 'TURNSTILE_SECRET_KEY' : 'TURNSTILE_SITE_KEY'
    throw new Error(`Turnstile 金鑰只設了一個（缺 ${missing}）：兩個都設才會啟用，兩個都不設則關閉。`)
  }
  return siteKey
}

export const TURNSTILE_SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'

/** 畫面本體（不讀環境與請求標頭，單元測試直接畫）。 */
export function TurnstileView({ siteKey, action, nonce }: { siteKey: string; action: TurnstileAction; nonce?: string }) {
  return (
    <>
      {/* React 會把 async script 提到 <head> 並去重；同頁兩個 widget 也只載一次。 */}
      <script src={TURNSTILE_SCRIPT_SRC} async nonce={nonce} />
      <TurnstileWidget siteKey={siteKey} action={action} />
    </>
  )
}
