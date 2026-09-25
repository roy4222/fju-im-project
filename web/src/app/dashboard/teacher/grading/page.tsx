import { IconChecklist } from '@tabler/icons-react'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { TEACHER_NAV } from '@/app/dashboard/_nav'
import { PageTitle, Panel, PanelEmpty } from '@/app/dashboard/teacher/_ui/dash'
import { GradingQueue } from '@/app/dashboard/teacher/grading/queue'
import { getGradingQuery } from '@/composition/grading'

export const metadata = { title: '評分工作台｜資管系專題平台' }

/**
 * 老師「評分工作台」入口（票 23；票 37 照原型 `/dashboard/teacher/grading` 的版型）：只列本人被指派的組別與階段。
 * 誰是本人由登入者決定；別的老師的指派、暫存一律看不到。點一組進評閱桌 `/dashboard/teacher/grading/<組別>`。
 *
 * 原型一進來就導到佇列第一組；正式碼保留這一頁當「待評清單」（左邊佇列、右邊提示選一組），不自動導走。
 */
export default async function TeacherGradingPage() {
  // 授權檢查在**頁面自己**：放在 layout 擋不住（見 `_nav.ts` 與 `guard.ts` 的說明）。
  const actor = await requireRole('/dashboard/teacher/grading', 'teacher')
  const queue = await getGradingQuery().teacherQueue(actor)
  const pending = queue.filter((e) => e.state !== 'counted').length

  return (
    <DashboardShell roleLabel="老師" items={TEACHER_NAV} current="/dashboard/teacher/grading">
      <div className="flex flex-col gap-5">
        <PageTitle title="評分工作台" description="只有你被指派的組別。暫存只有你和系辦看得到，正式送出後鎖定。" />
        {queue.length === 0 ? (
          <Panel title="評分佇列" icon={<IconChecklist />}>
            <PanelEmpty icon={<IconChecklist />} title="目前沒有評分指派" hint="系辦指派你評某一組之後，你會收到通知，組別也會出現在這裡。" />
          </Panel>
        ) : (
          <div className="grid items-start gap-4 lg:grid-cols-[17rem_minmax(0,1fr)]">
            <GradingQueue
              entries={queue}
              current={null}
              heading={{ title: '我的評分', detail: `共 ${queue.length} 份・${pending} 份還沒正式送出` }}
            />
            <div className="dash-card hidden lg:block">
              <PanelEmpty icon={<IconChecklist />} title="從左邊選一組開始評分" hint="暫存可以沒填完；每一項都填好、檢查過再正式送出，送出後鎖定。" />
            </div>
          </div>
        )}
      </div>
    </DashboardShell>
  )
}
