import type { Classifiable, GradingFilter, GradingStatus } from '@/app/dashboard/teacher/grading/overview-types'

/**
 * 評分總覽的篩選與上一組／下一組（TE-06a；TE-06b 的單組頁也用 `neighbours`）。都是純函式，不碰資料庫。
 */

/**
 * 一份指派屬於哪個篩選：被系辦退回、還沒重新送出的歸「待評」（就算已經有新草稿）；
 * 其餘照最新一筆評分列：沒有是待評、草稿是草稿、採計是已送出。
 */
export function gradingStatusOf(e: Classifiable): GradingStatus {
  if (e.returned) return 'pending'
  if (e.state === 'counted') return 'submitted'
  if (e.state === 'draft') return 'draft'
  return 'pending'
}

export function filterQueue<T extends Classifiable>(entries: readonly T[], filter: GradingFilter): T[] {
  if (filter === 'all') return [...entries]
  return entries.filter((e) => gradingStatusOf(e) === filter)
}

const FILTERS: readonly GradingFilter[] = ['all', 'pending', 'draft', 'submitted']

/** 網址的 `?filter=`；不認得的值（含重複帶兩次）當「全部」。 */
export function parseFilter(raw: string | readonly string[] | undefined): GradingFilter {
  return typeof raw === 'string' && (FILTERS as readonly string[]).includes(raw) ? (raw as GradingFilter) : 'all'
}

/**
 * 總覽要顯示哪個階段：網址指定且本人有這個階段的指派就用它；否則第一個還有沒送出的階段，
 * 全部送出了就第一個階段。沒有任何指派是 null。
 */
export function pickStage<T extends Classifiable & { readonly stageKey: string }>(
  entries: readonly T[],
  wanted: string | readonly string[] | undefined,
): string | null {
  if (typeof wanted === 'string' && entries.some((e) => e.stageKey === wanted)) return wanted
  return (entries.find((e) => gradingStatusOf(e) !== 'submitted') ?? entries[0])?.stageKey ?? null
}

/** 清單裡某一組的上一組與下一組（照清單順序、不繞回頭）；不在清單裡兩邊都是 null。 */
export function neighbours<T extends { readonly groupId: string }>(
  entries: readonly T[],
  groupId: string,
): { prev: T | null; next: T | null } {
  const i = entries.findIndex((e) => e.groupId === groupId)
  if (i < 0) return { prev: null, next: null }
  return { prev: entries[i - 1] ?? null, next: entries[i + 1] ?? null }
}
