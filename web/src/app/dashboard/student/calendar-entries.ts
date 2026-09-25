import type { CalendarEntry } from '@/app/dashboard/student/_calendar'
import type { Activity } from '@/application/cohorts'
import type { MyDeadline } from '@/application/items'
import { taipeiDateOf, taipeiTimeOf } from '@/shared/time'

/**
 * 學生行事曆的資料（票 16；產品模組 08「站內日曆」、02「作業截止由收件項目衍生，活動由系辦另外加」）。
 *
 * 來源只有兩個，**不另外存**：
 * - 屆別活動（票 11 的 `project_events`）：學生看得到的受眾（本屆學生、所有登入者、公開），不含「只給老師」；
 *   取消的也列出來、標「已取消」（產品 08：取消要有清楚狀態）。
 * - 收件截止（票 15 的收件項目）：只有本人或本人所在組別在目前名單上的（`PublicItemQuery.myDeadlines`）。
 *
 * 日期一律換成**臺灣日曆日**再交給瀏覽器：凌晨 00:30 的截止在 UTC 是前一天，瀏覽器自己換會差一天。
 */
export function calendarEntries(activities: readonly Activity[], deadlines: readonly MyDeadline[]): CalendarEntry[] {
  const events: CalendarEntry[] = activities
    .filter((a) => a.audienceKind !== 'teachers')
    .map((a) => ({
      id: `event-${a.id}`,
      date: taipeiDateOf(a.startsAt),
      time: a.allDay ? '全天' : taipeiTimeOf(a.startsAt),
      title: a.title,
      kind: 'event' as const,
      cancelled: a.status === 'cancelled',
      href: null,
    }))
  const dues: CalendarEntry[] = deadlines.map((d) => ({
    id: `due-${d.itemId}`,
    date: taipeiDateOf(d.dueAt),
    time: taipeiTimeOf(d.dueAt),
    title: `${d.title} 截止`,
    kind: 'deadline' as const,
    cancelled: false,
    // 截止點下去就是作業區那一份（個人與組別收件都在作業區，票 21）。
    href: `/dashboard/student/affairs/${d.itemId}`,
  }))
  // 同一天：全天的排最前，其餘照時間。
  const key = (e: CalendarEntry) => `${e.date} ${e.time === '全天' ? '00:00' : e.time}`
  return [...events, ...dues].sort((a, b) => key(a).localeCompare(key(b)))
}

/** 「接下來」：今天（含）以後、沒取消的，最多 `limit` 筆。 */
export function upcoming(entries: readonly CalendarEntry[], today: string, limit = 5): CalendarEntry[] {
  return entries.filter((e) => e.date >= today && !e.cancelled).slice(0, limit)
}
