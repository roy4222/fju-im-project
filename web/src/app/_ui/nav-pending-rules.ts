/**
 * 換頁載入骨架（C4-06，設計方案 §7.2）的判斷規則：純函式，元件只負責接事件與計時。
 *
 * - 導覽鍵＝`pathname + search`：同頁換 `?page=2` 也算換頁；只有 `#` 不同的不算。
 * - 只追蹤「這一下會在同一個分頁裡換頁」的點擊：同源、左鍵、沒有修飾鍵、沒有 `target`／`download`。
 * - `/api/` 底下是 Route Handler（檔案下載等），不會換頁，追蹤了骨架會一直掛著。
 */

export type AnchorLike = { href: string; target: string; hasAttribute(name: string): boolean }
export type ClickLike = { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }

export function navKey(url: string | URL): string {
  const parsed = typeof url === 'string' ? new URL(url) : url
  const search = parsed.searchParams.toString()
  return search ? `${parsed.pathname}?${search}` : parsed.pathname
}

/**
 * 這一下點擊對骨架的意思：
 * - `start`：同一個分頁換到另一個導覽鍵，開始計時。
 * - `cancel`：同一個分頁、但點回目前這一頁（含純 hash）——Next 會取消還沒到的導覽、網址不變，
 *   舊的計時器與骨架要清掉，不開新的。
 * - `ignore`：不是這個分頁的換頁（修飾鍵、另開分頁、下載、外站、/api/）。
 */
export type ClickIntent = 'start' | 'cancel' | 'ignore'

// 專題規則就地編輯的「離開擋未存」（`admin/affairs/_content/rules-actions.tsx` 的 `leavingHref`）抄了同一套規則
// （為了不動共用區塊沒有 import 這裡）；改這裡的判斷要一起改那邊。

export function clickIntent(anchor: AnchorLike, event: ClickLike, currentUrl: string): ClickIntent {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return 'ignore'
  if ((anchor.target && anchor.target !== '_self') || anchor.hasAttribute('download')) return 'ignore'
  let next: URL
  try {
    next = new URL(anchor.href, currentUrl)
  } catch {
    return 'ignore'
  }
  const current = new URL(currentUrl)
  if (next.origin !== current.origin) return 'ignore'
  if (next.pathname === '/api' || next.pathname.startsWith('/api/')) return 'ignore'
  return navKey(next) !== navKey(current) ? 'start' : 'cancel'
}

export function shouldTrackClick(anchor: AnchorLike, event: ClickLike, currentUrl: string): boolean {
  return clickIntent(anchor, event, currentUrl) === 'start'
}
