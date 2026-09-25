import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { TEACHER_NAV } from '@/app/dashboard/_nav'
import { InboxView } from '@/app/dashboard/_inbox/inbox-view'

export const metadata = { title: '通知｜資管系專題平台' }

type Search = Promise<{ cohort?: string | string[]; cursor?: string | string[] }>

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)

/** 老師的通知匣（票 12）。 */
export default async function TeacherInboxPage({ searchParams }: { searchParams: Search }) {
  // 授權檢查在**頁面自己**：放在 layout 擋不住（見 `_nav.ts` 與 `guard.ts` 的說明）。
  const actor = await requireRole('/dashboard/teacher/inbox', 'teacher')
  const params = await searchParams

  return (
    <DashboardShell roleLabel="老師" items={TEACHER_NAV} current="/dashboard/teacher/inbox">
      <InboxView actor={actor} basePath="/dashboard/teacher/inbox" cohortParam={first(params.cohort)} cursor={first(params.cursor)} />
    </DashboardShell>
  )
}
