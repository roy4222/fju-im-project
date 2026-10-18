'use client'

import { usePathname } from 'next/navigation'
import { useEffect } from 'react'
import { LOGIN_COOKIE, loginMethodFromCookie, trackEvent } from './track'

/**
 * 頁面瀏覽（含 client navigation）與登入事件（B 設計方案 §7.3.1，▶R2-2）。
 *
 * 每次 pathname 變更送一次 `page_view`（位置是固定路由名稱，見 `track.ts`）。
 * 同一時間讀一次性 cookie `fju_ga_login`（VB-4 的密碼登入、VB-5 的 Google callback 寫入）：
 * 讀到就**立即清掉**，值合法才送 `login`；沒設 GA 也照樣清，cookie 不會留著。
 */
export function PageView() {
  const pathname = usePathname()
  useEffect(() => {
    trackEvent('page_view')
    if (!document.cookie.includes(`${LOGIN_COOKIE}=`)) return
    const method = loginMethodFromCookie(document.cookie)
    document.cookie = `${LOGIN_COOKIE}=; Max-Age=0; Path=/`
    if (method) trackEvent('login', { method })
  }, [pathname])
  return null
}
