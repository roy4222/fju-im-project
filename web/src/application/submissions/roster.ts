import { phaseOf, statusOf, type ItemStatusView, type Phase } from '@/application/submissions/submissions'

/**
 * 收件名單的分類與完成率（票 18；產品模組 05 §4「個人填報與收件名單」的分子分母、免填、移出）。
 *
 * 沒有資料庫也沒有框架：名單列怎麼分三類、完成率怎麼算、每一列顯示什麼狀態，都可以單獨測。
 *
 * - **目前名單**：還在名單上（沒有結束時間）而且不是免填。完成率的分母＝這一類的數量。
 * - **免填**：還在名單上但設了免填。不算分母，也不算已完成。
 * - **已移出**：名單列已經有結束時間（移出原因與時間）。不算分母也不算分子，回答保留、管理員仍查得到。
 *   同一個人移出後又加回，有「目前的那一列」就只算目前那一類，不會同時出現在兩個清單。
 *
 * 分子＝目前名單裡已經正式送出過（有任何一個正式版本）的數量。已移出者即使交過也不算（8／10 移出一位已交者變 7／9）。
 * 每一列的「已繳／未繳／逾期未繳」用學生作業區**同一個** `statusOf` 算，所以學生首頁、作業區、名單頁的口徑一致。
 */

export type RosterCategory = 'current' | 'exempt' | 'removed'

/** 名單列上判斷分類與狀態要用到的事實（名單頁、學生作業區共用）。 */
export type ReceiverFacts = {
  /** 名單列的結束時間；null＝還在名單上。 */
  readonly eligibleTo: Date | null
  readonly exempt: boolean
  readonly hasDraft: boolean
  readonly latestVersionNo: number | null
}

export function categoryOf(facts: Pick<ReceiverFacts, 'eligibleTo' | 'exempt'>): RosterCategory {
  if (facts.eligibleTo !== null) return 'removed'
  return facts.exempt ? 'exempt' : 'current'
}

export type ItemWindow = { readonly opensAt: Date | null; readonly dueAt: Date | null }

/**
 * 一位收件者在這份收件上的狀態字（尚未開放／未繳／已繳 vN／逾期未繳／免填）。
 * 學生作業區、學生首頁、名單頁都經這裡，同一組事實一定得到同一個結果。
 */
export function receiverStatus(window: ItemWindow, facts: Omit<ReceiverFacts, 'eligibleTo'>, businessNow: Date): ItemStatusView {
  const phase: Phase = phaseOf(window, businessNow)
  return statusOf({
    phase,
    opensAt: window.opensAt,
    latestVersionNo: facts.latestVersionNo,
    hasDraft: facts.hasDraft,
    exempt: facts.exempt,
  })
}

/** 學生首頁「待繳交」與作業區「待繳」的數字：同一個函式、同一份查詢結果。 */
export function pendingCount(rows: readonly (ItemWindow & Omit<ReceiverFacts, 'eligibleTo'>)[], businessNow: Date): number {
  return rows.filter((row) => receiverStatus(row, row, businessNow).pending).length
}

export type Completion = {
  /** 應交數（分母）：目前名單、不含免填與已移出。 */
  readonly required: number
  /** 已正式送出（分子）。 */
  readonly done: number
  /** 還沒送、還沒截止（含尚未開放）。 */
  readonly pending: number
  /** 還沒送、已經截止。 */
  readonly overdue: number
  readonly exempt: number
  readonly removed: number
  /** 百分比（四捨五入到整數）；分母 0 時是 null（畫面顯示「—」，不假裝 0% 或 100%）。 */
  readonly percent: number | null
}

export function completionOf(window: ItemWindow, entries: readonly ReceiverFacts[], businessNow: Date): Completion {
  let required = 0
  let done = 0
  let overdue = 0
  let exempt = 0
  let removed = 0
  for (const entry of entries) {
    const category = categoryOf(entry)
    if (category === 'removed') {
      removed += 1
      continue
    }
    if (category === 'exempt') {
      exempt += 1
      continue
    }
    required += 1
    const status = receiverStatus(window, entry, businessNow)
    if (status.submitted) done += 1
    else if (status.overdue) overdue += 1
  }
  return {
    required,
    done,
    pending: required - done - overdue,
    overdue,
    exempt,
    removed,
    percent: required === 0 ? null : Math.round((done / required) * 100),
  }
}
