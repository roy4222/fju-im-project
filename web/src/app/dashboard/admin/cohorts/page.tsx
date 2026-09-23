import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { EmptyState, PageHeader } from '@/app/_ui/primitives'
import { ADMIN_NAV } from '@/app/dashboard/_nav'

export const metadata = { title: '屆別｜資管系專題平台' }

export default async function AdminCohortsPage() {
  // 授權檢查在**頁面自己**：放在 layout 擋不住，App Router 會把 layout 與 page 並行渲染，
  // layout 丟掉 children 或 redirect 都來不及——那一頁已經被做出來、跟著 payload 送走了。
  await requireRole('/dashboard/admin/cohorts', 'admin')

  return (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current="/dashboard/admin/cohorts">
      <PageHeader title="屆別" description="一屆專題從開放註冊到封存的整個流程。" />
      <EmptyState
        pending
        title="屆別功能還沒做"
        description="建立屆別、開放註冊、階段與業務時間由 S02 的切片掛上來。系級（資管二甲／資管二乙）與屆別是兩件事，不會在這裡混用。"
      />
    </DashboardShell>
  )
}
