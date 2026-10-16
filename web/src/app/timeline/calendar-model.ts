import type { StudentTodo } from '@/app/dashboard/student/_todo/todos'
import type { Activity } from '@/application/cohorts'
import { taipeiDateOf, taipeiTimeOf, type TaipeiDate } from '@/shared/time'

/**
 * 前台「專題時程」的月曆資料（學生規格 §3.7，ST-6；產品模組 08「站內日曆」）。純函式：伺服器算好、client 只排版。
 *
 * 來源只有兩個，**不另外存**：
 * - 屆別活動（`TimelineQuery.activities`）：學生看不到對象「只給老師」的（NTF-13）；老師／系辦看得到。
 *   取消的**仍列在原日期**、標「已取消」、灰色（COH-03）；改期的只出現在新日期——同一個活動只有一筆（NTF-03）。
 * - 學生自己的作業截止：ST-1 的 `itemTodo` 算好的 `due`（補交期限優先）與狀態，這裡只換成標籤，不另推口徑。
 *   老師／系辦視角不列截止（Q125：A 只列階段與活動）。
 *
 * 日期一律是**臺灣日曆日**：凌晨 00:30 的事在 UTC 是前一天，瀏覽器自己換會差一天。
 * 月格也只用 UTC 方法算那串日期本身，不碰瀏覽器時區。
 */

export type CalendarTone = 'deadline' | 'event' | 'canceled'

export type CalendarEntry = {
  readonly id: string
  /** 臺灣日曆日 `YYYY-MM-DD`。 */
  readonly date: TaipeiDate
  /** 臺灣時間 `HH:mm`；全天的活動是「全天」。 */
  readonly time: string
  readonly title: string
  readonly kind: 'deadline' | 'event'
  readonly canceled: boolean
  /** 右欄清單的狀態標籤：逾期／已交／截止／活動／已取消。 */
  readonly label: string
  readonly tone: CalendarTone
  /** 截止點下去去作業那一份；活動沒有自己的頁面是 null。 */
  readonly href: string | null
}

/** 截止的來源：ST-1 待辦的子集（`due` 已是補交期限優先）。 */
export type DeadlineSource = Pick<StudentTodo, 'id' | 'title' | 'due' | 'status' | 'href'>

export type Perspective = 'student' | 'staff'

/** 月份：`m` 是 1–12。 */
export type YearMonth = { readonly y: number; readonly m: number }

function deadlineLabel(status: StudentTodo['status']): string {
  if (status === 'overdue') return '逾期'
  // 免繳跟已交放在同一類（Q119：免繳在「已交」篩選）。
  if (status === 'done' || status === 'exempt') return '已交'
  return '截止'
}

/** 同一個活動只留一筆：來源萬一給了同一個 id 的多個版本，留 revision 最新的。 */
function latestRevisions(activities: readonly Activity[]): Activity[] {
  const byId = new Map<string, Activity>()
  for (const a of activities) {
    const seen = byId.get(a.id)
    if (!seen || a.revision > seen.revision) byId.set(a.id, a)
  }
  return [...byId.values()]
}

export function calendarEntries(
  activities: readonly Activity[],
  deadlines: readonly DeadlineSource[],
  perspective: Perspective,
): CalendarEntry[] {
  const events: CalendarEntry[] = latestRevisions(activities)
    .filter((a) => perspective === 'staff' || a.audienceKind !== 'teachers')
    .map((a) => {
      const canceled = a.status === 'cancelled'
      return {
        id: `event-${a.id}`,
        date: taipeiDateOf(a.startsAt),
        time: a.allDay ? '全天' : taipeiTimeOf(a.startsAt),
        title: a.title,
        kind: 'event' as const,
        canceled,
        label: canceled ? '已取消' : '活動',
        tone: canceled ? ('canceled' as const) : ('event' as const),
        href: null,
      }
    })
  const dues: CalendarEntry[] =
    perspective === 'staff'
      ? []
      : deadlines.flatMap((d) =>
          d.due
            ? [
                {
                  id: `due-${d.id}`,
                  date: taipeiDateOf(d.due),
                  time: taipeiTimeOf(d.due),
                  title: d.title,
                  kind: 'deadline' as const,
                  canceled: false,
                  label: deadlineLabel(d.status),
                  tone: 'deadline' as const,
                  href: d.href,
                },
              ]
            : [],
        )
  // 同一天：全天的排最前，其餘照時間。
  const key = (e: CalendarEntry) => `${e.date} ${e.time === '全天' ? '00:00' : e.time}`
  return [...events, ...dues].sort((a, b) => key(a).localeCompare(key(b)))
}

export function entriesByDay(entries: readonly CalendarEntry[]): Map<TaipeiDate, CalendarEntry[]> {
  const byDay = new Map<TaipeiDate, CalendarEntry[]>()
  for (const e of entries) byDay.set(e.date, [...(byDay.get(e.date) ?? []), e])
  return byDay
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0')

export function monthPrefix({ y, m }: YearMonth): string {
  return `${pad(y, 4)}-${pad(m)}-`
}

export function entriesInMonth(entries: readonly CalendarEntry[], month: YearMonth): CalendarEntry[] {
  const prefix = monthPrefix(month)
  return entries.filter((e) => e.date.startsWith(prefix))
}

/** 整月格（週一開頭）：月初前補 null，其餘是那天的 `YYYY-MM-DD`。 */
export function monthCells(month: YearMonth): (TaipeiDate | null)[] {
  const offset = (new Date(Date.UTC(month.y, month.m - 1, 1)).getUTCDay() + 6) % 7
  const days = new Date(Date.UTC(month.y, month.m, 0)).getUTCDate()
  const prefix = monthPrefix(month)
  return [...Array.from({ length: offset }, () => null), ...Array.from({ length: days }, (_, i) => `${prefix}${pad(i + 1)}`)]
}

export function shiftMonth({ y, m }: YearMonth, delta: number): YearMonth {
  const index = y * 12 + (m - 1) + delta
  return { y: Math.floor(index / 12), m: (index % 12) + 1 }
}

export function monthOf(date: TaipeiDate): YearMonth {
  const [y, m] = date.split('-').map(Number) as [number, number]
  return { y, m }
}
