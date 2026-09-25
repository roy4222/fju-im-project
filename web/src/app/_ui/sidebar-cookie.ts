/**
 * 後台側欄收合狀態的 cookie（shadcn sidebar 原本只寫不讀）。
 *
 * 瀏覽器端在切換時寫（`ui/sidebar.tsx`）、伺服器端在畫外殼時讀（`site-shell.tsx` 的 `DashboardShell`），
 * 重新整理或換頁時側欄維持上次的收合狀態，不會先展開再縮回去。放在不帶 `'use client'` 的檔案，
 * 伺服器元件才拿得到真的字串（從 client 模組匯入的值在伺服器端是參照，不是值）。
 */
export const SIDEBAR_COOKIE_NAME = 'sidebar_state'
export const SIDEBAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 7

/** 只有明確寫過 `false` 才算收合；沒有 cookie 或其他值一律展開。 */
export function sidebarOpenFromCookie(value: string | undefined): boolean {
  return value !== 'false'
}
