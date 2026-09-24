import { redirect } from 'next/navigation'
import { homeFor, requireSignedIn } from '@/app/_ui/guard'
import { ActionForm, Field } from '@/app/_ui/form'
import { Card } from '@/app/_ui/primitives'
import { SignOutButton } from '@/app/_ui/sign-out'
import { SiteShell } from '@/app/_ui/site-shell'
import { getTeacherSetupCommand } from '@/composition/accounts'
import { completeTeacherSetupAction } from './actions'

export const metadata = { title: '補上老師資料｜資管系專題平台' }

/**
 * 老師第一次登入補資料（票 8；原型沒畫這一頁，沿用 `/account` 的版型）。
 *
 * 系辦建好的老師帳號（直接新增或預授權）第一次登入後先來這裡：補姓名與聯絡資料，
 * 不需要學號。補完進老師首頁；老師頁的守衛（`requireRole`）在補完之前都會導回這裡。
 *
 * 要 `business` 能力：拿臨時密碼登入的人會先被導去改密碼，改完才到這一頁。
 */
export default async function TeacherSetupPage() {
  const actor = await requireSignedIn('/account/setup', 'business')

  const view = await getTeacherSetupCommand().view(actor)
  // 不是老師（學生、只有管理員角色）：這一頁跟他無關，回自己的首頁。
  if (!view.ok) redirect(homeFor(actor))
  if (view.receipt.completed) redirect('/dashboard/teacher')
  const profile = view.receipt

  return (
    <SiteShell>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-ink">第一次登入：補上你的資料</h1>
        <SignOutButton className="rounded-md px-3 py-1.5 text-sm text-ink hover:bg-muted" />
      </div>
      <div className="mt-6 max-w-xl">
        <Card
          title="老師資料"
          description={`登入 Email：${profile.loginEmail}（登入用，不能自己改）。填完就進老師首頁，之後可以在「我的帳號」改聯絡資料。`}
        >
          <ActionForm action={completeTeacherSetupAction} submitLabel="儲存並進入老師首頁">
            <Field label="姓名" name="displayName" autoComplete="name" defaultValue={profile.displayName} />
            <Field
              label="聯絡 Email"
              name="contactEmail"
              type="email"
              autoComplete="email"
              defaultValue={profile.contactEmail}
              hint="學生與系辦聯絡你用；預設跟登入 Email 一樣。"
            />
            <Field
              label="手機"
              name="phone"
              type="tel"
              autoComplete="tel"
              defaultValue={profile.phone}
              optional
              hint="選填。"
            />
          </ActionForm>
        </Card>
      </div>
    </SiteShell>
  )
}
