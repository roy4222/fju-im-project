import Link from 'next/link'
import { IconLock } from '@tabler/icons-react'
import type { TeacherQueueEntry } from '@/application/grading'
import { cn } from '@/shared/cn'

/**
 * 評分佇列：本人被指派的組別與階段（票 23；票 37 照原型評分工作台左側的組別清單）。
 * 只由伺服器元件用，資料來自 `teacherQueue(actor)`。
 */

function State({ e }: { e: TeacherQueueEntry }) {
  if (e.state === 'counted') {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-[11px] font-semibold text-success-on-subtle">
        <IconLock className="size-3.5" />
        已送出
      </span>
    )
  }
  if (e.returned) return <span className="shrink-0 text-[11px] font-semibold text-destructive">已退回</span>
  if (e.state === 'draft') {
    return (
      <span className="tabular shrink-0 text-[11px] font-semibold text-muted-foreground">
        草稿 {e.filled}/{e.total}
      </span>
    )
  }
  return <span className="shrink-0 text-[11px] text-muted-foreground">未開始</span>
}

export function GradingQueue({
  entries,
  current,
  heading,
}: {
  entries: readonly TeacherQueueEntry[]
  /** 目前打開的那一份（組別＋階段）；在清單頁是 null。 */
  current: { groupId: string; stageKey: string } | null
  heading: { title: string; detail: string }
}) {
  return (
    <div className="dash-card overflow-hidden">
      <div className="border-b border-border px-4 py-3">
        <p className="text-sm font-bold text-ink">{heading.title}</p>
        <p className="tabular text-xs text-muted-foreground">{heading.detail}</p>
      </div>
      <ul aria-label="評分佇列" className="py-2">
        {entries.map((e) => {
          const active = current !== null && e.groupId === current.groupId && e.stageKey === current.stageKey
          return (
            <li key={e.assignmentId}>
              <Link
                href={`/dashboard/teacher/grading/${e.groupId}?stage=${e.stageKey}`}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex min-h-11 items-center gap-3 border-l-[3px] py-2 pr-3 pl-3 transition-colors duration-150',
                  active ? 'border-primary bg-accent/60' : 'border-transparent hover:bg-accent/50',
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="tabular block text-[11px] text-muted-foreground">
                    {e.cohortCode}・{e.stageName}
                  </span>
                  <span className={cn('block truncate text-sm', active ? 'font-bold text-ink' : 'font-semibold text-foreground')}>{e.groupCode}</span>
                </span>
                <State e={e} />
              </Link>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
