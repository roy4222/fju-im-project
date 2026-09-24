import { requireRole } from '@/app/_ui/guard'
import { StageBanner } from '@/app/dashboard/_stage'
import { DashboardShell } from '@/app/_ui/site-shell'
import { EmptyState, PageHeader, Tile } from '@/app/_ui/primitives'
import { TEACHER_NAV } from '@/app/dashboard/_nav'
import { getGroupQuery } from '@/composition/groups'

export const metadata = { title: '老師首頁｜資管系專題平台' }

export default async function TeacherHomePage() {
  // 授權檢查在**頁面自己**：放在 layout 擋不住，App Router 會把 layout 與 page 並行渲染，
  // layout 丟掉 children 或 redirect 都來不及——那一頁已經被做出來、跟著 payload 送走了。
  const actor = await requireRole('/dashboard/teacher', 'teacher')
  const advised = actor.kind === 'authenticated' ? await getGroupQuery().advisedGroupCount(actor.userId) : 0

  return (
    <DashboardShell roleLabel="老師" items={TEACHER_NAV} current="/dashboard/teacher">
      <PageHeader title="老師首頁" description="指導的組別、要評分的項目與待簽核都會出現在這裡。" />
      <StageBanner actor={actor} perspective="staff" />
      <div className="grid gap-4 sm:grid-cols-2">
        <Tile label="指導中的組別" value={String(advised)} hint="產學組可到「分組」認領；一般組由系辦指派" href="/dashboard/teacher/groups" />
        <Tile label="待評分" value="—" hint="評分功能開放後會顯示" />
      </div>
      <div className="mt-6">
        <EmptyState
          pending
          title="其他老師功能還沒做"
          description="組別繳交、評分與簽核會陸續開放，開放後會出現在這裡。"
        />
      </div>
    </DashboardShell>
  )
}
