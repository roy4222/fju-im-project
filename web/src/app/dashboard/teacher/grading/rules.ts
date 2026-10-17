import type { TeacherQueueEntry } from '@/application/grading'
import { parseItemScore, type ScoreItemSpec } from '@/shared/score'

/**
 * 單組評分卡的規則與字樣（TE-06b，Q78／Q79 A 文字）。都是純函式與常數，畫面與單元測試共用；
 * 待決項（D5 通過制字樣）與 A／B 會換的句子集中在這裡，定案後只改這一個檔。
 */

/** 通過制兩選一的字樣（⏸ D5，建議值「通過／不通過」）。 */
export const PASS_FAIL_OPTIONS: readonly { value: 'pass' | 'fail'; label: string }[] = [
  { value: 'pass', label: '通過' },
  { value: 'fail', label: '不通過' },
]

/** 確認對話框的說明（A 階段：不寫可以重送、也不寫要系辦退回；TE-B1 再改）。 */
export const CONFIRM_NOTE = '送出後分數會計入階段成績。'

/** 回執對話框的說明（A 階段）。 */
export const RECEIPT_NOTE = '已計入階段成績；多位老師時以算術平均計入。學生看不到分數。'

/** 儲存草稿成功的訊息。 */
export const SAVED_NOTE = '已儲存草稿。草稿只有你和系辦看得到，不算正式分數。'

export type ItemSpec = ScoreItemSpec & { readonly name: string }

/** 每一項的即時錯誤（沒填不算錯）：key → 訊息。 */
export function itemErrors(items: readonly ItemSpec[], values: Readonly<Record<string, string | undefined>>): Map<string, string> {
  const errors = new Map<string, string>()
  items.forEach((item, index) => {
    const raw = values[item.key]
    if (!raw) return
    if (parseItemScore(item, raw).ok) return
    errors.set(item.key, item.type === 'number' ? `第 ${index + 1} 項要填 0–${item.max} 的數字（最多兩位小數）` : `第 ${index + 1} 項選項不對`)
  })
  return errors
}

/** 還有幾項沒填。 */
export function missingCount(items: readonly ItemSpec[], values: Readonly<Record<string, string | undefined>>): number {
  return items.filter((i) => !values[i.key]).length
}

export const missingText = (n: number) => `還有 ${n} 項沒填`

/** 正式送出鍵旁的一句：為什麼還不能送，或可以送了。 */
export function blockReason(errors: ReadonlyMap<string, string>, missing: number): string {
  if (errors.size > 0) return `${[...errors.values()][0]}，修正後才能正式送出。`
  if (missing > 0) return `${missingText(missing)}，填齊後才能正式送出。`
  return '每一項都有效，可以正式送出。'
}

/** 頁首自己的狀態 Pill（`my-status`）：被退回、已送出、草稿 k／n、待評。 */
export function myStatusOf(e: Pick<TeacherQueueEntry, 'state' | 'returned' | 'filled' | 'total'>): {
  text: string
  tone: 'success' | 'brand' | 'danger' | 'default'
} {
  if (e.state === 'counted') return { text: '已送出', tone: 'success' }
  if (e.returned) return { text: e.state === 'draft' ? `被退回・草稿 ${e.filled}／${e.total}` : '被退回', tone: 'danger' }
  if (e.state === 'draft') return { text: `草稿 ${e.filled}／${e.total}`, tone: 'brand' }
  return { text: '待評', tone: 'default' }
}
