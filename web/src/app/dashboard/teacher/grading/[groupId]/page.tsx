import Link from 'next/link'
import { requireRole } from '@/app/_ui/guard'
import { DashboardShell } from '@/app/_ui/site-shell'
import { EmptyState, PageHeader } from '@/app/_ui/primitives'
import { TEACHER_NAV } from '@/app/dashboard/_nav'
import { GradingBench } from '@/app/dashboard/teacher/grading/grading-bench'
import { GradingQueue } from '@/app/dashboard/teacher/grading/queue'
import { getGradingQuery } from '@/composition/grading'
import { cn } from '@/shared/cn'
import { formatTaipeiMinute, formatTaipeiSecond } from '@/shared/time'

export const metadata = { title: '評閱桌｜資管系專題平台' }

/**
 * 老師的評閱桌（票 23；原型 `/dashboard/teacher/grading/[groupId]`）：左邊是本人的評分佇列，右邊是這一組的評分表。
 *
 * 只給**本人在這一組的有效指派**：沒有被指派（或指派已結束）就只顯示「你沒有被指派評這一組」，
 * 不透露這一組的任何評分資料。同一組被指派多個階段時，用上方的階段切換。
 */
export default async function TeacherGradingGroupPage({
  params,
  searchParams,
}: {
  params: Promise<{ groupId: string }>
  searchParams: Promise<{ stage?: string | string[] }>
}) {
  const { groupId } = await params
  const actor = await requireRole(`/dashboard/teacher/grading/${groupId}`, 'teacher')
  const [bench, queue] = await Promise.all([getGradingQuery().teacherBench(actor, groupId), getGradingQuery().teacherQueue(actor)])

  const shell = (children: React.ReactNode) => (
    <DashboardShell roleLabel="老師" items={TEACHER_NAV} current="/dashboard/teacher/grading">
      <PageHeader title="評分工作台" description="只有你被指派的組別。暫存只有你和系辦看得到，正式送出後鎖定。" />
      {children}
    </DashboardShell>
  )

  if (!bench.ok) {
    return shell(
      <EmptyState
        title="你沒有被指派評這一組"
        description={bench.message}
        action={{ href: '/dashboard/teacher/grading', label: '回評分工作台' }}
      />,
    )
  }

  const { entries, groupCode, cohortCode, memberNames, versionNo } = bench.receipt
  const wanted = (await searchParams).stage
  const entry = entries.find((e) => e.stage.key === wanted) ?? entries[0]!

  return shell(
    <div className="grid items-start gap-4 lg:grid-cols-[17rem_minmax(0,1fr)]">
      <aside className="hidden lg:block">
        <GradingQueue entries={queue} currentGroupId={groupId} />
      </aside>
      <div className="space-y-3">
        <Link href="/dashboard/teacher/grading" className="text-sm font-medium text-primary underline-offset-2 hover:underline lg:hidden">
          ← 全部評分指派
        </Link>
        <div>
          <p className="text-xs font-semibold text-muted-foreground tabular-nums">
            {cohortCode}・評分方案 v{versionNo}
          </p>
          <h2 className="text-lg font-semibold text-primary">{groupCode}</h2>
          <p className="text-xs text-muted-foreground">{memberNames.join('、')}</p>
        </div>
        {entries.length > 1 ? (
          <nav aria-label="選擇階段" className="flex flex-wrap gap-2">
            {entries.map((e) => (
              <Link
                key={e.assignmentId}
                href={`/dashboard/teacher/grading/${groupId}?stage=${e.stage.key}`}
                aria-current={e.assignmentId === entry.assignmentId ? 'page' : undefined}
                className={cn(
                  'rounded-full border px-3 py-1 text-sm',
                  e.assignmentId === entry.assignmentId
                    ? 'border-primary bg-primary-subtle text-primary-on-subtle'
                    : 'border-border text-ink hover:bg-muted',
                )}
              >
                {e.stage.name}
              </Link>
            ))}
          </nav>
        ) : null}
        <GradingBench
          key={entry.assignmentId}
          assignmentId={entry.assignmentId}
          groupCode={groupCode}
          stage={entry.stage}
          initialScores={entry.scores}
          locked={entry.state === 'counted'}
          savedAtText={entry.savedAt ? formatTaipeiMinute(entry.savedAt) : null}
          finalScore={entry.finalScore}
          submittedAtText={entry.submittedAt ? formatTaipeiSecond(entry.submittedAt) : null}
          draftFromOlderVersion={entry.draftFromOlderVersion}
        />
      </div>
    </div>,
  )
}
