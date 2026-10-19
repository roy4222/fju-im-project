'use server'
import { currentActor } from '@/app/_ui/guard'
import { getItemCommand } from '@/composition/items'

/**
 * 資源分類改名（C 階段規格① §11.3 `resource_category`，C1-07）：前台「檔案下載」分類標題上的「編輯」送到這裡。
 *
 * 規則全在用例 `ItemCommand.renameResourceCategory`（C1-02）：只有系辦、範圍是**所有屆別**的資源（前台依名稱合併跨屆資源）、
 * 新名稱撞到既有分類回「已有這個分類」、一筆交易、`requestId` 冪等、稽核 `item.category_renamed`。這裡只翻譯結果。
 * 不自己刷新頁面：成功由前台編輯框架關窗、提示、`router.refresh()`（②§6.3.1）。
 */
export async function renameResourceCategoryAction(input: {
  from: string
  to: string
  requestId: string
}): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  const text = (value: unknown, max: number) => (typeof value === 'string' ? value.slice(0, max) : '')
  const result = await getItemCommand().renameResourceCategory(await currentActor(), {
    from: text(input?.from, 200),
    to: text(input?.to, 200),
    requestId: text(input?.requestId, 100),
  })
  if (!result.ok) return { ok: false, message: result.message }
  const { from, to, count } = result.receipt
  return { ok: true, message: `已把分類「${from}」改成「${to}」（${count} 個資源，各屆一起改）。` }
}
