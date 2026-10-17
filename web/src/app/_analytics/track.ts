import type { GaRole } from './ga-role'
import { routeName } from './route-names'

/**
 * 全站唯一的 GA4 事件函式（訪客規格 §3.10；B 設計方案 §7.3.1，R3 定案四事件）。
 *
 * - 事件與參數是白名單：型別只收已定案的枚舉字面值，執行期再過濾一次（擋 `as any` 這類繞過）。
 *   沒有任何參數帶 Email、姓名、ID、自由文字。
 * - 頁面位置一律是「網站來源＋固定路由名稱」，referrer 送空字串，標題送路由名稱（不送 `document.title`，
 *   作品標題、姓名會出現在那裡）。
 * - `window.gtag` 不存在（沒設 `GA4_MEASUREMENT_ID`：測試站、CI、本機）就什麼都不做。
 *
 * `gtag`、`dataLayer` 只准在這個檔與 `ga-script.tsx` 碰（ESLint 擋）。
 */

export type GaEvent = 'page_view' | 'register_step' | 'login' | 'forgot_password' | 'video_play'

export type GaParams = {
  page_view: Record<string, never>
  register_step: { step: 1 | 2 | 3 | 'done' }
  login: { method: 'google' | 'password' }
  forgot_password: Record<string, never>
  video_play: Record<string, never>
}

/** 執行期白名單：每個事件可以帶哪些參數、每個參數可以是哪些值。 */
const ALLOWED: { readonly [E in GaEvent]: { readonly [K in keyof GaParams[E]]-?: readonly GaParams[E][K][] } } = {
  page_view: {},
  register_step: { step: [1, 2, 3, 'done'] },
  login: { method: ['google', 'password'] },
  forgot_password: {},
  video_play: {},
}

export function isGaEvent(name: unknown): name is GaEvent {
  return typeof name === 'string' && Object.hasOwn(ALLOWED, name)
}

/**
 * 只留白名單裡的鍵與值。事件名不在白名單回 `null`（整個事件不送）；
 * 有定義的參數缺了或值不合法也回 `null`——寧可不送，也不送一個意思不明的事件。
 */
export function sanitizeParams(name: unknown, params: unknown): Record<string, string | number> | null {
  if (!isGaEvent(name)) return null
  const allowed = ALLOWED[name] as Readonly<Record<string, readonly (string | number)[]>>
  const input = (typeof params === 'object' && params !== null ? params : {}) as Record<string, unknown>
  const out: Record<string, string | number> = {}
  for (const [key, values] of Object.entries(allowed)) {
    const value = input[key]
    if (!values.includes(value as string | number)) return null
    out[key] = value as string | number
  }
  return out
}

/** 去識別的頁面欄位：來源＋路由名稱；referrer 空字串；標題也是路由名稱。 */
export function pageFields(origin: string, pathname: string) {
  const name = routeName(pathname)
  return { page_location: `${origin}${name}`, page_referrer: '', page_title: name }
}

/** 一次性分析 cookie `fju_ga_login`（VB-4、VB-5 寫入；`page-view.tsx` 讀完立即清）。 */
export const LOGIN_COOKIE = 'fju_ga_login'

/** 從 `document.cookie` 取出登入方式；沒有或值不合法回 `null`。 */
export function loginMethodFromCookie(cookieString: string): GaParams['login']['method'] | null {
  for (const part of cookieString.split(';')) {
    const [rawName, ...rest] = part.split('=')
    if (rawName?.trim() !== LOGIN_COOKIE) continue
    const value = rest.join('=').trim()
    return value === 'google' || value === 'password' ? value : null
  }
  return null
}

type Gtag = (command: 'event' | 'set', ...args: unknown[]) => void

const ROLES: readonly GaRole[] = ['guest', 'student', 'teacher', 'admin', 'pending']

function currentGtag(): Gtag | null {
  if (typeof window === 'undefined') return null
  const gtag = (window as unknown as { gtag?: Gtag }).gtag
  return typeof gtag === 'function' ? gtag : null
}

/**
 * 更新唯一的使用者屬性 `role`（登入、登出後由 `ga-role-sync.tsx` 呼叫）。
 * 之後送出的每個事件都帶新角色；值不在枚舉裡就不動。
 */
let userRole: GaRole | null = null

export function setUserRole(role: GaRole): void {
  const gtag = currentGtag()
  if (!gtag || !ROLES.includes(role)) return
  userRole = role
  gtag('set', 'user_properties', { role })
}

export function trackEvent<E extends GaEvent>(
  name: E,
  ...[params]: GaParams[E] extends Record<string, never> ? [params?: GaParams[E]] : [params: GaParams[E]]
): void {
  const gtag = currentGtag()
  if (!gtag) return
  const clean = sanitizeParams(name, params)
  if (!clean) return
  const page = pageFields(window.location.origin, window.location.pathname)
  // 先 set 再送：GA 自己補送的事件（user_engagement 等）也只會帶去識別的位置。
  gtag('set', page)
  gtag('event', name, { ...clean, ...page, ...(userRole ? { user_properties: { role: userRole } } : {}) })
}
