import type { MyDeadline } from '@/application/items'
import { isDeadlinePassed, taipeiDateOf, taipeiDayStart } from '@/shared/time'

const DAY_MS = 86_400_000

/** 倒數顏色（原型 `WorkStrip`）：10 天內橘、其他灰。 */
export type DeadlineTone = 'soon' | 'later'

export type HomeDeadline = MyDeadline & {
  /** 距離截止日還有幾個臺灣日曆日（今天 0、明天 1）。 */
  readonly days: number
  readonly tone: DeadlineTone
  /** 倒數字：剩 N 天／今天截止（原型 `formatDue`）。 */
  readonly countdown: string
}

/**
 * 首頁「近期截止」三筆：只列**還沒過**的截止，近的在前。
 *
 * 逾期的不列（Roy 2026-09-08：過期的自動不再出現在首頁；原型 `listUpcoming` 同）。
 * `docs/FRONTEND-PAGES.md:60` 的「逾期紅」與這個決定不一致，待文件同步時修正。
 */
export function homeDeadlines(deadlines: readonly MyDeadline[], now: Date, take = 3): HomeDeadline[] {
  const today = taipeiDayStart(taipeiDateOf(now)).getTime()
  return deadlines
    .filter((d) => !isDeadlinePassed(now, d.dueAt))
    .sort((x, y) => x.dueAt.getTime() - y.dueAt.getTime())
    .slice(0, take)
    .map((d) => {
      const days = Math.round((taipeiDayStart(taipeiDateOf(d.dueAt)).getTime() - today) / DAY_MS)
      return { ...d, days, tone: days <= 10 ? 'soon' : 'later', countdown: days === 0 ? '今天截止' : `剩 ${days} 天` }
    })
}
