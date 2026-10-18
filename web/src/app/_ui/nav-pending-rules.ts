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

export function shouldTrackClick(anchor: AnchorLike, event: ClickLike, currentUrl: string): boolean {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false
  if ((anchor.target && anchor.target !== '_self') || anchor.hasAttribute('download')) return false
  let next: URL
  try {
    next = new URL(anchor.href, currentUrl)
  } catch {
    return false
  }
  const current = new URL(currentUrl)
  if (next.origin !== current.origin) return false
  if (next.pathname === '/api' || next.pathname.startsWith('/api/')) return false
  return navKey(next) !== navKey(current)
}
