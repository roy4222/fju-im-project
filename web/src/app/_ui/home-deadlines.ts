import type { MyDeadline } from '@/application/items'
import { isDeadlinePassed, taipeiDateOf, taipeiDayStart } from '@/shared/time'

const DAY_MS = 86_400_000

/** 倒數顏色（原型 `WorkStrip`；前台頁面清單「逾期紅、10 天內橘」）。 */
export type DeadlineTone = 'overdue' | 'soon' | 'later'

export type HomeDeadline = MyDeadline & {
  readonly overdue: boolean
  /** 距離截止日還有幾個臺灣日曆日（今天 0、明天 1、昨天 -1）。 */
  readonly days: number
  readonly tone: DeadlineTone
  /** 倒數字：剩 N 天／今天截止／今天已截止／逾期 N 天（原型 `formatDue`）。 */
  readonly countdown: string
}

/**
 * 首頁「近期截止」三筆（前台頁面清單：逾期標紅、10 天內橘）。
 *
 * 還沒到的截止照列；**已經過了的只留還沒交的**（`overdueItemIds`：跟作業區「逾期未繳」同一個判斷），
 * 交過、免填的逾期項目不再佔位。依截止時間排，逾期的自然在最前面（最急）。
 */
export function homeDeadlines(
  deadlines: readonly MyDeadline[],
  overdueItemIds: ReadonlySet<string>,
  now: Date,
  take = 3,
): HomeDeadline[] {
  const today = taipeiDayStart(taipeiDateOf(now)).getTime()
  return deadlines
    .map((d) => {
      const overdue = isDeadlinePassed(now, d.dueAt)
      const days = Math.round((taipeiDayStart(taipeiDateOf(d.dueAt)).getTime() - today) / DAY_MS)
      const tone: DeadlineTone = overdue ? 'overdue' : days <= 10 ? 'soon' : 'later'
      const countdown = overdue ? (days < 0 ? `逾期 ${-days} 天` : '今天已截止') : days === 0 ? '今天截止' : `剩 ${days} 天`
      return { ...d, overdue, days, tone, countdown }
    })
    .filter((d) => !d.overdue || overdueItemIds.has(d.itemId))
    .sort((x, y) => x.dueAt.getTime() - y.dueAt.getTime())
    .slice(0, take)
}
