'use client'
import Link from 'next/link'
import { useState } from 'react'
import { IconChevronDown, IconChevronLeft, IconChevronRight } from '@tabler/icons-react'
import { cn } from '@/shared/cn'

/**
 * 專題行事曆（票 16；照原型學生首頁的 MiniCalendar 版型搬，2026-09-25 再對齊一次；產品模組 08「站內日曆」）。
 *
 * 資料全部由伺服器算好：日期是**臺灣日曆日**（`YYYY-MM-DD`）、時間是臺灣的 `HH:mm`，這裡只負責排成月曆。
 * 月曆的日期運算一律用 UTC 方法算那串日期本身，不碰瀏覽器的時區——人在國外看也不會差一天。
 * 手機寬度預設縮成「近期三筆」，按「展開整月」才出現月曆（原型 compactOnMobile）。
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
  /** 點下去去哪（截止＝作業區那一份）；活動沒有自己的頁面是 null。 */
  readonly href: string | null
}

const WEEK = ['一', '二', '三', '四', '五', '六', '日']
const KIND_LABEL: Record<CalendarEntry['kind'], string> = { deadline: '截止', event: '活動' }
const DOT: Record<CalendarEntry['kind'], string> = { deadline: 'bg-primary', event: 'bg-ink' }
const TINT: Record<CalendarEntry['kind'], string> = {
  deadline: 'bg-primary-subtle text-primary-on-subtle',
  event: 'bg-[oklch(0.93_0.03_253)] text-ink',
}

function ymd(year: number, monthIndex: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function daysFrom(today: string, date: string): number {
  const utc = (s: string) => {
    const [y, m, d] = s.split('-').map(Number) as [number, number, number]
    return Date.UTC(y, m - 1, d)
  }
  return Math.round((utc(date) - utc(today)) / 86_400_000)
}

/** 有連結就是連結，沒有就是一般的列。 */
function EntryLink({ href, className, children }: { href: string | null; className: string; children: React.ReactNode }) {
  return href ? (
    <Link href={href} className={cn(className, 'transition-colors hover:bg-accent/60')}>
      {children}
    </Link>
  ) : (
    <div className={className}>{children}</div>
  )
}

export function StudentCalendar({ entries, today }: { entries: readonly CalendarEntry[]; today: string }) {
  const [year0, month0] = today.split('-').map(Number) as [number, number]
  const [view, setView] = useState({ y: year0, m: month0 - 1 })
  const [picked, setPicked] = useState(today)
  const [expanded, setExpanded] = useState(false)

  const first = new Date(Date.UTC(view.y, view.m, 1))
  const offset = (first.getUTCDay() + 6) % 7 // 週一開頭
  const days = new Date(Date.UTC(view.y, view.m + 1, 0)).getUTCDate()
  const cells: (number | null)[] = [...Array.from({ length: offset }, () => null), ...Array.from({ length: days }, (_, i) => i + 1)]
  const byDay = new Map<string, CalendarEntry[]>()
  for (const e of entries) byDay.set(e.date, [...(byDay.get(e.date) ?? []), e])
  const dayEntries = byDay.get(picked) ?? []
  const [, pm, pd] = picked.split('-').map(Number)
  const soon = entries.filter((e) => e.date >= today && !e.cancelled).slice(0, 3)

  return (
    <div className="flex flex-col" data-testid="student-calendar">
      {/* 手機：近期三筆＋展開整月 */}
      <div className="md:hidden">
        {!expanded ? (
          soon.length === 0 ? (
            <p className="px-5 pt-1 text-sm text-muted-foreground">最近沒有截止或活動。</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border/70 px-5 pt-1">
              {soon.map((e) => {
                const d = daysFrom(today, e.date)
                return (
                  <li key={e.id}>
                    <EntryLink href={e.href} className="flex min-h-11 items-center gap-3 py-2 text-sm">
                      <span className="w-12 shrink-0 text-[13px] font-bold text-foreground tabular-nums">{e.date.slice(5).replace('-', '/')}</span>
                      <span className="min-w-0 flex-1 truncate font-medium text-foreground">{e.title}</span>
                      <span className={cn('shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-bold', TINT[e.kind])}>{d === 0 ? '今天' : `${d} 天`}</span>
                    </EntryLink>
                  </li>
                )
              })}
            </ul>
          )
        ) : null}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="flex h-11 w-full items-center justify-center gap-1 text-[13px] font-semibold text-foreground transition-colors hover:bg-accent/60"
        >
          {expanded ? '收合成近期三筆' : '展開整月'}
          <IconChevronDown className={cn('size-4 transition-transform', expanded && 'rotate-180')} aria-hidden />
        </button>
      </div>

      <div className={cn('flex flex-col', !expanded && 'max-md:hidden')}>
        <div className="flex items-center justify-between px-4 pt-1 pb-1">
          <button
            type="button"
            onClick={() => setView((v) => (v.m === 0 ? { y: v.y - 1, m: 11 } : { y: v.y, m: v.m - 1 }))}
            className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="上個月"
          >
            <IconChevronLeft className="size-4" aria-hidden />
          </button>
          <span className="text-sm font-bold text-foreground tabular-nums" aria-live="polite">
            {view.y} 年 {view.m + 1} 月
          </span>
          <button
            type="button"
            onClick={() => setView((v) => (v.m === 11 ? { y: v.y + 1, m: 0 } : { y: v.y, m: v.m + 1 }))}
            className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="下個月"
          >
            <IconChevronRight className="size-4" aria-hidden />
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
                  'mx-auto flex h-8 w-8 flex-col items-center justify-center rounded-full text-[13px] text-foreground transition-colors',
                  isPicked ? 'bg-ink font-bold text-ink-foreground' : isToday ? 'bg-primary-subtle font-bold text-primary-on-subtle' : 'hover:bg-accent',
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
        <div className="border-t border-border/70 px-4 py-3">
          <p className="text-xs font-bold text-muted-foreground tabular-nums">
            {pm} 月 {pd} 日{picked === today ? '・今天' : ''}
          </p>
          {dayEntries.length === 0 ? (
            <p className="mt-1 text-sm text-muted-foreground">這天沒有截止或活動。</p>
          ) : (
            <ul className="mt-1.5 flex flex-col gap-1.5" aria-label="這天的行程">
              {dayEntries.map((e) => (
                <li key={e.id}>
                  <EntryLink href={e.href} className="flex items-center gap-2.5 rounded-lg px-1 py-1 text-sm">
                    <span className={cn('shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-bold', TINT[e.kind])}>{KIND_LABEL[e.kind]}</span>
                    <span className={cn('min-w-0 flex-1 truncate font-medium text-foreground', e.cancelled && 'text-muted-foreground line-through')}>
                      {e.title}
                    </span>
                    {e.cancelled ? <span className="shrink-0 text-xs text-muted-foreground">已取消</span> : null}
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{e.time}</span>
                  </EntryLink>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex items-center gap-3 border-t border-border/70 px-4 py-2.5 text-[11px] text-muted-foreground">
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
    </div>
  )
}
