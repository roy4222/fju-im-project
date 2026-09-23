import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { EmptyState, PageHeader, Tile } from '@/app/_ui/primitives'
import { ADMIN_NAV } from '@/app/dashboard/_nav'

export const metadata = { title: '系辦首頁｜資管系專題平台' }

export default async function AdminHomePage() {
  // 授權檢查在**頁面自己**：放在 layout 擋不住，App Router 會把 layout 與 page 並行渲染，
  // layout 丟掉 children 或 redirect 都來不及——那一頁已經被做出來、跟著 payload 送走了。
  await requireRole('/dashboard/admin', 'admin')

  return (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current="/dashboard/admin">
      <PageHeader title="系辦首頁" description="這一批只做骨架；數字與待辦由後面的切片填。" />
      <div className="grid gap-4 sm:grid-cols-3">
        <Tile label="待審核申請" value="—" hint="S01-11 之後才有數字" />
        <Tile label="已核准學生" value="—" hint="S01-11 之後才有數字" />
        <Tile label="目前工作屆別" value="—" hint="S02-01 之後才有屆別" />
      </div>
      <div className="mt-6">
        <EmptyState
          pending
          title="今天要處理的事還沒接上"
          description="待審申請、到期提醒與通知匣會出現在這裡。目前側欄只有「帳號」與「屆別」兩個掛載點，點進去都是空狀態。"
        />
      </div>
    </DashboardShell>
  )
}
