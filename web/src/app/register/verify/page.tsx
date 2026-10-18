import { cookies } from 'next/headers'
import { notFound, redirect } from 'next/navigation'
import { Turnstile } from '@/app/_turnstile/turnstile'
import { currentActor } from '@/app/_ui/guard'
import { EMAIL_VERIFY_PATH, getRegistrationCommand, homeForUser, isRegistrationOpen } from '@/composition/accounts'
import { backToSignupStep } from '../actions'
import { decodeResume, RESUME_COOKIE } from '../_components/form-data'
import { RegisterFrame } from '../_components/register-frame'
import { resendOtpAction, resendResumeOtpAction, verifyOtpAction } from './actions'
import { ResendForm, VerifyForm } from './verify-form'

export const metadata = { title: '驗證 Email｜資管系專題平台', robots: { index: false } }

/**
 * 註冊第 2 步「驗證 Email」（VB-3；visitor-r3 §3.3）。
 *
 * - 一般：第 1 步建好帳號、已登入受限 session、還沒驗證的人。沒登入導去登入頁；已驗證的人照狀態往下走。
 * - 續辦（`?resume=1`）：同一個 Email 有一筆還沒完成的註冊，驗證碼已寄出；沒有 session，憑這個瀏覽器的
 *   續辦票 cookie。重寄走續辦專用的入口（寄出後把暫存改綁到新碼，VB-3 Review P3）。
 */
export default async function RegisterVerifyPage({ searchParams }: { searchParams: Promise<{ resume?: string | string[] }> }) {
  if (!isRegistrationOpen()) notFound()
  const { resume } = await searchParams
  const ticket = resume === '1' ? decodeResume((await cookies()).get(RESUME_COOKIE)?.value) : null

  if (ticket) {
    return (
      <RegisterFrame
        step={2}
        title="驗證 Email"
        description={
          <>
            <p role="status" className="mb-2 rounded-md bg-primary-subtle px-3 py-2 font-semibold text-primary-on-subtle">
              這個 Email 有一筆還沒完成的註冊。驗證碼已寄到這個信箱，填入後就能繼續。
            </p>
            驗證碼已寄到 <span className="font-bold break-all text-foreground">{ticket.email}</span>，10 分鐘內有效。
          </>
        }
      >
        <VerifyForm action={verifyOtpAction} mode="resume" />
        <ResendForm action={resendResumeOtpAction} turnstile={<Turnstile action="resend" />} />
        <BackToStepOne />
      </RegisterFrame>
    )
  }

  const actor = await currentActor()
  if (actor.kind !== 'authenticated') redirect(`/login?next=${encodeURIComponent(EMAIL_VERIFY_PATH)}`)
  const home = await homeForUser(actor.userId)
  if (home !== EMAIL_VERIFY_PATH) {
    // 已驗證、還沒有角色：往第 3 步（已送過申請的人第 3 步會再帶去等待審核頁）。
    redirect(home === '/register/pending' ? '/register/apply' : home)
  }
  const mine = await getRegistrationCommand().viewMine(actor)
  if (!mine.ok) redirect('/register/pending')

  return (
    <RegisterFrame
      step={2}
      title="驗證 Email"
      description={
        <>
          驗證碼已寄到 <span className="font-bold break-all text-foreground">{mine.receipt.loginEmail}</span>，10 分鐘內有效。
        </>
      }
    >
      <VerifyForm action={verifyOtpAction} mode="signup" />
      <ResendForm action={resendOtpAction} turnstile={<Turnstile action="resend" />} />
      <BackToStepOne />
    </RegisterFrame>
  )
}

function BackToStepOne() {
  return (
    <form action={backToSignupStep} className="flex justify-center">
      <button type="submit" className="text-[13px] font-semibold text-muted-foreground hover:text-foreground hover:underline">
        Email 打錯了？回上一步修改
      </button>
    </form>
  )
}
