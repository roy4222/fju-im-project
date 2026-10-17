'use server'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { clientIpFrom, getSelfAccountCommand, signOut } from '@/composition/accounts'
import { authCallHeaders, sendOwnVerificationOtp, verifyEmailWithOtp } from '@/composition/signup'
import type { AccountFormState, VerifyEmailSendState } from './account-forms'

/**
 * 本人帳號頁的動作（契約 02 §7：寫用 Server Action）。
 *
 * 這裡只把表單欄位取成字串、把結果翻成畫面要的樣子。授權（已開通、fresh session）、
 * 驗證與寫入都在 `SelfAccountCommand`，直接呼叫這些 action 的人繞不過去。
 */


function field(formData: FormData, name: string, max = 300): string {
  const value = formData.get(name)
  return typeof value === 'string' && value.length <= max ? value : ''
}

function failed(
  state: AccountFormState,
  result: { message: string; code?: string; field?: string },
  values?: Record<string, string>,
): AccountFormState {
  return {
    error: result.message,
    ...(result.code ? { code: result.code } : {}),
    ...(result.field ? { field: result.field } : {}),
    ...(values ? { values } : {}),
    attempt: (state?.attempt ?? 0) + 1,
  }
}

/** 登出。 */
export async function signOutAction() {
  await signOut(await headers())
  redirect('/login')
}

/**
 * 重新確認身分：登出這一台，回登入頁重新登入後回到帳號頁（fresh session，契約 03 §2）。
 * 用密碼或 Google 重新登入都可以。
 */
export async function reconfirmAction() {
  await signOut(await headers())
  redirect(`/login?next=${encodeURIComponent('/account')}`)
}

/** 改手機與聯絡 Email。 */
export async function updateContactAction(state: AccountFormState, formData: FormData): Promise<AccountFormState> {
  const values = { phone: field(formData, 'phone', 30), contactEmail: field(formData, 'contactEmail', 300) }
  const raw = field(formData, 'expectedRevision', 10)
  const expectedRevision = /^\d+$/.test(raw) ? Number(raw) : NaN
  const result = await getSelfAccountCommand().updateContact(await headers(), { ...values, expectedRevision })
  if (!result.ok) return failed(state, result, values)
  redirect(`/account?saved=${result.revision}`)
}

/** 開始連結 Google：成功就導去 Google，回來落在 `/account?linked=google`（或 `?error=…`）。 */
export async function linkGoogleAction(state: AccountFormState): Promise<AccountFormState> {
  const result = await getSelfAccountCommand().startGoogleLink(await headers())
  if (!result.ok) return failed(state, result)
  redirect(result.url)
}

/** 替只有 Google 的帳號設一組密碼。 */
export async function setPasswordAction(state: AccountFormState, formData: FormData): Promise<AccountFormState> {
  const result = await getSelfAccountCommand().setPassword(await headers(), {
    newPassword: field(formData, 'newPassword', 200),
    passwordConfirm: field(formData, 'passwordConfirm', 200),
  })
  if (!result.ok) return failed(state, result)
  redirect('/account?password=set')
}

// ── 驗證 Email（VB-5；visitor-r3 §3.7、AC-VI-62）──────────────────────────────
//
// 寄碼走 wrapper 的內部入口：不掛 Turnstile，hook 要求本人 fresh session、只能寄給自己的登入 Email，
// 限速與 120 秒冷卻照扣。填對碼後 `users.email_verified = true`，之後同 Email 的 Google 登入會自動連結。

/** hook 回來的錯誤翻成一句話；訊息本來就是給人看的中文、不透露帳號狀態。 */
const VERIFY_ERROR_CODES = new Set(['FRESH_SESSION_REQUIRED', 'RATE_LIMITED', 'MAIL_FAILED', 'INVALID_OTP', 'UNAUTHENTICATED'])

function verifyFailure(error: unknown, fallback: string): { code: string; message: string } {
  const body = (error as { body?: { code?: unknown; message?: unknown } } | null)?.body
  const code = typeof body?.code === 'string' ? body.code : ''
  if (code === 'FRESH_SESSION_REQUIRED') {
    return { code, message: '要驗證 Email，請重新登入確認是你本人（登入後 10 分鐘內可以操作）。' }
  }
  if (VERIFY_ERROR_CODES.has(code) && typeof body?.message === 'string' && body.message) return { code, message: body.message }
  console.error('[account] 驗證 Email 時認證服務回了預期以外的錯誤', code || (error as { status?: unknown } | null)?.status)
  return { code: code || 'INTERNAL', message: fallback }
}

/** 按「驗證 Email」或「重寄驗證碼」：寄一封 6 碼到自己的登入 Email。 */
export async function sendAccountVerifyOtpAction(state: VerifyEmailSendState): Promise<VerifyEmailSendState> {
  const attempt = (state?.attempt ?? 0) + 1
  const incoming = await headers()
  const me = await getSelfAccountCommand().viewMine(incoming)
  if (!me) redirect(`/login?next=${encodeURIComponent('/account')}`)
  if (me.emailVerified) redirect('/account')
  try {
    await sendOwnVerificationOtp(new Headers(incoming))
  } catch (error) {
    const { code, message } = verifyFailure(error, '驗證碼暫時寄不出去，請稍後再試。')
    return { error: message, code, attempt }
  }
  return { sentAt: Date.now(), attempt }
}

/** 填驗證碼：對了就回帳號頁顯示「Email 已驗證」。 */
export async function verifyAccountOtpAction(state: AccountFormState, formData: FormData): Promise<AccountFormState> {
  const otp = field(formData, 'otp', 20).replace(/\s/g, '')
  if (!/^\d{6}$/.test(otp)) return failed(state, { message: '請輸入完整的 6 位數驗證碼。' })
  const incoming = await headers()
  const me = await getSelfAccountCommand().viewMine(incoming)
  if (!me) redirect(`/login?next=${encodeURIComponent('/account')}`)
  if (me.emailVerified) redirect('/account?verified=email')
  try {
    await verifyEmailWithOtp({ email: me.loginEmail, otp }, authCallHeaders({ ip: clientIpFrom(incoming) }))
  } catch (error) {
    return failed(state, verifyFailure(error, '驗證暫時無法完成，請稍後再試。'))
  }
  redirect('/account?verified=email')
}
