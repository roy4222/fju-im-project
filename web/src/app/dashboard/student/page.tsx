import { requireRole } from '@/app/_ui/guard'
import { StageBanner } from '@/app/dashboard/_stage'
import { DashboardShell } from '@/app/_ui/site-shell'
import { EmptyState, PageHeader, Tile } from '@/app/_ui/primitives'
import { STUDENT_NAV } from '@/app/dashboard/_nav'

export const metadata = { title: '學生首頁｜資管系專題平台' }

export default async function StudentHomePage() {
  // 授權檢查在**頁面自己**：放在 layout 擋不住，App Router 會把 layout 與 page 並行渲染，
  // layout 丟掉 children 或 redirect 都來不及——那一頁已經被做出來、跟著 payload 送走了。
  const actor = await requireRole('/dashboard/student', 'student')

  return (
    <DashboardShell roleLabel="學生" items={STUDENT_NAV} current="/dashboard/student">
      <PageHeader title="我的專題" description="組別、要交的東西與截止日都會出現在這裡。" />
      <StageBanner actor={actor} perspective="student" showStages />
      <div className="grid gap-4 sm:grid-cols-2">
        <Tile label="我的組別" value="—" hint="分組功能開放後會顯示" />
        <Tile label="待繳交" value="—" hint="繳交功能開放後會顯示" />
      </div>
      <div className="mt-6">
        <EmptyState
          pending
          title="學生的功能還沒做"
          description="分組提案、個人繳交與組別繳交會陸續開放，開放後會出現在這裡。"
        />
      </div>
    </DashboardShell>
  )
}
