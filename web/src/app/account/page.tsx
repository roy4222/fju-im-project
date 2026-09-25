import Link from 'next/link'
import type { ReactNode } from 'react'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { requireSignedIn } from '@/app/_ui/guard'
import { googleLinkErrorMessage } from '@/app/_ui/oauth-messages'
import { PublicCard, PublicPage, Tag } from '@/app/_ui/public-content'
import { SiteShell } from '@/app/_ui/site-shell'
import { actorHasRole, getSelfAccountCommand, PASSWORD_MIN_LENGTH, TEACHER_SETUP_PATH } from '@/composition/accounts'
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
  const actor = await requireSignedIn('/account', 'business')
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

  const roleLabels = (['admin', 'teacher', 'student'] as const).filter((r) => actorHasRole(actor, r)).map((r) => ROLE_LABEL[r])

  // 原型：基本資料是兩欄成對排列（唯讀的灰底框、可改的白底框混在同一個格裡）。
  // 系辦維護的欄位在前、登入 Email 接著，手機與聯絡 Email 在後（見 ContactForm 的 leadingCount）。
  const readOnlyCells = [
    <ReadOnlyField key="name" label="姓名" value={me.profile?.displayName ?? me.name} />,
    me.profile?.studentNo ? <ReadOnlyField key="no" label="學號" value={me.profile.studentNo} hint="由系辦維護" numeric /> : null,
    me.profile?.departmentClass ? <ReadOnlyField key="class" label="系級" value={me.profile.departmentClass} hint="由系辦維護" /> : null,
    me.profile?.cohortName ? <ReadOnlyField key="cohort" label="屆別" value={me.profile.cohortName} hint="由系辦維護" /> : null,
    <div key="login" className="flex min-w-0 flex-col gap-1.5" data-testid="login-email">
      <span className="text-sm font-semibold text-foreground">登入 Email</span>
      <div className="flex min-h-11 flex-wrap items-center gap-x-2 rounded-md border border-input bg-muted px-3 py-2 text-sm break-all text-muted-foreground">
        {me.loginEmail}
      </div>
      <span className="text-xs text-muted-foreground">不能自行更換</span>
    </div>,
  ].filter(Boolean)
  const readOnly = <>{readOnlyCells}</>
  const readOnlyCount = readOnlyCells.length

  return (
    <SiteShell bare>
      <PublicPage title="我的帳號" description="姓名、學號、系級與屆別由系辦維護；手機與聯絡 Email 可以自己改。">
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_360px] lg:gap-12">
          <div className="flex min-w-0 flex-col gap-6">
            {notice ? (
              <p role="status" className="rounded-[10px] bg-primary-subtle px-4 py-3 text-sm font-semibold text-primary-on-subtle" data-testid="account-notice">
                {notice}
              </p>
            ) : null}
            {linkError ? (
              <p role="alert" className="rounded-[10px] bg-danger-subtle px-4 py-3 text-sm text-danger-on-subtle" data-testid="link-error">
                {linkError}
              </p>
            ) : null}

            <PublicCard title="基本資料" aria-label="基本資料">
              {me.profile ? (
                <ContactForm
                  key={me.profile.revision}
                  phone={me.profile.phone ?? ''}
                  contactEmail={me.profile.contactEmail}
                  revision={me.profile.revision}
                  leading={readOnly}
                  leadingCount={readOnlyCount}
                />
              ) : (
                <>
                  <div className="grid gap-x-3.5 gap-y-4 sm:grid-cols-2" aria-label="系辦維護的資料" role="group">
                    {readOnly}
                  </div>
                  {actorHasRole(actor, 'teacher') ? (
                    // 系辦建的老師帳號第一次登入要先補資料（票 8 的 /account/setup）。
                    <QuietNote title="基本資料還沒補" action={{ href: TEACHER_SETUP_PATH, label: '去補資料' }}>
                      第一次登入請先補上姓名與聯絡資料，補完之後這裡就能改手機與聯絡 Email。
                    </QuietNote>
                  ) : (
                    <QuietNote title="基本資料還沒建立">系辦建立你的資料之後，這裡就能改手機與聯絡 Email。</QuietNote>
                  )}
                </>
              )}
            </PublicCard>

            {/* 原型：標題下直接兩列「方式＋帳號／說明」＋右邊狀態或動作，不放說明段。 */}
            <PublicCard title="登入方式">
              <ul className="-mt-1.5 flex flex-col" aria-label="登入方式">
                <li className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-3" data-testid="method-google">
                  <span className="min-w-0 font-semibold break-all text-foreground">
                    Google
                    <span className="ml-3 font-normal text-muted-foreground">{me.loginMethods.google ? me.loginEmail : '未連結'}</span>
                  </span>
                  {me.loginMethods.google ? <Tag tone="ink">已連結</Tag> : me.sessionFresh ? <LinkGoogleForm /> : null}
                </li>
                <li className="flex flex-wrap items-center justify-between gap-3 py-3" data-testid="method-password">
                  <span className="min-w-0 font-semibold text-foreground">
                    Email／密碼
                    <span className="ml-3 font-normal text-muted-foreground">{me.loginMethods.password ? '用登入 Email 與密碼登入' : '未設定'}</span>
                  </span>
                  {me.loginMethods.password ? (
                    <Link href="/account/change-password" className="font-semibold text-primary hover:underline">
                      更改密碼
                    </Link>
                  ) : null}
                </li>
              </ul>

              {needsSecondMethod && !me.sessionFresh ? (
                <div className="rounded-[10px] bg-muted px-4 py-3 text-sm" data-testid="reconfirm">
                  <p className="text-foreground">
                    {me.loginMethods.google ? '要設定密碼' : '要連結 Google'}，請先重新登入確認是你本人（登入後 10 分鐘內可以操作）。
                  </p>
                  <div className="mt-3">
                    <ReconfirmButton />
                  </div>
                </div>
              ) : null}

              {!me.loginMethods.password && me.sessionFresh ? (
                <div className="border-t border-border pt-4">
                  <p className="mb-3 text-sm text-muted-foreground">
                    設定之後，也可以用登入 Email（{me.loginEmail}）與這組密碼登入。
                  </p>
                  <SetPasswordForm minLength={PASSWORD_MIN_LENGTH} />
                </div>
              ) : null}

              {!me.loginMethods.google && me.sessionFresh ? (
                <p className="text-xs text-muted-foreground">
                  連結的 Google 帳號 Email 必須和登入 Email 相同；已經連到別的帳號的 Google 不能再連。
                </p>
              ) : null}
            </PublicCard>
          </div>

          <aside className="flex flex-col gap-4">
            <div className="flex flex-col gap-2 rounded-xl bg-secondary p-5.5 text-secondary-foreground">
              <p className="font-bold text-foreground">帳號狀態</p>
              <Tag tone="ink" className="self-start">
                已開通{roleLabels.length > 0 ? `・${roleLabels.join('、')}` : ''}
              </Tag>
              <p className="text-[13px] leading-relaxed text-muted-foreground">角色由系辦授予；要改學號、姓名或屆別請聯絡系辦。</p>
            </div>
          </aside>
        </div>
      </PublicPage>
    </SiteShell>
  )
}

const ROLE_LABEL = { admin: '系辦', teacher: '老師', student: '學生' } as const

/** 系辦維護的欄位（原型的唯讀輸入框樣子：灰底、不能改）。 */
function ReadOnlyField({ label, value, hint, numeric = false }: { label: string; value: string; hint?: string; numeric?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-sm font-semibold text-foreground">{label}</span>
      <div className={`flex min-h-11 items-center rounded-md border border-input bg-muted px-3 py-2 text-sm break-all text-muted-foreground ${numeric ? 'tabular-nums' : ''}`}>
        {value}
      </div>
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </div>
  )
}

/** 卡片裡的一句說明＋下一步（虛線框）。 */
function QuietNote({ title, children, action }: { title: string; children: ReactNode; action?: { href: string; label: string } }) {
  return (
    <div className="flex flex-col items-start gap-1.5 rounded-[10px] border border-dashed border-border px-5 py-4">
      <p className="font-bold text-foreground">{title}</p>
      <p className="text-[13px] leading-relaxed text-muted-foreground">{children}</p>
      {action ? (
        <Link href={action.href} className="btn-fju mt-2 h-10 px-4 text-sm">
          {action.label}
        </Link>
      ) : null}
    </div>
  )
}
