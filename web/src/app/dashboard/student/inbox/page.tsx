import { requireRole } from '@/app/_ui/guard'
import { PageHeader } from '@/app/_ui/primitives'
import { DashboardShell } from '@/app/_ui/site-shell'
import { STUDENT_NAV } from '@/app/dashboard/_nav'
import { InboxView } from '@/app/dashboard/_inbox/inbox-view'

export const metadata = { title: '通知｜資管系專題平台' }

type Search = Promise<{ cohort?: string | string[]; cursor?: string | string[] }>

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)

/** 學生的通知匣（票 12）。 */
export default async function StudentInboxPage({ searchParams }: { searchParams: Search }) {
  // 授權檢查在**頁面自己**：放在 layout 擋不住（見 `_nav.ts` 與 `guard.ts` 的說明）。
  const actor = await requireRole('/dashboard/student/inbox', 'student')
  const params = await searchParams

  return (
    <DashboardShell roleLabel="學生" items={STUDENT_NAV} current="/dashboard/student/inbox">
      <PageHeader title="通知" description="跟你有關的事件都會出現在這裡。已讀狀態跟著帳號，換裝置、重新登入都還在。" />
      <InboxView actor={actor} basePath="/dashboard/student/inbox" cohortParam={first(params.cohort)} cursor={first(params.cursor)} />
    </DashboardShell>
  )
}
