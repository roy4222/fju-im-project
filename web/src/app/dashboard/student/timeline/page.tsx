import { requireRole } from '@/app/_ui/guard'
import { PageTitle } from '@/app/_ui/dashboard-primitives'
import { EmptyState } from '@/app/_ui/primitives'
import { DashboardShell } from '@/app/_ui/site-shell'
import { STUDENT_NAV } from '@/app/dashboard/_nav'
import { TimelineZigzag, type TimelineStageView, type TimelineSummary } from '@/app/dashboard/_timeline/timeline-zigzag'
import { tasksOfStage } from '@/app/dashboard/student/timeline/stage-tasks'
import { getBusinessClock, getTimelineQuery, timelineView } from '@/composition/cohorts'
import { getSubmissionQuery, receiverStatus } from '@/composition/submissions'
import { formatTaipeiDate, formatTaipeiMinute, taipeiDateOf, type TaipeiDate } from '@/shared/time'

export const metadata = { title: '專題時間軸｜資管系專題平台' }

const PATH = '/dashboard/student/timeline'

/**
 * 學生「專題時間軸」（票 38；原型 `/dashboard/student/timeline`，樣式是畫布 B「直立蛇形」）。
 *
 * 只講時間：本屆每個階段的日期、現在在哪一段、這一段的時間過了幾成；每一段展開是**自己**在那個階段的收件
 * （作業區同一份資料、同一個狀態口徑），做完了沒看實際繳交，跟階段日期分開（進入期中≠已交期中報告）。
 *
 * 看哪一屆：只看登入學生自己所屬的那一屆（`TimelineQuery.studentSchedule`，屆別由登入者推，網址帶不進來）。
 * 唯讀：階段與日期由系辦在「時間軸」設定。
 */
export default async function StudentTimelinePage() {
  // 授權檢查在**頁面自己**：放在 layout 擋不住（見 `_nav.ts` 與 `guard.ts` 的說明）。
  const actor = await requireRole(PATH, 'student')
  const userId = actor.kind === 'authenticated' ? actor.userId : ''

  const [mine, businessNow, items] = await Promise.all([
    getTimelineQuery().studentSchedule(actor),
    getBusinessClock().now(),
    getSubmissionQuery().myItems(userId),
  ])

  const shell = (description: string, children: React.ReactNode) => (
    <DashboardShell roleLabel="學生" items={STUDENT_NAV} current={PATH}>
      <div className="flex flex-col gap-5">
        <PageTitle title="專題時間軸" description={description} />
        {children}
        <p className="text-xs text-muted-foreground">階段與日期由系辦在時間軸設定，全屆一致；做完了沒看作業區的實際繳交。</p>
      </div>
    </DashboardShell>
  )

  if (!mine) {
    return shell(
      '本屆每個階段的日期與你在各階段要交的東西。',
      <EmptyState title="你還沒有歸屬的屆別" description="帳號核准並歸到某一屆之後，這裡會顯示那一屆的階段與日期。" />,
    )
  }

  const view = timelineView(mine.schedule, businessNow)
  if (!view) {
    return shell(
      `${mine.cohortCode}・還沒有設定階段`,
      <EmptyState title="本屆還沒有設定階段" description="系辦在時間軸設定好各階段的開始日與年度結束日後，這裡會顯示完整的時間軸。" />,
    )
  }

  const today = taipeiDateOf(businessNow)
  const thisYear = today.slice(0, 4)
  const md = (d: TaipeiDate) => formatTaipeiDate(d).slice(5)
  // 同一個西元年只寫月日；跨年或不在今年就寫完整年月日（原型 `range`）。
  const range = (from: TaipeiDate, to: TaipeiDate) =>
    from.slice(0, 4) === thisYear && to.slice(0, 4) === thisYear
      ? `${md(from)} – ${md(to)}`
      : `${formatTaipeiDate(from)} – ${formatTaipeiDate(to)}`

  // 每件收件的狀態跟作業區同一個函式；做完＝已正式送出（或系辦設為免填）。
  // 用階段身分（屆別＋序號）分，不用名稱：同一屆可以有兩段同名。
  const tasks = items.map((row) => ({ row, status: receiverStatus(row, row, businessNow) }))
  const tasksOf = (seq: number) =>
    tasksOfStage(
      tasks.map((t) => ({ ...t, cohortId: t.row.cohortId, stageSeq: t.row.stageSeq })),
      mine.cohortId,
      seq,
    )
  const stages: TimelineStageView[] = view.stages.map((stage) => {
    const mineInStage = tasksOf(stage.seq)
    const firstOpen = mineInStage.find(({ status }) => status.pending)
    return {
      id: String(stage.seq),
      title: stage.name,
      rangeText: range(stage.startDate, stage.lastDate),
      status: stage.status,
      tasks: mineInStage.map(({ row, status }) => ({
        label: row.title,
        href: `/dashboard/student/affairs/${row.itemId}`,
        done: status.submitted || row.exempt,
        dueText: row.dueAt ? formatTaipeiMinute(row.dueAt).slice(5, 10) : undefined,
      })),
      action: firstOpen ? { href: `/dashboard/student/affairs/${firstOpen.row.itemId}`, label: firstOpen.status.action } : undefined,
    }
  })

  const cur = view.stages.find((s) => s.status === 'current')
  const first = view.stages[0]!
  const summary: TimelineSummary = cur
    ? {
        label: '目前',
        title: cur.name,
        rangeText: range(cur.startDate, cur.lastDate),
        progressText: view.current ? `時間已過 ${view.current.elapsedPercent}%・剩 ${view.current.daysLeft} 天` : undefined,
      }
    : view.stages.every((s) => s.status === 'done')
      ? { label: '目前', title: '年度階段已結束', rangeText: `${formatTaipeiDate(mine.schedule.yearEndDate!)} 結束` }
      : { label: '目前', title: '尚未開始', rangeText: `第 1 階段 ${formatTaipeiDate(first.startDate)} 開始` }

  // 摘要列的主要按鈕：目前階段第一件還沒交的（原型「前往確認組員」這類下一步）。
  const primaryTask = cur ? tasksOf(cur.seq).find(({ status }) => status.pending) : undefined
  const done = view.stages.filter((s) => s.status === 'done').length

  return shell(
    `${mine.cohortCode}・${view.stages.length} 個階段，已過 ${done} 個`,
    <TimelineZigzag
      stages={stages}
      summary={summary}
      primary={primaryTask ? { href: `/dashboard/student/affairs/${primaryTask.row.itemId}`, label: primaryTask.row.title } : null}
    />,
  )
}
