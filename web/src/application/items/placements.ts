import type { EditablePlacement, Placement } from '@/application/items/items'

/**
 * 表單載入時的位置（C 階段規格① §0.4、§1.1）。
 *
 * 「專題需求」（`requirement`）只剩範本與示範一筆，視為作業：**不改資料庫**，既有列開表單時以 `submission` 載入、
 * 清單裡跟作業同列；新建一律 `submission`。存回去時保留原本的 `requirement`（`storedPlacementOf`），
 * 所以 CHECK 白名單、前台與示範資料的斷言都不動。
 */

/** 這個位置在表單裡用哪一種（`requirement` → `submission`）；表單不能開的位置（成果展示）回 null。 */
export function formPlacementOf(placement: Placement): EditablePlacement | null {
  if (placement === 'requirement') return 'submission'
  if (placement === 'showcase') return null
  return placement
}

/**
 * 存檔時實際寫進資料庫的位置：原本是 `requirement`、表單送回 `submission`（就是它載入時的樣子）時保留 `requirement`；
 * 其他照表單送的。
 */
export function storedPlacementOf(current: Placement, submitted: EditablePlacement): Placement {
  return current === 'requirement' && submitted === 'submission' ? 'requirement' : submitted
}
