import Link from 'next/link'
import type { TeacherQueueEntry } from '@/application/grading'
import { cn } from '@/shared/cn'

/** 評分佇列：本人被指派的組別與階段（原型左側清單）。只由伺服器元件用，資料來自 `teacherQueue(actor)`。 */

function stateText(e: TeacherQueueEntry): string {
  if (e.state === 'counted') return '已送出'
  if (e.returned) return '已退回'
  if (e.state === 'draft') return `暫存 ${e.filled}/${e.total}`
  return '未開始'
}

export function GradingQueue({ entries, currentGroupId }: { entries: readonly TeacherQueueEntry[]; currentGroupId: string | null }) {
  return (
    <ul aria-label="評分佇列" className="divide-y divide-border rounded-card border border-border bg-background">
      {entries.map((e) => {
        const active = e.groupId === currentGroupId
        return (
          <li key={e.assignmentId}>
            <Link
              href={`/dashboard/teacher/grading/${e.groupId}?stage=${e.stageKey}`}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex min-h-11 items-center gap-3 border-l-[3px] px-3 py-2 hover:bg-muted',
                active ? 'border-primary bg-primary-subtle/40' : 'border-transparent',
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="block text-xs text-muted-foreground">
                  {e.cohortCode}・{e.stageName}
                </span>
                <span className={cn('block text-sm', active ? 'font-semibold text-primary' : 'font-medium text-ink')}>{e.groupCode}</span>
              </span>
              <span
                className={cn(
                  'text-xs tabular-nums',
                  e.state === 'counted' ? 'font-semibold text-ink' : 'text-muted-foreground',
                )}
              >
                {stateText(e)}
              </span>
            </Link>
          </li>
        )
      })}
    </ul>
  )
}
