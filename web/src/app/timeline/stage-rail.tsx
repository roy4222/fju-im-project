import type { TimelineView } from '@/application/cohorts'
import { cn } from '@/shared/cn'
import { formatTaipeiDate, type TaipeiDate } from '@/shared/time'

const STATUS_TEXT = { done: '已過', current: '現在', upcoming: '還沒到' } as const

/**
 * 階段軌（學生規格 §3.7，ST-6）：本屆四段一字排開，目前那段有「現在」旗標與「還有 N 天」，每段下面一句階段說明。
 *
 * 只講時間（跟首頁「現在階段」同一個判定 `timelineView`），不講誰做完了什麼。
 * 位置全部用 class，不寫 inline style（CSP）。
 */
export function StageRail({ view }: { view: TimelineView }) {
  const md = (d: TaipeiDate) => formatTaipeiDate(d).slice(5)
  return (
    <ol aria-label="本屆階段" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {view.stages.map((stage) => {
        const current = stage.status === 'current'
        return (
          <li
            key={stage.seq}
            aria-current={current ? 'step' : undefined}
            className={cn(
              'flex flex-col gap-2 rounded-2xl border p-4',
              current ? 'border-ink bg-[oklch(0.96_0.02_253)]' : 'border-border bg-card',
              stage.status === 'done' && 'opacity-70',
            )}
          >
            <div className={cn('h-1.5 rounded-full', current ? 'bg-ink' : stage.status === 'done' ? 'bg-ink/40' : 'bg-muted')} aria-hidden />
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-bold text-muted-foreground tabular-nums">階段 {stage.seq}</span>
              {current ? (
                <span className="rounded-md bg-ink px-1.5 py-0.5 text-[10px] font-bold text-ink-foreground">現在</span>
              ) : (
                <span className="text-[11px] text-muted-foreground">{STATUS_TEXT[stage.status]}</span>
              )}
            </div>
            <p className="text-base font-extrabold text-foreground">{stage.name}</p>
            <p className="text-xs text-muted-foreground tabular-nums">
              {md(stage.startDate)} – {md(stage.lastDate)}
              {current && view.current ? <span className="ml-2 font-bold text-ink">還有 {view.current.daysLeft} 天</span> : null}
            </p>
            {stage.description ? <p className="text-[13px] leading-relaxed text-foreground/80">{stage.description}</p> : null}
          </li>
        )
      })}
    </ol>
  )
}
