import { itemTodo } from '@/app/dashboard/student/_todo/todos'
import type { MyItemRow } from '@/application/submissions'
import { taipeiDateOf } from '@/shared/time'

/**
 * 組別頁「里程碑」線（學生規格 §3.6，已定 Q120）：建立組別 → 成組 → 每件整組一份的作業依截止日排。
 * 第一格的字照規格③ §1 用詞叫「建立組別」（C3-11）。
 * 已完成打勾寫日期（`M/D`），還沒到的上鎖寫月份（`N 月`）。
 *
 * 作業「送出了沒」用待辦的口徑（`itemTodo` 的 `done`，ST-1），不自己判；免繳的作業不是這一組要做的事，不列。
 */

export type Milestone = {
  key: string
  label: string
  done: boolean
  /** 已完成：完成那天 `M/D`；還沒到：截止月份 `N 月`；沒有截止日：「未定」。 */
  when: string
}

function monthDay(instant: Date): string {
  const [, m, d] = taipeiDateOf(instant).split('-').map(Number) as [number, number, number]
  return `${m}/${d}`
}

function month(instant: Date): string {
  return `${Number(taipeiDateOf(instant).split('-')[1])} 月`
}

export function groupMilestones(input: {
  /** 成組的那份提案的發起時間；系辦直接建的組、或後來才被加進組的人沒有這份提案，是 null（那格不列）。 */
  proposedAt: Date | null
  establishedAt: Date
  rows: readonly MyItemRow[]
  now: Date
}): readonly Milestone[] {
  const out: Milestone[] = []
  if (input.proposedAt) out.push({ key: 'proposed', label: '建立組別', done: true, when: monthDay(input.proposedAt) })
  out.push({ key: 'established', label: '成組', done: true, when: monthDay(input.establishedAt) })
  const items = input.rows
    .filter((row) => row.receiverUnit === 'group' && !row.exempt)
    .sort((a, b) => (a.dueAt?.getTime() ?? Infinity) - (b.dueAt?.getTime() ?? Infinity) || a.title.localeCompare(b.title, 'zh-Hant'))
  for (const row of items) {
    const done = itemTodo(row, input.now).status === 'done' && row.latestReceivedAt !== null
    out.push({
      key: row.itemId,
      label: row.title,
      done,
      when: done ? monthDay(row.latestReceivedAt!) : row.dueAt ? month(row.dueAt) : '未定',
    })
  }
  return out
}
