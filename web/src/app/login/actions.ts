'use server'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { signIn } from '@/composition/accounts'

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
  // 其他人回原本要去的頁面；`next` 只接受站內路徑，免得變成開放轉址。
  const wanted = next.startsWith('/') && !next.startsWith('//') ? next : result.destination
  redirect(result.mustChangePassword ? result.destination : wanted)
}
