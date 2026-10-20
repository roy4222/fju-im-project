import type { StudentTodo } from '@/app/dashboard/student/_todo/todos'
import type { GanttActivity, GanttDeadline } from '@/app/dashboard/_timeline/gantt/gantt-model'
import type { Activity, ActivityAudience } from '@/application/cohorts'
import type { ItemListRow } from '@/application/items'
import { addTaipeiDays, formatTaipeiDate, taipeiDateOf, taipeiTimeOf, type TaipeiDate } from '@/shared/time'

/**
 * 前台「專題時程」看得到哪些活動與截止（規格③ §9.5；從舊 `calendar-model.ts` 搬來）。純函式：伺服器算好，
 * 甘特（電腦版）與清單（電腦、手機都有）吃同一份。
 *
 * 來源只有兩個，**不另外存**：
 * - 屆別活動（`TimelineQuery.activities`）：學生看不到對象「只給老師」的（NTF-13）；老師／系辦看得到。
 *   同一個活動只有一筆（NTF-03）：來源萬一給了同一個 id 的多個版本，留 revision 最新的。
 *   取消的甘特不畫（甘特自己濾），清單裡劃掉、標「已取消」。
 * - 作業截止：學生是自己的（ST-1 `itemTodo` 算好的 `due`，補交期限優先）；老師／系辦是該屆已發布作業的「學生截止」
 *   （Q125 B 案、B15；來源 `staffDeadlines`）。
 *
 * 日期一律是**臺灣日曆日**：凌晨 00:30 的事在 UTC 是前一天，瀏覽器自己換會差一天。
 * app 對 application 只能帶型別（母 spec §4.3），所以活動時間的字樣與對象名稱由頁面從 composition 傳進來（`EntryFormat`）。
 */

export type Perspective = 'student' | 'staff'

/** 截止的來源：ST-1 待辦的子集（`due` 已是補交期限優先）。 */
export type DeadlineSource = Pick<StudentTodo, 'id' | 'title' | 'due' | 'status' | 'href'>

export type StaffDeadlineRow = Pick<ItemListRow, 'id' | 'title' | 'status' | 'dueAt'>

/**
 * 老師／系辦視角的學生截止（B15）：`ItemQuery.list(cohortId)` 裡已發布、有截止日的那幾篇。
 * 不是哪個學生的進度，狀態一律當「未到」；連到後台的列表頁（兩頁都沒有單篇錨點）。
 */
export function staffDeadlines(rows: readonly StaffDeadlineRow[], href: string): DeadlineSource[] {
  return rows.flatMap((r) => (r.status === 'published' && r.dueAt ? [{ id: r.id, title: r.title, due: r.dueAt, status: 'open' as const, href }] : []))
}

/** 這個身分看得到的活動：同 id 留 revision 最新的一版；學生不含「只給老師」。順序照開始時間。 */
export function visibleActivities(activities: readonly Activity[], perspective: Perspective): Activity[] {
  const byId = new Map<string, Activity>()
  for (const a of activities) {
    const seen = byId.get(a.id)
    if (!seen || a.revision > seen.revision) byId.set(a.id, a)
  }
  return [...byId.values()]
    .filter((a) => perspective === 'staff' || a.audienceKind !== 'teachers')
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
}

/** 活動佔的臺灣日期（含結束日），同 application 的 `activitySpan`：全天的 `endsAt` 是次日 00:00，所以往回一天。 */
function span(a: Pick<Activity, 'startsAt' | 'endsAt' | 'allDay'>): { startDate: TaipeiDate; endDate: TaipeiDate } {
  const startDate = taipeiDateOf(a.startsAt)
  if (!a.endsAt) return { startDate, endDate: startDate }
  const endDate = a.allDay ? addTaipeiDays(taipeiDateOf(a.endsAt), -1) : taipeiDateOf(a.endsAt)
  return { startDate, endDate: endDate < startDate ? startDate : endDate }
}

/** 甘特的活動：起訖是臺灣日期（含結束日）；有時間的帶「09:00」或「09:00–17:00」。 */
export function ganttActivity(a: Activity): GanttActivity {
  const { startDate, endDate } = span(a)
  const startTime = a.allDay ? null : taipeiTimeOf(a.startsAt)
  const endTime = a.allDay || !a.endsAt ? null : taipeiTimeOf(a.endsAt)
  return {
    id: a.id,
    title: a.title,
    startDate,
    endDate,
    allDay: a.allDay,
    startTime,
    endTime,
    timeText: startTime ? (endTime ? `${startTime}–${endTime}` : startTime) : null,
    audienceKind: a.audienceKind,
    status: a.status,
    revision: a.revision,
  }
}

export function ganttDeadlines(deadlines: readonly DeadlineSource[]): GanttDeadline[] {
  return deadlines.flatMap((d) => (d.due ? [{ id: d.id, title: d.title, date: taipeiDateOf(d.due), href: d.href }] : []))
}

/** 清單的一列：活動或截止。 */
export type TimelineEntry = {
  /** 活動是 `activity-<id>`（甘特橫條連過來的錨點）；截止是 `due-<id>`。 */
  readonly anchor: string
  readonly kind: 'activity' | 'deadline'
  /** 臺灣日期，分月份與排序用。 */
  readonly date: TaipeiDate
  readonly sortKey: string
  /** 畫面上的時間：活動照 `EntryFormat.when`（單日、跨日、全天），截止是「2026-08-26 23:59」。 */
  readonly when: string
  readonly title: string
  readonly description: string | null
  /** 活動的對象（「本屆學生」…）；截止沒有。 */
  readonly audience: string | null
  /** 活動／已取消／截止／逾期／已交／學生截止。 */
  readonly label: string
  readonly canceled: boolean
  /** 截止點下去去作業那一份；活動是 null。 */
  readonly href: string | null
}

function deadlineLabel(status: StudentTodo['status'], perspective: Perspective): string {
  if (perspective === 'staff') return '學生截止'
  if (status === 'overdue') return '逾期'
  // 免繳跟已交放在同一類（Q119：免繳在「已交」篩選）。
  if (status === 'done' || status === 'exempt') return '已交'
  return '截止'
}

/** 頁面從 composition 傳進來的字樣：`formatActivityWhen` 與 `ACTIVITY_AUDIENCE_LABEL`。 */
export type EntryFormat = {
  readonly when: (a: Activity) => string
  readonly audience: (kind: ActivityAudience) => string
}

/** 清單：看得到的活動（含已取消）＋截止，照開始時間排；同一天全天的排最前。 */
export function timelineEntries(
  activities: readonly Activity[],
  deadlines: readonly DeadlineSource[],
  perspective: Perspective,
  format: EntryFormat,
): TimelineEntry[] {
  const events = visibleActivities(activities, perspective).map((a): TimelineEntry => {
    const date = taipeiDateOf(a.startsAt)
    const canceled = a.status === 'cancelled'
    return {
      anchor: `activity-${a.id}`,
      kind: 'activity',
      date,
      sortKey: `${date} ${a.allDay ? '00:00' : taipeiTimeOf(a.startsAt)}`,
      when: format.when(a),
      title: a.title,
      description: a.description,
      audience: format.audience(a.audienceKind),
      label: canceled ? '已取消' : '活動',
      canceled,
      href: null,
    }
  })
  const dues = deadlines.flatMap((d): TimelineEntry[] => {
    if (!d.due) return []
    const date = taipeiDateOf(d.due)
    const time = taipeiTimeOf(d.due)
    return [
      {
        anchor: `due-${d.id}`,
        kind: 'deadline',
        date,
        sortKey: `${date} ${time}`,
        when: `${formatTaipeiDate(date)} ${time}`,
        title: d.title,
        description: null,
        audience: null,
        label: deadlineLabel(d.status, perspective),
        canceled: false,
        href: d.href,
      },
    ]
  })
  return [...events, ...dues].sort((a, b) => a.sortKey.localeCompare(b.sortKey))
}

export type MonthGroup = { readonly key: string; readonly label: string; readonly entries: readonly TimelineEntry[] }

/** 依月份分組（「10 月」「11 月」…）；同一個月份出現在兩個年份（清單超過一年）時，每組都帶年份免得分不清。 */
export function entriesByMonth(entries: readonly TimelineEntry[]): MonthGroup[] {
  const groups = new Map<string, TimelineEntry[]>()
  for (const e of entries) {
    const key = e.date.slice(0, 7)
    groups.set(key, [...(groups.get(key) ?? []), e])
  }
  const keys = [...groups.keys()]
  const withYear = new Set(keys.map((k) => k.slice(5))).size < keys.length
  return keys.map((key) => {
    const [y, m] = key.split('-').map(Number) as [number, number]
    return { key, label: withYear ? `${y} 年 ${m} 月` : `${m} 月`, entries: groups.get(key)! }
  })
}
