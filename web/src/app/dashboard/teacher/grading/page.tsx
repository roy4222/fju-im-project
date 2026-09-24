import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { EmptyState, PageHeader } from '@/app/_ui/primitives'
import { TEACHER_NAV } from '@/app/dashboard/_nav'
import { GradingQueue } from '@/app/dashboard/teacher/grading/queue'
import { getGradingQuery } from '@/composition/grading'

export const metadata = { title: '評分工作台｜資管系專題平台' }

/**
 * 老師「評分工作台」入口（票 23；原型 `/dashboard/teacher/grading`）：只列本人被指派的組別與階段。
 * 誰是本人由登入者決定；別的老師的指派、暫存一律看不到。點一組進評閱桌 `/dashboard/teacher/grading/<組別>`。
 */
export default async function TeacherGradingPage() {
  // 授權檢查在**頁面自己**：放在 layout 擋不住（見 `_nav.ts` 與 `guard.ts` 的說明）。
  const actor = await requireRole('/dashboard/teacher/grading', 'teacher')
  const queue = await getGradingQuery().teacherQueue(actor)
  const pending = queue.filter((e) => e.state !== 'counted').length

  return (
    <DashboardShell roleLabel="老師" items={TEACHER_NAV} current="/dashboard/teacher/grading">
      <PageHeader title="評分工作台" description="只有你被指派的組別。暫存只有你和系辦看得到，正式送出後鎖定。" />
      {queue.length === 0 ? (
        <EmptyState title="目前沒有評分指派" description="系辦指派你評某一組之後，你會收到通知，組別也會出現在這裡。" />
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground tabular-nums">
            共 {queue.length} 份評分，{pending} 份還沒正式送出。
          </p>
          <div className="max-w-xl">
            <GradingQueue entries={queue} currentGroupId={null} />
          </div>
        </div>
      )}
    </DashboardShell>
  )
}
