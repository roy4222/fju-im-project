'use server'
import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { beginGoogleSignIn, clientIpFrom, signIn } from '@/composition/accounts'
import { authCallHeaders, requestPasswordReset } from '@/composition/password'
import { safeNextPath } from '@/shared/safe-next'
import type { ForgotState } from './forgot-state'

/**
 * 登入（契約 02 §7：寫用 Server Action）。
 *
 * 用原生 `<form action={...}>`，所以**沒有 JavaScript 也登得進去**。
 * cookie 由 `nextCookies()` 外掛帶進回應（見 auth-instance）。
 */
type SignInState = { error: string; values: { email: string }; attempt: number } | undefined

export async function signInAction(state: SignInState, formData: FormData): Promise<SignInState> {
  const email = String(formData.get('email') ?? '').trim()
  const password = String(formData.get('password') ?? '')
  const next = String(formData.get('next') ?? '')

  // 失敗時把 Email 帶回去讓表單保留（網站問題 #2）；**密碼不帶回**，使用者重打密碼就好。
  // 長得離譜的值不回傳，免得把巨大字串送回瀏覽器。
  const failed = (error: string): SignInState => ({
    error,
    values: { email: email.length <= 254 ? email : '' },
    attempt: (state?.attempt ?? 0) + 1,
  })

  if (!email || !password) return failed('請輸入 Email 與密碼。')

  const incoming = await headers()
  // Caddy 會帶 X-Real-IP（見 Caddyfile）；本機直連時退回 x-forwarded-for。
  const ip =
    incoming.get('x-real-ip') ?? incoming.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'

  const result = await signIn({ email, password, ip })
  if (!result.ok) return failed(result.message)

  // 被要求改密的人一律先去改密頁，`next` 不能把他帶去別的地方（票 #48 第 3 節）。
  // 其他人回原本要去的頁面；`next` 只接受站內相對路徑（規則與測試見 shared/safe-next），
  // 不合格一律回自己的首頁，免得變成開放轉址。
  const wanted = safeNextPath(next) ?? result.destination
  await markPasswordLogin()
  redirect(result.mustChangePassword ? result.destination : wanted)
}

/** 一次性分析 cookie（B 設計方案 §7.3.1，▶R2-2）：前台的 `page-view.tsx` 讀到就清掉、送一次 GA `login`。 */
const GA_LOGIN_COOKIE = 'fju_ga_login'

/**
 * 密碼登入成功、導頁之前寫 `fju_ga_login=password`。值只有登入方式，不帶任何個資；
 * client 要讀所以**不設 HttpOnly**；60 秒就失效；HTTPS 站台才加 `Secure`（本機、e2e 是 http）。
 */
async function markPasswordLogin() {
  const secure = (process.env.BETTER_AUTH_URL ?? '').startsWith('https://')
  ;(await cookies()).set(GA_LOGIN_COOKIE, 'password', { path: '/', sameSite: 'lax', maxAge: 60, httpOnly: false, secure })
}

const SHOWN_RESET_ERRORS = new Set(['RATE_LIMITED', 'TURNSTILE_REQUIRED', 'TURNSTILE_UNAVAILABLE'])

/**
 * 忘記密碼模式送出（visitor-r3 設計方案 §3.4）：經 wrapper 呼叫 Better Auth 的寄重設連結。
 *
 * **不論 Email 存不存在、信寄不寄得出去都回 `sent`**（不洩漏帳號存在；寄失敗只留在 `mail_outbox`）。
 * 只有限速（429）與人機驗證這兩種跟帳號無關的擋法會把訊息帶回畫面；限速的桶在查帳號之前就扣，
 * 有沒有這個帳號擋法都一樣。其他錯一律當成已寄出——分辨了就等於多一個查帳號的通道。
 */
export async function requestPasswordResetAction(state: ForgotState, formData: FormData): Promise<ForgotState> {
  const email = String(formData.get('email') ?? '').trim()
  const failed = (error: string): ForgotState => ({
    status: 'error',
    error,
    values: { email: email.length <= 254 ? email : '' },
    attempt: (state?.status === 'error' ? state.attempt : 0) + 1,
  })
  if (!email || email.length > 254 || !email.includes('@')) return failed('請輸入正確的 Email。')

  const callHeaders = authCallHeaders({
    ip: clientIpFrom(await headers()),
    turnstileToken: String(formData.get('cf-turnstile-response') ?? ''),
  })
  try {
    await requestPasswordReset({ email }, callHeaders)
  } catch (error) {
    const body = (error as { body?: { code?: unknown; message?: unknown } } | null)?.body
    if (typeof body?.code === 'string' && SHOWN_RESET_ERRORS.has(body.code)) {
      return failed(typeof body.message === 'string' ? body.message : '請稍後再試。')
    }
    console.error('[login] 寄重設連結失敗', typeof body?.code === 'string' ? body.code : 'unknown')
  }
  return { status: 'sent', email }
}

/**
 * 用 Google 登入或註冊（票 10）。
 *
 * 只取兩個欄位：`from`（登入頁或註冊頁）與 `next`（登入後要回去的頁面）。`next` 在 composition
 * 裡經 `safeNextPath`，不合格就當沒帶。成功就導去 Google；Google 回來後由套件的 callback
 * 建 session，再導回登入頁分流（見 `beginGoogleSignIn`）。
 */
export async function googleSignInAction(_state: { error?: string } | undefined, formData: FormData) {
  const from = formData.get('from') === 'register' ? 'register' : 'login'
  const result = await beginGoogleSignIn({ from, next: formData.get('next'), headers: await headers() })
  if (!result.ok) return { error: result.message }
  redirect(result.url)
}
