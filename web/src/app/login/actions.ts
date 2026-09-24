'use server'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { beginGoogleSignIn, signIn } from '@/composition/accounts'
import { safeNextPath } from '@/shared/safe-next'

/**
 * 登入（契約 02 §7：寫用 Server Action）。
 *
 * 用原生 `<form action={...}>`，所以**沒有 JavaScript 也登得進去**。
 * cookie 由 `nextCookies()` 外掛帶進回應（見 auth-instance）。
 */
export async function signInAction(_state: { error?: string } | undefined, formData: FormData) {
  const email = String(formData.get('email') ?? '').trim()
  const password = String(formData.get('password') ?? '')
  const next = String(formData.get('next') ?? '')

  if (!email || !password) {
    return { error: '請輸入 Email 與密碼。' }
  }

  const incoming = await headers()
  // Caddy 會帶 X-Real-IP（見 Caddyfile）；本機直連時退回 x-forwarded-for。
  const ip =
    incoming.get('x-real-ip') ?? incoming.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'

  const result = await signIn({ email, password, ip })
  if (!result.ok) return { error: result.message }

  // 被要求改密的人一律先去改密頁，`next` 不能把他帶去別的地方（票 #48 第 3 節）。
  // 其他人回原本要去的頁面；`next` 只接受站內相對路徑（規則與測試見 shared/safe-next），
  // 不合格一律回自己的首頁，免得變成開放轉址。
  const wanted = safeNextPath(next) ?? result.destination
  redirect(result.mustChangePassword ? result.destination : wanted)
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
