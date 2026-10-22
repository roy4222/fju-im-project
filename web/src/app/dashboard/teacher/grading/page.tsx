import { IconChecklist } from '@tabler/icons-react'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { loadTeacherWorkload } from '@/app/_ui/workload'
import { TEACHER_NAV } from '@/app/dashboard/_nav'
import { PageTitle, Panel, PanelEmpty, SegmentBar } from '@/app/dashboard/teacher/_ui/dash'
import { filterQueue, parseFilter } from '@/app/dashboard/teacher/grading/filter'
import { GradingOverviewList } from '@/app/dashboard/teacher/grading/overview-list'

export const metadata = { title: '評分｜資管系專題平台' }

/**
 * 老師「評分」總覽（票 23、37；TE-06a 照 Q78 重做）：只列本人被指派的組別。
 * 誰是本人由登入者決定；別的老師的指派、暫存一律看不到。點一張卡進單組評分 `/dashboard/teacher/grading/<組別>`。
 *
 * 待評清單讀共用 `loadTeacherWorkload(userId).queue`（TE-06c，`_ui/workload.ts`）：側欄徽章讀的是同一份，
 * 同一請求只查一次（AC-SH-37）。C1-12：每個評分項目一個區段（`stage-sections.tsx`），附件欄讀隊列的 `linkedItem`
 * （C1-04 同一句帶回），不另外查；分區、篩選、已評幾組都在記憶體算（設計方案 §5：頁面自己 ≤ 3 句）。
 */
export default async function TeacherGradingPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string | string[] }>
}) {
  // 授權檢查在**頁面自己**：放在 layout 擋不住（見 `_nav.ts` 與 `guard.ts` 的說明）。
  const actor = await requireRole('/dashboard/teacher/grading', 'teacher')
  const [{ queue }, search] = await Promise.all([loadTeacherWorkload(actor.userId), searchParams])

  const entries = queue
  // 進度條算全部評分項目；各評分項目的「已評 N／M 組」在區段標題。
  const done = filterQueue(entries, 'submitted').length
  const drafts = filterQueue(entries, 'draft').length

  return (
    <DashboardShell roleLabel="老師" items={TEACHER_NAV} current="/dashboard/teacher/grading">
      <div className="flex flex-col gap-5">
        <PageTitle
          title="評分"
          description={<p>草稿只有你和系辦看得到。</p>}
        />
        {entries.length === 0 ? (
          <Panel title="評分清單" icon={<IconChecklist />}>
            <PanelEmpty icon={<IconChecklist />} title="目前沒有你的評分指派。" hint="系辦指派你評某一組之後，你會收到通知，組別也會出現在這裡。" />
          </Panel>
        ) : (
          <>
            <div className="max-w-md">
              <SegmentBar
                segments={[
                  { value: done, color: 'var(--success)', label: '已送出' },
                  { value: drafts, color: 'var(--primary)', label: '草稿' },
                  { value: entries.length - done - drafts, color: 'var(--border)', label: '待評' },
                ]}
              />
            </div>
            <GradingOverviewList entries={entries} filter={parseFilter(search.filter)} />
          </>
        )}
      </div>
    </DashboardShell>
  )
}
