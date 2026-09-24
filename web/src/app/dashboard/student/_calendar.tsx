'use client'
import { useState } from 'react'
import { cn } from '@/shared/cn'

/**
 * 專題行事曆（票 16；照原型學生首頁的 MiniCalendar 版型搬；產品模組 08「站內日曆」）。
 *
 * 資料全部由伺服器算好：日期是**臺灣日曆日**（`YYYY-MM-DD`）、時間是臺灣的 `HH:mm`，這裡只負責排成月曆。
 * 月曆的日期運算一律用 UTC 方法算那串日期本身，不碰瀏覽器的時區——人在國外看也不會差一天。
 *
 * 本輪不做「訂閱到 Google 日曆」（產品 08：外部日曆延後）；活動由系辦在「時間軸」頁維護，這裡不放新增按鈕。
 */

export type CalendarEntry = {
  readonly id: string
  /** 臺灣日曆日 `YYYY-MM-DD`。 */
  readonly date: string
  /** 臺灣時間 `HH:mm`；全天的活動是「全天」。 */
  readonly time: string
  readonly title: string
  readonly kind: 'deadline' | 'event'
  readonly cancelled: boolean
}

const WEEK = ['一', '二', '三', '四', '五', '六', '日']
const KIND_LABEL: Record<CalendarEntry['kind'], string> = { deadline: '截止', event: '活動' }
const DOT: Record<CalendarEntry['kind'], string> = { deadline: 'bg-primary', event: 'bg-ink' }
const TINT: Record<CalendarEntry['kind'], string> = {
  deadline: 'bg-primary-subtle text-primary-on-subtle',
  event: 'bg-muted text-ink',
}

function ymd(year: number, monthIndex: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export function StudentCalendar({ entries, today }: { entries: readonly CalendarEntry[]; today: string }) {
  const [year0, month0] = today.split('-').map(Number) as [number, number]
  const [view, setView] = useState({ y: year0, m: month0 - 1 })
  const [picked, setPicked] = useState(today)

  const first = new Date(Date.UTC(view.y, view.m, 1))
  const offset = (first.getUTCDay() + 6) % 7 // 週一開頭
  const days = new Date(Date.UTC(view.y, view.m + 1, 0)).getUTCDate()
  const cells: (number | null)[] = [...Array.from({ length: offset }, () => null), ...Array.from({ length: days }, (_, i) => i + 1)]
  const byDay = new Map<string, CalendarEntry[]>()
  for (const e of entries) byDay.set(e.date, [...(byDay.get(e.date) ?? []), e])
  const dayEntries = byDay.get(picked) ?? []
  const [, pm, pd] = picked.split('-').map(Number)

  return (
    <div className="flex flex-col" data-testid="student-calendar">
      <div className="flex items-center justify-between px-4 pt-3 pb-1">
        <button
          type="button"
          onClick={() => setView((v) => (v.m === 0 ? { y: v.y - 1, m: 11 } : { y: v.y, m: v.m - 1 }))}
          className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-ink"
          aria-label="上個月"
        >
          ‹
        </button>
        <span className="text-sm font-semibold text-ink tabular-nums" aria-live="polite">
          {view.y} 年 {view.m + 1} 月
        </span>
        <button
          type="button"
          onClick={() => setView((v) => (v.m === 11 ? { y: v.y + 1, m: 0 } : { y: v.y, m: v.m + 1 }))}
          className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-ink"
          aria-label="下個月"
        >
          ›
        </button>
      </div>
      <div className="grid grid-cols-7 px-3 text-center text-[11px] font-semibold text-muted-foreground" aria-hidden>
        {WEEK.map((w) => (
          <span key={w} className="py-1">
            {w}
          </span>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-y-0.5 px-3 pb-2">
        {cells.map((d, i) => {
          if (d === null) return <span key={`e${i}`} />
          const key = ymd(view.y, view.m, d)
          const evs = byDay.get(key) ?? []
          const isToday = key === today
          const isPicked = key === picked
          return (
            <button
              key={key}
              type="button"
              onClick={() => setPicked(key)}
              aria-label={`${key}${evs.length ? `，${evs.length} 件` : ''}`}
              aria-pressed={isPicked}
              className={cn(
                'mx-auto flex h-9 w-9 flex-col items-center justify-center rounded-full text-[13px] transition-colors',
                isPicked ? 'bg-ink font-semibold text-ink-foreground' : isToday ? 'bg-primary-subtle font-semibold text-primary-on-subtle' : 'hover:bg-muted',
              )}
            >
              <span className="leading-none tabular-nums">{d}</span>
              <span className="mt-0.5 flex h-1 gap-0.5">
                {evs.slice(0, 3).map((e) => (
                  <span key={e.id} className={cn('size-1 rounded-full', isPicked ? 'bg-ink-foreground' : DOT[e.kind], e.cancelled && 'opacity-40')} />
                ))}
              </span>
            </button>
          )
        })}
      </div>
      <div className="border-t border-border px-4 py-3">
        <p className="text-xs font-semibold text-muted-foreground tabular-nums">
          {pm} 月 {pd} 日{picked === today ? '・今天' : ''}
        </p>
        {dayEntries.length === 0 ? (
          <p className="mt-1 text-sm text-muted-foreground">這天沒有截止或活動。</p>
        ) : (
          <ul className="mt-1.5 flex flex-col gap-1.5" aria-label="這天的行程">
            {dayEntries.map((e) => (
              <li key={e.id} className="flex items-center gap-2.5 text-sm">
                <span className={cn('shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold', TINT[e.kind])}>{KIND_LABEL[e.kind]}</span>
                <span className={cn('min-w-0 flex-1 truncate font-medium text-ink', e.cancelled && 'text-muted-foreground line-through')}>
                  {e.title}
                </span>
                {e.cancelled ? <span className="shrink-0 text-xs text-muted-foreground">已取消</span> : null}
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{e.time}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex items-center gap-3 border-t border-border px-4 py-2.5 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <span className="size-1.5 rounded-full bg-primary" />
          截止
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="size-1.5 rounded-full bg-ink" />
          活動
        </span>
        <span className="ml-auto">臺灣時間</span>
      </div>
    </div>
  )
}
