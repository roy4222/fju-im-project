import Link from 'next/link'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { requireSignedIn } from '@/app/_ui/guard'
import { googleLinkErrorMessage } from '@/app/_ui/oauth-messages'
import { SignOutButton } from '@/app/_ui/sign-out'
import { Card, EmptyState } from '@/app/_ui/primitives'
import { SiteShell } from '@/app/_ui/site-shell'
import { getSelfAccountCommand, PASSWORD_MIN_LENGTH } from '@/composition/accounts'
import { ContactForm, LinkGoogleForm, ReconfirmButton, SetPasswordForm } from './account-forms'

export const metadata = { title: '我的帳號｜資管系專題平台', robots: { index: false } }

/**
 * 本人帳號頁（票 10；原型 `/account`）。
 *
 * 要 `business` 能力：待審核與被要求改密的人會先被導去各自的頁面（待審核頁、改密頁）。
 *
 * - 基本資料：姓名、學號、系級、屆別由系辦維護（唯讀）；手機與聯絡 Email 本人可改。
 *   **登入 Email 本人不能改**（§2.3 Q3），只顯示。
 * - 登入方式：Google 與密碼各一列。沒有的那一種可以在這裡「連結 Google」或「設定密碼」，
 *   兩者都要 fresh session（10 分鐘內登入過）；不夠新就請人重新登入確認身分。
 *
 * 與原型的差異：原型的「儲存變更」沒接、密碼列連到寄信重設；正式版寫 `user_profiles` 並回執，
 * 密碼列改成「更改密碼」（已有密碼）或「設定密碼」（只有 Google）。
 */
export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; linked?: string; password?: string; error?: string | string[] }>
}) {
  await requireSignedIn('/account', 'business')
  const me = await getSelfAccountCommand().viewMine(await headers())
  if (!me) redirect(`/login?next=${encodeURIComponent('/account')}`)

  const params = await searchParams
  const linkError = googleLinkErrorMessage(params.error)
  const notice =
    params.linked === 'google' && me.loginMethods.google
      ? '已連結 Google。之後用 Google 或密碼登入，都會回到這個帳號。'
      : params.password === 'set' && me.loginMethods.password
        ? '密碼已設定。之後也可以用登入 Email 與這組密碼登入。'
        : typeof params.saved === 'string' && /^\d+$/.test(params.saved)
          ? '聯絡資料已更新。'
          : null
  const needsSecondMethod = !me.loginMethods.google || !me.loginMethods.password

  return (
    <SiteShell>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-ink">我的帳號</h1>
        <SignOutButton className="rounded-md px-3 py-1.5 text-sm text-ink hover:bg-muted" />
      </div>

      {notice ? (
        <p role="status" className="mt-4 rounded-md bg-primary-subtle px-3 py-2 text-sm text-primary-on-subtle" data-testid="account-notice">
          {notice}
        </p>
      ) : null}
      {linkError ? (
        <p role="alert" className="mt-4 rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger-on-subtle" data-testid="link-error">
          {linkError}
        </p>
      ) : null}

      <div className="mt-6 grid gap-4">
        <Card title="基本資料" description="姓名、學號、系級與屆別由系辦維護；手機與聯絡 Email 可以自己改。">
          <dl className="grid grid-cols-[6.5rem_1fr] gap-y-2 text-sm" aria-label="系辦維護的資料">
            <dt className="text-muted-foreground">姓名</dt>
            <dd className="font-medium text-ink">{me.profile?.displayName ?? me.name}</dd>
            <dt className="text-muted-foreground">登入 Email</dt>
            <dd className="break-all font-medium text-ink" data-testid="login-email">
              {me.loginEmail}
              <span className="ml-2 text-xs font-normal text-muted-foreground">不能自行更換</span>
            </dd>
            {me.profile?.studentNo ? (
              <>
                <dt className="text-muted-foreground">學號</dt>
                <dd className="font-medium tabular-nums text-ink">{me.profile.studentNo}</dd>
              </>
            ) : null}
            {me.profile?.departmentClass ? (
              <>
                <dt className="text-muted-foreground">系級</dt>
                <dd className="font-medium text-ink">{me.profile.departmentClass}</dd>
              </>
            ) : null}
            {me.profile?.cohortName ? (
              <>
                <dt className="text-muted-foreground">屆別</dt>
                <dd className="font-medium text-ink">{me.profile.cohortName}</dd>
              </>
            ) : null}
          </dl>
          <div className="mt-5 border-t border-border pt-5">
            {me.profile ? (
              <ContactForm
                key={me.profile.revision}
                phone={me.profile.phone ?? ''}
                contactEmail={me.profile.contactEmail}
                revision={me.profile.revision}
              />
            ) : (
              <EmptyState
                title="基本資料還沒建立"
                description="系辦建立你的資料之後，這裡就能改手機與聯絡 Email。"
              />
            )}
          </div>
        </Card>

        <Card title="登入方式" description="同一個帳號可以同時用 Google 與密碼登入；兩種方式看到的是同一份資料。">
          <ul className="divide-y divide-border text-sm" aria-label="登入方式">
            <li className="flex flex-wrap items-center justify-between gap-3 py-3" data-testid="method-google">
              <span className="font-medium text-ink">Google</span>
              {me.loginMethods.google ? (
                <span className="rounded-full bg-primary-subtle px-3 py-1 text-xs font-medium text-primary-on-subtle">已連結</span>
              ) : me.sessionFresh ? (
                <LinkGoogleForm />
              ) : (
                <span className="text-muted-foreground">未連結</span>
              )}
            </li>
            <li className="flex flex-wrap items-center justify-between gap-3 py-3" data-testid="method-password">
              <span className="font-medium text-ink">Email／密碼</span>
              {me.loginMethods.password ? (
                <Link href="/account/change-password" className="font-medium text-primary-on-subtle underline">
                  更改密碼
                </Link>
              ) : (
                <span className="text-muted-foreground">未設定</span>
              )}
            </li>
          </ul>

          {needsSecondMethod && !me.sessionFresh ? (
            <div className="mt-4 rounded-md bg-muted px-4 py-3 text-sm" data-testid="reconfirm">
              <p className="text-ink">
                {me.loginMethods.google ? '要設定密碼' : '要連結 Google'}，請先重新登入確認是你本人（登入後 10 分鐘內可以操作）。
              </p>
              <div className="mt-3">
                <ReconfirmButton />
              </div>
            </div>
          ) : null}

          {!me.loginMethods.password && me.sessionFresh ? (
            <div className="mt-4 border-t border-border pt-4">
              <p className="mb-3 text-sm text-muted-foreground">
                設定之後，也可以用登入 Email（{me.loginEmail}）與這組密碼登入。
              </p>
              <SetPasswordForm minLength={PASSWORD_MIN_LENGTH} />
            </div>
          ) : null}

          {!me.loginMethods.google && me.sessionFresh ? (
            <p className="mt-3 text-xs text-muted-foreground">
              連結的 Google 帳號 Email 必須和登入 Email 相同；已經連到別的帳號的 Google 不能再連。
            </p>
          ) : null}
        </Card>
      </div>
    </SiteShell>
  )
}
