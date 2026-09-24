import { canViewItem, type ItemStatus, type ItemVisibility, type Viewer } from '@/application/items/items'
import { formatTaipeiMinute } from '@/shared/time'

/**
 * 項目生命週期與前台可見性的純規則（票 16；產品模組 04 §4.5、09 §9.1、08「站內日曆」）。
 *
 * 生命週期（04 §4.5 的狀態圖）：
 * - 撤回：發布中 → 草稿，**只有還沒有任何回答時**可以；受眾看不到了，之後改好再「發布」恢復同一個項目。
 * - 下架：發布中 → 已下架；既有回答、名單、紀錄都留著，前台網址改成顯示「已下架」與下一步。
 * - 重新發布：已下架 → 發布中；不切新版本、**不重設原本的實際開放時間**。
 */

export type LifecycleAction = 'withdraw' | 'archive' | 'republish'

export const LIFECYCLE_LABEL: Readonly<Record<LifecycleAction, string>> = {
  withdraw: '撤回',
  archive: '下架',
  republish: '重新發布',
}

export type LifecycleRefusal = {
  readonly ok: false
  readonly code: 'VALIDATION_FAILED' | 'ITEM_HAS_RESPONSES'
  readonly message: string
}

/**
 * 這個動作在目前狀態能不能做。`hasResponses` 只有撤回用得到（其他動作不看）。
 * 回 `{ ok: true }` 或拒絕的錯誤碼與給人看的一句話。
 */
export function lifecycleCheck(
  action: LifecycleAction,
  status: ItemStatus,
  hasResponses: boolean,
): { readonly ok: true } | LifecycleRefusal {
  switch (action) {
    case 'withdraw':
      if (status !== 'published') {
        return refuse(status === 'draft' ? '這個項目還是草稿，不用撤回。' : '已下架的項目不能撤回；要再給人看請按「重新發布」。')
      }
      if (hasResponses) {
        return {
          ok: false,
          code: 'ITEM_HAS_RESPONSES',
          message: '已經有人作答，不能撤回成草稿（回答要保留）；不再收件請改用「下架」。',
        }
      }
      return { ok: true }
    case 'archive':
      if (status !== 'published') {
        return refuse(status === 'draft' ? '草稿還沒發布，不用下架。' : '這個項目已經下架了，請重新整理頁面。')
      }
      return { ok: true }
    case 'republish':
      if (status !== 'archived') {
        return refuse(
          status === 'draft' ? '草稿請用「發布」；撤回過的項目改好後也是按「發布」。' : '這個項目正在發布中，請重新整理頁面。',
        )
      }
      return { ok: true }
  }
}

function refuse(message: string): LifecycleRefusal {
  return { ok: false, code: 'VALIDATION_FAILED', message }
}

/** 動作之後的狀態。 */
export const LIFECYCLE_NEXT_STATUS: Readonly<Record<LifecycleAction, ItemStatus>> = {
  withdraw: 'draft',
  archive: 'archived',
  republish: 'published',
}

export type LifecycleReceipt = {
  readonly itemId: string
  readonly title: string
  readonly action: LifecycleAction
  readonly status: ItemStatus
  readonly revision: number
  /** 實際開放時間（第一次發布時記下，撤回、下架、重新發布都不改）。 */
  readonly actualOpenedAt: string | null
  /** 撤回時結束了幾列收件名單（再發布時照當下的對象重建）。 */
  readonly rosterClosed: number
}

/** 回執 → 畫面上的一句話（伺服器產生，畫面只顯示）。 */
export function describeLifecycleReceipt(receipt: LifecycleReceipt): string {
  const opened = receipt.actualOpenedAt
    ? `實際開放時間仍是 ${formatTaipeiMinute(new Date(receipt.actualOpenedAt))}（臺灣時間）。`
    : ''
  switch (receipt.action) {
    case 'withdraw': {
      const roster = receipt.rosterClosed > 0 ? `收件名單 ${receipt.rosterClosed} 筆已結束，再發布時照當下的對象重建。` : ''
      return `「${receipt.title}」已撤回成草稿，受眾看不到了。${roster}改好後按「發布」就會恢復同一個項目；${opened}`
    }
    case 'archive':
      return `「${receipt.title}」已下架。前台網址會顯示「已下架」與下一步；既有回答與紀錄都保留。`
    case 'republish':
      return `「${receipt.title}」已重新發布，對象又看得到了。${opened}`
  }
}

// ── 前台可見性 ──────────────────────────────────────────────────────────────

/**
 * 前台內容頁打開一個項目時該顯示什麼（產品模組 09 §9.1、SHW-02、SHW-06、PUB-10）：
 *
 * - `visible`：發布中而且在對象內 → 顯示內容。
 * - `archived`：已下架，而且看的人原本就在對象內 → 告知已下架與下一步（不是 404），**不帶標題與內容**。
 * - `withdrawn`：發布過、後來撤回成草稿，看的人原本在對象內 → 告知「已撤回」（產品 08「來源已撤回」），同樣不帶內容。
 * - `need_login`：沒登入、對象又不是公開 → 請他登入（不透露標題）。
 * - `not_found`：從沒發布過的草稿、別的位置、已登入但不在對象內 → 跟「沒有這一頁」一樣。
 *
 * 管理員在前台也只看得到發布中與已下架的（前台不是預覽草稿的地方）。
 */
export type PublicAccess = 'visible' | 'archived' | 'withdrawn' | 'need_login' | 'not_found'

export function publicAccessOf(viewer: Viewer, item: ItemVisibility & { readonly everPublished: boolean }): PublicAccess {
  if (item.status === 'draft' && !item.everPublished) return 'not_found'
  const inAudience = canViewItem(viewer, { ...item, status: 'published' })
  if (!inAudience) return viewer.kind === 'anonymous' ? 'need_login' : 'not_found'
  if (item.status === 'published') return 'visible'
  return item.status === 'archived' ? 'archived' : 'withdrawn'
}
