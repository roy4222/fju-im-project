import { RulesBoard } from '@/app/dashboard/admin/affairs/_content/rules-actions'
import type { RuleCardFacts } from '@/app/dashboard/admin/affairs/_content/rules-card'
import { AFFAIRS_TAB_PLACEMENTS, byRulesPosition, deleteBlockedText } from '@/app/dashboard/admin/affairs/affairs-view'
import { getItemQuery, ITEM_STATUS_LABEL } from '@/composition/items'

/**
 * 公告與作業 › 專題規則的內容（C 階段規格① §4.4、C1-08；②的分頁殼掛這個元件，`{ cohortId }`）。
 *
 * 一頁列出這一屆全部章節卡片（含草稿與已下架，依 `rules_position`，跟前台 `/rules`、`moveRule` 同一個順序）：
 * 拖柄、章名、正文摘要（前 2 行）、狀態、上移／下移、「編輯」「刪除」。拖放與就地編輯在 client 端（`rules-actions.tsx`）。
 * 正文跟清單同一句查完（`ItemQuery.listWithContent`，CL-1；不逐章讀項目）。
 */

/** 正文 HTML → 一段純文字（摘要只顯示前 2 行，畫面上用 line-clamp 截）。 */
function plainSummary(html: string): string {
  return html
    .replace(/<(br|\/p|\/li|\/h[1-6]|\/tr)\b[^>]*>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300)
}

export async function RulesEditor({ cohortId }: { cohortId: string }) {
  const rows = [...(await getItemQuery().listWithContent(cohortId, AFFAIRS_TAB_PLACEMENTS.rules))].sort(byRulesPosition)
  const cards: RuleCardFacts[] = rows.map((r) => ({
    id: r.id,
    title: r.title,
    summary: plainSummary(r.bodyHtml),
    status: r.status,
    statusLabel: ITEM_STATUS_LABEL[r.status],
    deleteBlocked: deleteBlockedText(r.status, null, r.receiverUnit),
  }))
  return <RulesBoard cohortId={cohortId} cards={cards} />
}
