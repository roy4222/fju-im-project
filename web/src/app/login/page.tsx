import Link from 'next/link'
import { redirect } from 'next/navigation'
import { currentActor, homeFor } from '@/app/_ui/guard'
import { Turnstile } from '@/app/_turnstile/turnstile'
import { AuthSplit } from '@/app/_ui/auth-split'
import { googleSignInErrorMessage } from '@/app/_ui/oauth-messages'
import { SiteShell } from '@/app/_ui/site-shell'
import { GoogleButton } from '@/app/login/google-button'
import { LoginCard } from '@/app/login/login-card'
import { isRegistrationOpen } from '@/composition/accounts'
import { safeNextPath } from '@/shared/safe-next'

export const metadata = { title: '登入｜資管系專題平台' }

/**
 * 登入頁（原型 `/login`：Google 為主、Email 密碼備援；§2.3）。
 *
 * 已經登入的人再開這一頁會被送回自己該去的地方。Google 登入回來也是落在這裡
 * （callbackURL＝`/login?next=…`），由這一段分流：被要求改密 → 改密頁；待審 → 等待審核頁；
 * 其他 → `next`（經 `safeNextPath`）或自己的首頁。跟密碼登入的 Server Action 同一套規則。
 *
 * 外框是左圖右卡（`AuthSplit`）；卡片有登入、忘記密碼、已寄出三種模式（`login-card.tsx`）。
 * `?mode=forgot`（`/forgot-password` 導過來的）直接開在忘記密碼模式。
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[]; error?: string | string[]; mode?: string | string[] }>
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
  const mode = params.mode === 'forgot' ? 'forgot' : 'login'

  return (
    <SiteShell bare>
      <AuthSplit image={{ src: '/placeholder/campus.jpg', alt: '輔仁大學校園', width: 960, height: 639 }}>
        <LoginCard
          initialMode={mode}
          next={next}
          notice={
            <>
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
            </>
          }
          google={<GoogleButton from="login" next={next} label="使用 Google 帳號登入" />}
          turnstile={<Turnstile action="reset" />}
          registerHint={
            // 註冊說明只放這裡（首頁 hero 改介紹專題）；註冊關閉時（設計方案 §5）整段不出現。句子照 R11。
            isRegistrationOpen() ? (
              <p className="mt-4 text-center text-[13px] text-muted-foreground" data-testid="register-hint">
                還沒有帳號？學生請先
                <Link className="font-bold text-primary hover:underline" href="/register">
                  註冊
                </Link>
                。
              </p>
            ) : null
          }
        />
      </AuthSplit>
    </SiteShell>
  )
}
