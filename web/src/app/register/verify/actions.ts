'use server'
import { cookies, headers } from 'next/headers'
import { redirect, RedirectType } from 'next/navigation'
import {
  clientIpFrom,
  EMAIL_VERIFY_PATH,
  getRegistrationCommand,
  getSelfAccountCommand,
  homeForUser,
  resolveActor,
} from '@/composition/accounts'
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

/** 第 3 步；已驗證的錯誤行旁邊給這個連結（已送件、已開通的人由 page 再導到該去的地方）。 */
const NEXT_STEP_HREF = '/register/apply'
const ALREADY_VERIFIED = '這個 Email 已經驗證，請到第 3 步。'

/**
 * 這個瀏覽器的人在第 2 步是什麼處境（C ⑤-01；設計方案⑤ §1.2）。判斷順序固定「本人 session → 已驗證」：
 * - `anonymous`：沒有本人有效 session——**絕不能說「已驗證」**，照舊導回驗證頁（由 page 導去登入）。
 * - `pending`：還沒驗證、還沒送申請的本人，帶登入 Email。
 * - `verified`：本人、`users.email_verified` 當下為真（另一個分頁先填了碼）。
 * - `other`：其餘（例如有角色但沒驗證的舊帳號）——照舊導回驗證頁，由 page 導到該去的地方。
 * `homeForUser` 的目的地只用來認出 `pending`，不能拿來推定已驗證（有角色的人先回 dashboard，Email 卻可能沒驗證）。
 */
type VerifyStanding = { kind: 'anonymous' } | { kind: 'pending'; email: string } | { kind: 'verified' } | { kind: 'other' }

async function verifyStanding(incoming: Headers): Promise<VerifyStanding> {
  const actor = await resolveActor(incoming)
  if (actor.kind !== 'authenticated') return { kind: 'anonymous' }
  if ((await homeForUser(actor.userId)) === EMAIL_VERIFY_PATH) {
    const mine = await getRegistrationCommand().viewMine(actor)
    return mine.ok ? { kind: 'pending', email: mine.receipt.loginEmail } : { kind: 'other' }
  }
  const me = await getSelfAccountCommand().viewMine(incoming)
  return me?.userId === actor.userId && me.emailVerified ? { kind: 'verified' } : { kind: 'other' }
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
    if (!resume) {
      // 票不在：另一個分頁剛完成續辦（刪了票、發了本人 session、Email 已驗證）才說「可能已經驗證完成」；
      // 沒有本人 session 或還沒驗證（真正逾時、cookie 被清、換了瀏覽器）照舊回第 1 步。
      if ((await verifyStanding(incoming)).kind === 'verified') {
        return {
          error: '這個驗證碼已經用過或換過新的；如果你在另一個分頁已經驗證完成，請直接到第 3 步。',
          nextHref: NEXT_STEP_HREF,
          attempt,
        }
      }
      return { error: '這次續辦已經失效（逾時或有更新的驗證信），請回第 1 步重新填一次。', attempt }
    }
    try {
      await completeSignupResume({ email: resume.email, otp, ticket: resume.ticket }, callHeaders)
    } catch (error) {
      return { error: authErrorMessage(error, '驗證暫時無法完成，請稍後再試。').message, attempt }
    }
    jar.delete({ name: RESUME_COOKIE, path: '/register' })
    // replace：按上一頁不會回到還開著表單的驗證頁（設計方案⑤ §1.2 V4-b）。
    redirect(NEXT_STEP_HREF, RedirectType.replace)
  }

  const standing = await verifyStanding(incoming)
  // 另一個分頁先填了碼：明講，不靜默轉走（剛送的碼沒有被接受，是錯誤行不是成功）。
  if (standing.kind === 'verified') return { error: ALREADY_VERIFIED, nextHref: NEXT_STEP_HREF, attempt }
  // 沒登入或其他狀態：照自己的狀態走。
  if (standing.kind !== 'pending') redirect('/register/verify')
  try {
    await verifyEmailWithOtp({ email: standing.email, otp }, callHeaders)
  } catch (error) {
    return { error: authErrorMessage(error, '驗證暫時無法完成，請稍後再試。').message, attempt }
  }
  redirect(NEXT_STEP_HREF, RedirectType.replace)
}

/** 重寄驗證碼：每次都要一個新的 Turnstile token；120 秒冷卻與寄送上限在伺服器 hook。 */
export async function resendOtpAction(state: ResendFormState, formData: FormData): Promise<ResendFormState> {
  const attempt = (state?.attempt ?? 0) + 1
  const incoming = await headers()
  const standing = await verifyStanding(incoming)
  if (standing.kind === 'verified') return { error: ALREADY_VERIFIED, nextHref: NEXT_STEP_HREF, attempt }
  if (standing.kind !== 'pending') redirect('/register/verify')
  try {
    await resendVerificationOtp(
      { email: standing.email },
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
 * （e2e 抓到的）；cookie 跟暫存列同壽命（截止＋10 分鐘，開始時設一次、重寄不延），回第 1 步重填會換成新票。
 * 續辦頁還開著但 cookie 已經沒了（壽命到了或被清掉）→ 一樣是「續辦已逾時」與連結（不查伺服器、不寄信；
 * 之前會說「已寄出」卻什麼都沒寄）。
 */
export async function resendResumeOtpAction(state: ResendFormState, formData: FormData): Promise<ResendFormState> {
  const attempt = (state?.attempt ?? 0) + 1
  const incoming = await headers()
  const jar = await cookies()
  const resume = decodeResume(jar.get(RESUME_COOKIE)?.value)
  if (!resume) return { error: '續辦已逾時，請重新開始。', restartHref: '/register', attempt }
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
  // 視窗跟新碼一起重開 10 分鐘（最多到續辦開始後 30 分鐘；由伺服器管）；cookie 開始時就設到截止＋10 分鐘，這裡不動。
  return { sentAt: Date.now(), attempt }
}
