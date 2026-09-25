import Link from 'next/link'
import { redirect } from 'next/navigation'
import { currentActor, homeFor } from '@/app/_ui/guard'
import { ActionForm, Field, HiddenField } from '@/app/_ui/form'
import { googleSignInErrorMessage } from '@/app/_ui/oauth-messages'
import { AuthCard } from '@/app/_ui/primitives'
import { NarrowShell } from '@/app/_ui/site-shell'
import { signInAction } from '@/app/login/actions'
import { GoogleButton } from '@/app/login/google-button'
import { safeNextPath } from '@/shared/safe-next'

export const metadata = { title: '登入｜資管系專題平台' }

/**
 * 登入頁（原型 `/login`：Google 為主、Email 密碼備援；§2.3）。
 *
 * 已經登入的人再開這一頁會被送回自己該去的地方。Google 登入回來也是落在這裡
 * （callbackURL＝`/login?next=…`），由這一段分流：被要求改密 → 改密頁；待審 → 等待審核頁；
 * 其他 → `next`（經 `safeNextPath`）或自己的首頁。跟密碼登入的 Server Action 同一套規則。
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[]; error?: string | string[] }>
}) {
  const params = await searchParams
  // 不合格的 `next` 當作沒帶：不放進表單、也不顯示「登入後會回到…」。
  const next = safeNextPath(params.next)
  const actor = await currentActor()
  if (actor.kind === 'authenticated') {
    if (actor.mustChangePassword) redirect('/account/change-password')
    const home = homeFor(actor)
    redirect(actor.status === 'active' && next ? next : home)
  }
  const googleError = googleSignInErrorMessage(params.error)

  return (
    <NarrowShell>
      <AuthCard title="登入" description="學生、老師與系辦使用同一個入口。">
        {next ? (
          <p className="mb-4 rounded-md bg-primary-subtle px-3 py-2 text-sm text-primary-on-subtle">
            登入後會回到你原本要去的頁面。
          </p>
        ) : null}
        {googleError ? (
          <p role="alert" className="mb-4 rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger-on-subtle" data-testid="google-error">
            {googleError}
          </p>
        ) : null}

        <GoogleButton from="login" next={next} label="使用 Google 帳號登入" />

        <div className="my-5 flex items-center gap-3 text-[13px] text-muted-foreground">
          <span className="h-px flex-1 bg-border" />
          或使用 Email 與密碼
          <span className="h-px flex-1 bg-border" />
        </div>

        <ActionForm action={signInAction} submitLabel="登入">
          <Field label="Email" name="email" type="email" autoComplete="username" />
          <Field label="密碼" name="password" type="password" autoComplete="current-password" />
          {next ? <HiddenField name="next" value={next} /> : null}
        </ActionForm>
        <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
          <Link className="font-bold text-primary hover:underline" href="/forgot-password">
            忘記密碼？
          </Link>{' '}
          不寄信，請找系辦核對身分後發臨時密碼。
        </p>
        <p className="mt-4 text-center text-[13px] text-muted-foreground">
          還沒有帳號？
          <Link className="font-bold text-primary hover:underline" href="/register">
            註冊
          </Link>
        </p>
      </AuthCard>
    </NarrowShell>
  )
}
