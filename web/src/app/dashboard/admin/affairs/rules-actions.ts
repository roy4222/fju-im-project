'use server'
import { currentActor } from '@/app/_ui/guard'
import { getItemCommand } from '@/composition/items'

/**
 * 專題規則章節整批排序（C 階段規格① §4.4、C1-08）：拖曳放下後送整串順序（這一屆全部未刪除的章節，含草稿與已下架）。
 *
 * 規則在用例（`ItemCommand.reorderRules`：集合要剛好對上、不重複，不然擋「章節清單剛剛有變動…」）；這裡只把瀏覽器送來的
 * 東西收斂成字串陣列、把結果翻成一句話。上下移仍走 `moveRuleAction`（`actions.ts`）。不 `refresh()`，由畫面 `router.refresh()`。
 */

export type ReorderRulesOutcome = { ok: true; count: number; message: string } | { ok: false; code: string; message: string }

const str = (value: unknown, max: number) => (typeof value === 'string' ? value.slice(0, max) : '')

export async function reorderRulesAction(cohortId: string, orderedIds: readonly string[], requestId: string): Promise<ReorderRulesOutcome> {
  const ids = Array.isArray(orderedIds) ? orderedIds.slice(0, 500).map((id) => str(id, 100)) : []
  const result = await getItemCommand().reorderRules(await currentActor(), str(cohortId, 100), ids, str(requestId, 100))
  if (!result.ok) return { ok: false, code: result.code, message: result.message }
  return { ok: true, count: result.receipt.count, message: '已更新章節順序，前台專題規則的順序同步更新。' }
}
