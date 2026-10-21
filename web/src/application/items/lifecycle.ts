import { canViewItem, HONOR_PLACEMENT, type ItemStatus, type ItemVisibility, type Placement, type Viewer } from '@/application/items/items'
import { formatTaipeiMinute } from '@/shared/time'

/**
 * 項目生命週期與前台可見性的純規則（票 16；產品模組 04 §4.5、09 §9.1、08「站內日曆」）。
 *
 * 生命週期（04 §4.5 的狀態圖）：
 * - 撤回：發布中 → 草稿，**只有還沒有任何回答時**可以；受眾看不到了，之後改好再「發布」恢復同一個項目。
 * - 下架：發布中 → 已下架；既有回答、名單、紀錄都留著，前台網址改成顯示「已下架」與下一步。
 * - 重新發布：已下架 → 發布中；不切新版本、**不重設原本的實際開放時間**。
 * - 刪除（第三波 W1）：只限草稿與已下架；之後後台清單、前台、附件下載都當作不存在，不能恢復，已寄的通知不收回。
 *   收件項目只要有人存過草稿或正式送出就不能刪，只能下架（Q28）。
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
          message: '已經有人作答，不能撤回成草稿（回答要保留）；不再讓學生繳交請改用「下架」。',
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

/**
 * 已經截止的收件不能直接重新發布（回到發布中卻收不了件，學生只會看到一份「已截止」的待辦）。
 * 下架的項目不能改截止，所以提示的下一步是另建一份或維持下架留紀錄。
 */
export function describeRepublishExpired(dueAt: Date): string {
  return `這個作業的截止（${formatTaipeiMinute(dueAt)}，臺灣時間）已經過了，不能直接重新發布。要再讓學生繳交請另建一個新的作業並設新的截止；只是要保留紀錄的話維持下架即可。`
}

/** 刪除被擋時的固定文案（畫面停用按鈕旁、伺服器拒絕都用這兩句）。 */
export const DELETE_PUBLISHED_MESSAGE = '發布中的項目不能刪除；要先撤回或下架才能刪除。'
export const DELETE_HAS_RESPONSES_MESSAGE = '已經有學生交件，只能下架，不能刪除。'

/**
 * 刪除能不能做：草稿與已下架可以，發布中不行（前台曾公開的東西一定先經過「看不到」這一步）；
 * 有任何回答（存過草稿或正式送出）就不行，只能下架（Q28）。
 */
export function deleteCheck(status: ItemStatus, hasResponses: boolean): { readonly ok: true } | LifecycleRefusal {
  if (status === 'published') return refuse(DELETE_PUBLISHED_MESSAGE)
  if (hasResponses) return { ok: false, code: 'ITEM_HAS_RESPONSES', message: DELETE_HAS_RESPONSES_MESSAGE }
  return { ok: true }
}

export type DeleteReceipt = {
  readonly itemId: string
  readonly cohortId: string
  readonly title: string
  /** 刪除前的狀態（草稿或已下架）。 */
  readonly status: ItemStatus
}

/** 刪除回執 → 畫面上的一句話。 */
export function describeDeleteReceipt(receipt: DeleteReceipt): string {
  return `「${receipt.title}」已刪除。後台清單與前台都看不到了，不能恢復；已寄出的通知不會收回。`
}

/**
 * 屆別封存後還能不能動這個位置的項目：榮譽榜是跨屆的公開紀錄（第三波 W1），封存屆別的榮譽仍可新增、編輯、
 * 下架、重新發布、刪除；其他位置封存後一律不能動。
 */
export function editableInArchivedCohort(placement: Placement | string): boolean {
  return placement === HONOR_PLACEMENT
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
  /** 重新發布時勾了「重要」逐人通知了幾位（其他動作都是 0；舊回執沒有這欄）。 */
  readonly notifiedCount?: number
}

/** 回執 → 畫面上的一句話（伺服器產生，畫面只顯示）。 */
export function describeLifecycleReceipt(receipt: LifecycleReceipt): string {
  const opened = receipt.actualOpenedAt
    ? `實際開放時間仍是 ${formatTaipeiMinute(new Date(receipt.actualOpenedAt))}（臺灣時間）。`
    : ''
  switch (receipt.action) {
    case 'withdraw': {
      const roster = receipt.rosterClosed > 0 ? `需要繳交的名單 ${receipt.rosterClosed} 筆已結束，再發布時照當下「誰看得到」的設定重建。` : ''
      return `「${receipt.title}」已撤回成草稿，原本看得到的人都看不到了。${roster}改好後按「發布」就會恢復同一個項目；${opened}`
    }
    case 'archive':
      return `「${receipt.title}」已下架。前台網址會顯示「已下架」與下一步；既有回答與紀錄都保留。`
    case 'republish': {
      const notified = receipt.notifiedCount ? `已通知 ${receipt.notifiedCount} 位（站內通知）。` : ''
      return `「${receipt.title}」已重新發布，對象又看得到了。${notified}${opened}`
    }
  }
}

// ── 前台可見性 ──────────────────────────────────────────────────────────────

/**
 * 前台內容頁打開一個項目時該顯示什麼（產品模組 09 §9.1、SHW-02、SHW-06、PUB-10）：
 *
 * - `visible`：發布中而且在對象內 → 顯示內容。
 * - `archived`：已下架，而且看的人原本就在對象內 → 告知已下架與下一步（不是 404），**不帶標題與內容**。
 * - `withdrawn`：發布過、後來撤回成草稿，看的人原本在對象內 → 告知「已撤回」（產品 08「來源已撤回」），同樣不帶內容。
 * - `deleted`：已刪除，而且看的人**原本就看得到**（發布過、在對象內）→ 告知「已刪除」（CL-14），同樣不帶內容。
 *   判斷跟還在的項目完全一樣，只把結果換掉：不在對象內的人照舊找不到、訪客遇到非公開照舊先登入，
 *   所以看不到的人分不出「被刪了」還是「從來沒有」。
 * - `need_login`：沒登入、對象又不是公開 → 請他登入（不透露標題）。
 * - `not_found`：從沒發布過的草稿、別的位置、已登入但不在對象內 → 跟「沒有這一頁」一樣。
 *
 * 管理員在前台也只看得到發布中與已下架的（前台不是預覽草稿的地方）。
 */
export type PublicAccess = 'visible' | 'archived' | 'withdrawn' | 'deleted' | 'need_login' | 'not_found'

export function publicAccessOf(
  viewer: Viewer,
  item: ItemVisibility & { readonly everPublished: boolean; readonly deleted?: boolean },
): PublicAccess {
  if (item.status === 'draft' && !item.everPublished) return 'not_found'
  const inAudience = canViewItem(viewer, { ...item, status: 'published' })
  if (!inAudience) return viewer.kind === 'anonymous' ? 'need_login' : 'not_found'
  if (item.deleted) return 'deleted'
  if (item.status === 'published') return 'visible'
  return item.status === 'archived' ? 'archived' : 'withdrawn'
}
