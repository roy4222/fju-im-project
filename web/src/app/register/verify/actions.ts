'use server'
import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { clientIpFrom, EMAIL_VERIFY_PATH, getRegistrationCommand, homeForUser, resolveActor } from '@/composition/accounts'
import { authCallHeaders, completeSignupResume, resendVerificationOtp, verifyEmailWithOtp } from '@/composition/signup'
import {
  authErrorMessage,
  decodeResume,
  field,
  RESUME_COOKIE,
  type ResendFormState,
  type VerifyFormState,
} from '../_components/form-data'
import { isCompleteOtp } from '../_components/signup-checks'

/**
 * 註冊第 2 步：驗證 Email（VB-3；visitor-r3 §3.2、§3.3）。
 *
 * - 一般：已登入（受限 session）、還沒驗證的本人，填碼 → `verify-email` → 第 3 步。
 * - 續辦（`?resume=1`）：沒有 session，憑這個瀏覽器的續辦票 cookie 填碼 → 一筆交易換新密碼、撤舊 session、
 *   發新 session → 第 3 步。
 * 驗證碼錯、限速等訊息都由 hook 給（同一句，不透露帳號狀態）。
 */

/** 本人的登入 Email（一般模式）；不是「還沒驗證、還沒送申請」的人回 null。 */
async function pendingVerificationEmail(incoming: Headers): Promise<string | null> {
  const actor = await resolveActor(incoming)
  if (actor.kind !== 'authenticated') return null
  if ((await homeForUser(actor.userId)) !== EMAIL_VERIFY_PATH) return null
  const mine = await getRegistrationCommand().viewMine(actor)
  return mine.ok ? mine.receipt.loginEmail : null
}

export async function verifyOtpAction(state: VerifyFormState, formData: FormData): Promise<VerifyFormState> {
  const attempt = (state?.attempt ?? 0) + 1
  const otp = field(formData, 'otp', 20).replace(/\s/g, '')
  if (!isCompleteOtp(otp)) return { error: '請輸入完整的 6 位數驗證碼。', attempt }

  const incoming = await headers()
  const callHeaders = authCallHeaders({ ip: clientIpFrom(incoming) })
  const jar = await cookies()

  if (field(formData, 'mode', 10) === 'resume') {
    const resume = decodeResume(jar.get(RESUME_COOKIE)?.value)
    if (!resume) return { error: '這次續辦已經失效（逾時或有更新的驗證信），請回第 1 步重新填一次。', attempt }
    try {
      await completeSignupResume({ email: resume.email, otp, ticket: resume.ticket }, callHeaders)
    } catch (error) {
      return { error: authErrorMessage(error, '驗證暫時無法完成，請稍後再試。').message, attempt }
    }
    jar.delete({ name: RESUME_COOKIE, path: '/register' })
    redirect('/register/apply')
  }

  const email = await pendingVerificationEmail(incoming)
  // 已經驗證過（例如另一個分頁先填了）或沒登入：照自己的狀態走。
  if (!email) redirect('/register/verify')
  try {
    await verifyEmailWithOtp({ email, otp }, callHeaders)
  } catch (error) {
    return { error: authErrorMessage(error, '驗證暫時無法完成，請稍後再試。').message, attempt }
  }
  redirect('/register/apply')
}

/** 重寄驗證碼：每次都要一個新的 Turnstile token；120 秒冷卻與寄送上限在伺服器 hook。 */
export async function resendOtpAction(state: ResendFormState, formData: FormData): Promise<ResendFormState> {
  const attempt = (state?.attempt ?? 0) + 1
  const incoming = await headers()
  const email = await pendingVerificationEmail(incoming)
  if (!email) redirect('/register/verify')
  try {
    await resendVerificationOtp(
      { email },
      authCallHeaders({ ip: clientIpFrom(incoming), turnstileToken: field(formData, 'cf-turnstile-response', 4096) }),
    )
  } catch (error) {
    return { error: authErrorMessage(error, '驗證碼暫時寄不出去，請稍後再試。').message, attempt }
  }
  return { sentAt: Date.now(), attempt }
}
