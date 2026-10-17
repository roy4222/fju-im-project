'use server'
import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { clientIpFrom, EMAIL_VERIFY_PATH, getRegistrationCommand, homeForUser, resolveActor } from '@/composition/accounts'
import {
  authCallHeaders,
  completeSignupResume,
  resendSignupResumeOtp,
  resendVerificationOtp,
  verifyEmailWithOtp,
  type SignupResumeResendOutcome,
} from '@/composition/signup'
import {
  authErrorMessage,
  decodeResume,
  field,
  encodeResume,
  RESUME_COOKIE,
  RESUME_MAX_AGE,
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

/**
 * 續辦頁的重寄驗證碼（VB-3 Review 第 1 輪 P3、第 2 輪）：憑這個瀏覽器的續辦票，不是登入 session。
 * 每次要新的 Turnstile token；冷卻與上限跟一般重寄同一組（hook）。票不對時伺服器不寄信，畫面照樣說已寄出
 * （不透露原因）；之後填碼會得到「這次續辦已經失效」。10 分鐘視窗過了但截止內 → 伺服器照常寄新碼、視窗重開（主腦裁定）。
 * 信寄不出去 → 伺服器保留原本那封的碼與綁定，畫面說「暫時寄不出去」（跟一般重寄的失敗句同一句，不透露帳號狀態）；
 * 續辦已過絕對截止（開始起 30 分鐘）→ 不寄信，畫面「續辦已逾時，請重新開始」並給回第 1 步的連結（Email 帶著）。
 * 持票的人本來就知道這個帳號在續辦，這一句不會多洩漏帳號狀態。票在伺服器已經作廢（重寄回逾時、填碼回已失效），
 * cookie **不在這裡刪**：Server Action 回應會重新算這一頁，沒有票的續辦頁會導去登入，使用者就看不到這句與連結
 * （e2e 抓到的）；cookie 最多再活 10 分鐘，回第 1 步重填會換成新票。
 */
export async function resendResumeOtpAction(state: ResendFormState, formData: FormData): Promise<ResendFormState> {
  const attempt = (state?.attempt ?? 0) + 1
  const incoming = await headers()
  const jar = await cookies()
  const resume = decodeResume(jar.get(RESUME_COOKIE)?.value)
  if (resume) {
    let outcome: SignupResumeResendOutcome
    try {
      outcome = await resendSignupResumeOtp(
        resume,
        authCallHeaders({ ip: clientIpFrom(incoming), turnstileToken: field(formData, 'cf-turnstile-response', 4096) }),
      )
    } catch (error) {
      return { error: authErrorMessage(error, '驗證碼暫時寄不出去，請稍後再試。').message, attempt }
    }
    if (outcome === 'mail_failed') return { error: '驗證碼暫時寄不出去，請稍後再試。', attempt }
    if (outcome === 'timed_out') {
      return { error: '續辦已逾時，請重新開始。', restartHref: `/register?email=${encodeURIComponent(resume.email)}`, attempt }
    }
    // 暫存跟新碼一起延長 10 分鐘（最多到續辦開始後 30 分鐘；由伺服器管），續辦票的 cookie 也跟著延。
    jar.set(RESUME_COOKIE, encodeResume(resume), {
      httpOnly: true,
      sameSite: 'lax',
      secure: (process.env.BETTER_AUTH_URL ?? '').startsWith('https:'),
      path: '/register',
      maxAge: RESUME_MAX_AGE,
    })
  }
  return { sentAt: Date.now(), attempt }
}
