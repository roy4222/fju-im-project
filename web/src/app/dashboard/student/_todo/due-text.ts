import type { StudentTodo } from '@/app/dashboard/student/_todo/todos'
import { taipeiDateOf, taipeiDayStart } from '@/shared/time'

const DAY_MS = 86_400_000

/** 截止日距離今天幾個臺灣日曆日（今天 0、明天 1、昨天 −1）；「今天」用業務鐘。 */
export function daysLeft(due: Date, now: Date): number {
  return Math.round((taipeiDayStart(taipeiDateOf(due)).getTime() - taipeiDayStart(taipeiDateOf(now)).getTime()) / DAY_MS)
}

/** 臺灣日期的 `M/D`（`8/26`，不補零）。 */
function monthDay(instant: Date): string {
  const [, m, d] = taipeiDateOf(instant).split('-').map(Number) as [number, number, number]
  return `${m}/${d}`
}

/**
 * 待辦卡與首頁「下一件要交的」的截止字（學生規格 §3.1；原型 `dueText` 合成一句）：
 * 沒有截止日／補交到 M/D／M/D 截止（已交、免繳）／逾期 N 天／今天截止／M/D 截止・剩 N 天。
 *
 * 逾期但截止日就是今天（剛過截止分鐘）寫「今天已截止」，不寫「逾期 0 天」（驗收第 2 章 P-07，同 `due-hint.ts`）。
 */
export function dueText(todo: Pick<StudentTodo, 'due' | 'status' | 'late'>, now: Date): string {
  const { due } = todo
  if (!due) return '沒有截止日'
  if (todo.late) return `補交到 ${monthDay(due)}`
  if (todo.status === 'done' || todo.status === 'exempt') return `${monthDay(due)} 截止`
  const d = daysLeft(due, now)
  if (todo.status === 'overdue') return d >= 0 ? '今天已截止' : `逾期 ${-d} 天`
  if (d === 0) return '今天截止'
  if (d < 0) return `${monthDay(due)} 截止`
  return `${monthDay(due)} 截止・剩 ${d} 天`
}
