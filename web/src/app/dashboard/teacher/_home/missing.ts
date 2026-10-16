import type { AdvisorMatrix } from '@/application/submissions'
import { categoryOf, receiverStatus } from '@/composition/submissions'

export type MissingGroup = {
  readonly groupId: string
  readonly code: string
  /** 缺的收件標題，照矩陣欄的順序。 */
  readonly titles: readonly string[]
}

/**
 * 老師首頁「缺件的組」（老師規格 §4.1、§7；D1 2026-10-16 Roy 定案）：**截止已過、還沒有正式送出**的整組收件。
 *
 * 口徑跟作業區各組繳交總表同一個 `receiverStatus` 的「逾期未繳」：只算目前名單上（不是免填、沒移出）的格子；
 * 系辦替這一組開了個別補交、期限還沒到，這一組的截止就是延後了，不算缺件；沒有截止時間的收件永遠不算。
 * 矩陣的欄是老師所有指導屆別的聯集，所以只看跟這一組同屆的收件。D1 要改只改這個函式。
 */
export function missingSubmissions(matrix: AdvisorMatrix | null, businessNow: Date): MissingGroup[] {
  if (!matrix) return []
  const cellOf = new Map(matrix.cells.map((c) => [`${c.groupId}:${c.itemId}`, c]))
  return matrix.groups.flatMap((group) => {
    const titles = matrix.items
      .filter((item) => {
        const cell = item.cohortId === group.cohortId ? cellOf.get(`${group.groupId}:${item.itemId}`) : undefined
        if (!cell || categoryOf(cell) !== 'current') return false
        const facts = { exempt: cell.exempt, hasDraft: false, latestVersionNo: cell.latestVersionNo, reopenUntil: cell.reopenUntil }
        return receiverStatus(item, facts, businessNow).overdue
      })
      .map((item) => item.title)
    return titles.length > 0 ? [{ groupId: group.groupId, code: group.code, titles }] : []
  })
}
