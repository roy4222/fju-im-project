'use client'
import Link from 'next/link'
import { useState } from 'react'
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react'
import {
  entriesByDay,
  entriesInMonth,
  monthCells,
  monthOf,
  shiftMonth,
  type CalendarEntry,
  type CalendarTone,
  type Perspective,
  type YearMonth,
} from '@/app/timeline/calendar-model'
import { cn } from '@/shared/cn'
import type { TaipeiDate } from '@/shared/time'

/**
 * 整月行事曆（學生規格 §3.7，ST-6）：左邊月格、右邊「M 月」清單；點某一天，右欄上方多出「這天的行程」。
 *
 * 資料全部由伺服器算好（`calendar-model.ts`），這裡不打 API、只排版。
 * 定位名沿用舊首頁月曆（`acc149-x3` 的 `calendarDay` helper 只改 goto）：`student-calendar`、`YYYY 年 M 月`、
 * 「上個月」「下個月」、日期按鈕名以 `YYYY-MM-DD` 開頭、`list 這天的行程`。
 */

const WEEK = ['一', '二', '三', '四', '五', '六', '日']
const DOT: Record<CalendarTone, string> = { deadline: 'bg-primary', event: 'bg-ink', canceled: 'bg-muted-foreground/50' }
const TAG: Record<string, string> = {
  截止: 'bg-primary-subtle text-primary-on-subtle',
  逾期: 'bg-destructive/10 text-destructive',
  已交: 'bg-muted text-muted-foreground',
  活動: 'bg-[oklch(0.93_0.03_253)] text-ink',
  已取消: 'bg-muted text-muted-foreground',
}

function EntryRow({ entry, withDate }: { entry: CalendarEntry; withDate: boolean }) {
  const [, m, d] = entry.date.split('-').map(Number)
  const body = (
    <>
      {withDate ? <span className="w-10 shrink-0 text-[13px] font-bold text-foreground tabular-nums">{`${m}/${d}`}</span> : null}
      <span className={cn('shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-bold', TAG[entry.label] ?? TAG['截止'])}>{entry.label}</span>
      <span className={cn('min-w-0 flex-1 truncate font-medium text-foreground', entry.canceled && 'text-muted-foreground line-through')}>
        {entry.title}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{entry.time}</span>
    </>
  )
  const className = 'flex min-h-10 items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm'
  return entry.href ? (
    <Link href={entry.href} className={cn(className, 'transition-colors hover:bg-accent/60')}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  )
}

/** 老師／系辦視角沒有截止資料（Q125），圖例也不列「截止」。 */
export function FullCalendar({
  entries,
  today,
  perspective,
}: {
  entries: readonly CalendarEntry[]
  today: TaipeiDate
  perspective: Perspective
}) {
  const [view, setView] = useState<YearMonth>(() => monthOf(today))
  const [picked, setPicked] = useState<TaipeiDate | null>(null)

  const go = (delta: number) => {
    setView((v) => shiftMonth(v, delta))
    setPicked(null)
  }
  const byDay = entriesByDay(entries)
  const inMonth = entriesInMonth(entries, view)
  const dayEntries = picked ? (byDay.get(picked) ?? []) : []
  const monthName = `${view.m} 月`

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]" data-testid="student-calendar">
      <section aria-label="月曆" className="rounded-2xl border border-border bg-card p-4">
        <div className="flex items-center justify-between pb-2">
          <button
            type="button"
            onClick={() => go(-1)}
            className="inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="上個月"
          >
            <IconChevronLeft className="size-5" aria-hidden />
          </button>
          <span className="text-lg font-extrabold text-foreground tabular-nums" aria-live="polite">
            {view.y} 年 {view.m} 月
          </span>
          <button
            type="button"
            onClick={() => go(1)}
            className="inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="下個月"
          >
            <IconChevronRight className="size-5" aria-hidden />
          </button>
        </div>
        <div className="grid grid-cols-7 text-center text-xs font-semibold text-muted-foreground" aria-hidden>
          {WEEK.map((w) => (
            <span key={w} className="py-1.5">
              {w}
            </span>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-1">
          {monthCells(view).map((key, i) => {
            if (key === null) return <span key={`e${i}`} />
            const evs = byDay.get(key) ?? []
            const isToday = key === today
            const isPicked = key === picked
            const day = Number(key.slice(8))
            return (
              <button
                key={key}
                type="button"
                onClick={() => setPicked(key)}
                aria-label={`${key}${evs.length ? `，${evs.length} 件` : ''}`}
                aria-pressed={isPicked}
                className={cn(
                  'flex min-h-14 flex-col items-center justify-start gap-1 rounded-xl py-1.5 text-sm text-foreground transition-colors sm:min-h-16',
                  isPicked ? 'bg-ink font-bold text-ink-foreground' : isToday ? 'bg-primary-subtle font-bold text-primary-on-subtle' : 'hover:bg-accent',
                )}
              >
                <span className="leading-none tabular-nums">{day}</span>
                <span className="flex h-1.5 gap-0.5">
                  {evs.slice(0, 4).map((e) => (
                    <span key={e.id} data-tone={e.tone} className={cn('size-1.5 rounded-full', isPicked ? 'bg-ink-foreground' : DOT[e.tone])} />
                  ))}
                </span>
              </button>
            )
          })}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-4 border-t border-border/70 pt-3 text-xs text-muted-foreground">
          {perspective === 'student' ? (
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-primary" />
              截止
            </span>
          ) : null}
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-ink" />
            活動
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-[oklch(0.62_0.16_300)]" />
            競賽
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-muted-foreground/50" />
            已取消
          </span>
          <span className="ml-auto">臺灣時間</span>
        </div>
      </section>

      <div className="flex min-w-0 flex-col gap-5">
        {picked ? (
          <section aria-label="這一天" className="rounded-2xl border border-border bg-card p-4">
            <h2 className="text-sm font-bold text-foreground tabular-nums">
              {Number(picked.slice(5, 7))} 月 {Number(picked.slice(8))} 日{picked === today ? '・今天' : ''}
            </h2>
            {dayEntries.length === 0 ? (
              <p className="mt-1.5 text-sm text-muted-foreground">這天沒有截止或活動。</p>
            ) : (
              <ul className="mt-1.5 flex flex-col gap-0.5" aria-label="這天的行程">
                {dayEntries.map((e) => (
                  <li key={e.id}>
                    <EntryRow entry={e} withDate={false} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}

        <section aria-label={`${monthName}的行程`} className="rounded-2xl border border-border bg-card p-4">
          <h2 className="text-sm font-bold text-foreground">{monthName}</h2>
          {inMonth.length === 0 ? (
            <p className="mt-1.5 text-sm text-muted-foreground">這個月沒有截止或活動。</p>
          ) : (
            <ul className="mt-1.5 flex flex-col gap-0.5" aria-label={monthName}>
              {inMonth.map((e) => (
                <li key={e.id}>
                  <EntryRow entry={e} withDate />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
