import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { IconCircleCheck } from '@tabler/icons-react'
import { homeFor, requireSignedIn } from '@/app/_ui/guard'
import { AuthCard, LinkButton } from '@/app/_ui/primitives'
import { NarrowShell } from '@/app/_ui/site-shell'
import { actorHasRole, getRegistrationCommand, getSelfAccountCommand } from '@/composition/accounts'

export const metadata = { title: '帳號已開通｜資管系專題平台', robots: { index: false } }

/**
 * 第 3 步送出後 Q42 自動開通的畫面（VB-6；visitor-r3 §3.3、§3.6，AC-VI-55）。
 *
 * 只給**真的自動開通**的人看（資料庫裡最近一筆申請的核實方式是 `google_email_match` 或 `email_roster_match`）：還在待審的人由
 * `requireSignedIn` 帶回等待審核頁；系辦人工核准的學生導回自己的首頁——這一頁的內容就是「Email 與名單相同、
 * 不用等系辦」，對他們不成立，換成一般文案也沒有別的資訊可給，所以直接回首頁。
 * 不寄「帳號已開通」信，這一頁就是通知。GA `register_step`（`done`）已由表單送出，這裡不再送。
 */
export default async function RegisterApplyDonePage() {
  const actor = await requireSignedIn('/register/apply/done')
  if (!actorHasRole(actor, 'student') || !(await getRegistrationCommand().autoApprovedMine(actor))) redirect(homeFor(actor))
  const me = await getSelfAccountCommand().viewMine(await headers())

  return (
    <NarrowShell>
      <AuthCard title="帳號已開通">
        <div className="flex flex-col gap-5">
          <div className="flex items-start gap-3.5 rounded-[10px] bg-primary-subtle p-4.5" data-testid="auto-approved">
            <IconCircleCheck className="mt-0.5 size-5 shrink-0 text-primary-on-subtle" aria-hidden />
            <p className="text-sm leading-relaxed text-foreground">
              <span className="font-semibold break-all">{me?.loginEmail}</span> 的 Email、學號、姓名和本屆專題名單同一列，不用等系辦審核。
            </p>
          </div>
          <LinkButton href="/dashboard/student" className="h-11 w-full">
            進入學生首頁
          </LinkButton>
        </div>
      </AuthCard>
    </NarrowShell>
  )
}
