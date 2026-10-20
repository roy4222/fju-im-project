import Link from 'next/link'
import { entriesByMonth, type TimelineEntry } from '@/app/timeline/activity-visibility'
import { cn } from '@/shared/cn'

const TONE: Record<TimelineEntry['kind'] | 'canceled', string> = {
  activity: 'bg-[oklch(0.94_0.04_253)] text-ink',
  deadline: 'bg-[oklch(0.95_0.05_60)] text-[oklch(0.42_0.12_50)]',
  canceled: 'bg-muted text-muted-foreground',
}

/**
 * 前台 `/timeline` 的活動清單（規格③ §9.5）：電腦版在甘特下方、手機版只有它。依月份分組（「10 月」「11 月」…），
 * 每列是日期範圍、名稱、對象、說明；已取消的劃掉、標「已取消」。截止也列在裡面（手機沒有甘特的菱形）。
 *
 * 活動列的 `id` 是 `activity-<id>`：甘特橫條是連到這裡的錨點。Server Component，不進 client 打包。
 */
export function ActivityList({ entries }: { entries: readonly TimelineEntry[] }) {
  const groups = entriesByMonth(entries)
  return (
    <section aria-labelledby="timeline-activity-list" className="flex flex-col gap-4">
      <h2 id="timeline-activity-list" className="text-lg font-extrabold text-foreground">
        活動清單
      </h2>
      {groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">目前沒有活動或截止。</p>
      ) : (
        groups.map((group) => (
          <section key={group.key} aria-labelledby={`timeline-month-${group.key}`} className="flex flex-col gap-2">
            <h3 id={`timeline-month-${group.key}`} className="text-sm font-bold text-muted-foreground">
              {group.label}
            </h3>
            <ul aria-label={group.label} className="flex flex-col divide-y divide-border rounded-2xl border border-border bg-card">
              {group.entries.map((e) => (
                <li key={e.anchor} id={e.anchor} className="flex scroll-mt-24 flex-col gap-1 px-4 py-3 target:bg-[oklch(0.97_0.02_253)] sm:flex-row sm:gap-4">
                  <p className="shrink-0 text-xs text-muted-foreground tabular-nums sm:w-52 sm:pt-0.5">{e.when}</p>
                  <div className="flex min-w-0 flex-col gap-1">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className={cn('rounded-md px-1.5 py-0.5 text-[11px] font-bold', TONE[e.canceled ? 'canceled' : e.kind])}>{e.label}</span>
                      {e.href ? (
                        <Link href={e.href} className="font-bold text-foreground underline-offset-4 hover:underline">
                          {e.title}
                        </Link>
                      ) : (
                        <span className={cn('font-bold text-foreground', e.canceled && 'text-muted-foreground line-through')}>{e.title}</span>
                      )}
                      {e.audience ? <span className="text-xs text-muted-foreground">{e.audience}</span> : null}
                    </p>
                    {e.description ? <p className={cn('text-[13px] leading-relaxed text-foreground/80', e.canceled && 'line-through')}>{e.description}</p> : null}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </section>
  )
}
