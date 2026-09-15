import Link from 'next/link'
import { redirect } from 'next/navigation'
import { currentActor, homeFor } from '@/app/_ui/guard'
import { ActionForm, Field, HiddenField } from '@/app/_ui/form'
import { Card, EmptyState } from '@/app/_ui/primitives'
import { NarrowShell } from '@/app/_ui/site-shell'
import { signInAction } from '@/app/login/actions'

export const metadata = { title: '登入｜資管系專題平台' }

/**
 * 登入頁。
 *
 * Google 登入（S01-14）與 Turnstile（S01-15）還沒接，所以這一頁現在只有 Email 密碼。
 * 已經登入的人再開這一頁會被送回自己該去的地方，不會看到一個沒有用的登入表單。
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>
}) {
  const { next } = await searchParams
  const actor = await currentActor()
  if (actor.kind === 'authenticated') {
    redirect(actor.mustChangePassword ? '/account/change-password' : homeFor(actor))
  }

  return (
    <NarrowShell>
      <Card title="登入" description="用系上的 Email 與密碼登入。">
        {next ? (
          <p className="mb-4 rounded-md bg-primary-subtle px-3 py-2 text-sm text-primary-on-subtle">
            登入後會回到你原本要去的頁面。
          </p>
        ) : null}
        <ActionForm action={signInAction} submitLabel="登入">
          <Field label="Email" name="email" type="email" autoComplete="username" />
          <Field label="密碼" name="password" type="password" autoComplete="current-password" />
          {next ? <HiddenField name="next" value={next} /> : null}
        </ActionForm>
      </Card>

      <div className="mt-4">
        <EmptyState
          pending
          title="Google 登入還沒接"
          description="用 Google 登入由 S01-14 掛上來。忘記密碼不寄信，請找系辦發臨時密碼。"
        />
      </div>

      <p className="mt-4 text-center text-sm text-muted-foreground">
        還沒有帳號？<Link className="underline" href="/register">註冊</Link>
      </p>
    </NarrowShell>
  )
}
