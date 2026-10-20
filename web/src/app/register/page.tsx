import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { Turnstile } from '@/app/_turnstile/turnstile'
import { currentActor } from '@/app/_ui/guard'
import { googleSignInErrorMessage } from '@/app/_ui/oauth-messages'
import { GoogleButton } from '@/app/login/google-button'
import { homeForUser, isRegistrationOpen, PASSWORD_MIN_LENGTH } from '@/composition/accounts'
import { signUpStepAction } from './actions'
import { RegisterForm } from './_components/register-form'
import { RegisterFrame, stepDir } from './_components/register-frame'

export const metadata = { title: '註冊｜資管系專題平台' }

/**
 * 學生註冊第 1 步「建立帳號」（VB-3；visitor-r3 §3.3，原型 `register-flow.tsx`）。
 *
 * 只收 Email 與密碼；Email 驗證在第 2 步（`/register/verify`），姓名、學號、系級、手機在第 3 步（`/register/apply`）。
 * 「使用 Google 帳號註冊」直接到第 3 步（Email 已由 Google 證明）。
 * **這一頁不告訴你這個 Email 有沒有帳號**：已有帳號、停用、老師預授權都是同一句「這個 Email 無法用來註冊…」。
 *
 * 註冊關閉時（正式站第一段，設計方案 §5）整頁是 404，不透露功能存在；真正的拒絕在 Better Auth 的 hook。
 */
export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[]; email?: string | string[]; dir?: string | string[] }>
}) {
  if (!isRegistrationOpen()) notFound()
  const params = await searchParams
  const googleError = googleSignInErrorMessage(params.error)
  const actor = await currentActor()
  // 已登入的人（含還沒驗證 Email、還沒送申請的）照自己的狀態去該去的那一步。
  if (actor.kind === 'authenticated') redirect(await homeForUser(actor.userId))
  // 「回上一步」帶回來的 Email（只是預填，伺服器不信它）。
  const initialEmail = typeof params.email === 'string' && params.email.length <= 254 ? params.email : ''

  return (
    <RegisterFrame step={1} dir={stepDir(params.dir)} title="建立帳號" description="學生用這個頁面註冊；老師帳號由系辦建立，不需要在這裡註冊。">
      {googleError ? (
        <p role="alert" className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger-on-subtle" data-testid="google-error">
          {googleError}
        </p>
      ) : null}
      <div>
        <GoogleButton from="register" label="使用 Google 帳號註冊" />
        <p className="mt-2 text-xs text-muted-foreground">用 Google 註冊不用另外驗證 Email，接著填學生資料就好。</p>
      </div>
      <div className="flex items-center gap-3 text-[13px] text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        或用 Email 建立帳號
        <span className="h-px flex-1 bg-border" />
      </div>
      <RegisterForm
        action={signUpStepAction}
        initialEmail={initialEmail}
        passwordMin={PASSWORD_MIN_LENGTH}
        turnstile={<Turnstile action="signup" />}
      />
      <p className="text-center text-xs leading-relaxed text-muted-foreground">
        繼續即表示你同意本站的
        <Link href="/privacy" className="font-semibold text-foreground underline underline-offset-2 hover:text-primary">
          隱私權政策
        </Link>
        。
      </p>
      <p className="text-center text-[13px] text-muted-foreground">
        已經有帳號？
        <Link className="font-bold text-primary hover:underline" href="/login">
          登入
        </Link>
      </p>
    </RegisterFrame>
  )
}
