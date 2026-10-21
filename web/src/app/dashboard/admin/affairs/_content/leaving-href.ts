import type { AnchorLike, ClickLike } from '@/app/_ui/nav-pending-rules'

/**
 * 專題規則就地編輯「離開擋未存」的判斷（CL-1）：這次點擊是不是「在同一個分頁換到別頁」的站內連結，是就回要去的網址。
 *
 * 新分頁、下載、修飾鍵、外站、`/api/` 底下（附件下載等 Route Handler）、點回目前這一頁（含只差 `#`）都不算。
 * 跟換頁骨架 `nav-pending-rules.ts` 的 `clickIntent(...) === 'start'` 同一套規則；不 import 它是為了不動共用區塊
 * （import 會讓每條路由都載入的 `$shared` 變大，CL-1 實測 +46 bytes）。兩邊由 `leaving-href.test.ts` 逐案對照（CL-7），
 * 改一邊沒改另一邊會紅。
 */
export function leavingHref(anchor: AnchorLike, event: ClickLike & { defaultPrevented: boolean }, currentUrl: string): string | null {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null
  if ((anchor.target && anchor.target !== '_self') || anchor.hasAttribute('download')) return null
  let url: URL
  try {
    url = new URL(anchor.href, currentUrl)
  } catch {
    return null
  }
  const current = new URL(currentUrl)
  if (url.origin !== current.origin) return null
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return null
  if (url.pathname === current.pathname && url.searchParams.toString() === current.searchParams.toString()) return null
  return url.pathname + url.search + url.hash
}
