'use client'

import './nav-pending.css'
import { usePathname, useSearchParams } from 'next/navigation'
import { Suspense, useEffect, useRef, useState } from 'react'
import { navKey, shouldTrackClick } from '@/app/_ui/nav-pending-rules'

/**
 * 換頁載入骨架（C4-06，設計方案 §7）：不用 `loading.tsx`（殼在 page 裡、守衛的 3xx／404 會被串流蓋成 200），
 * 改在根 layout 用前端 pending 狀態畫內容骨架。
 *
 * - 開始：同源連結點擊（規則見 `nav-pending-rules.ts`）或 `popstate`；150 ms 內完成的換頁不閃。
 * - 完成：`usePathname()`＋`useSearchParams()` 變了 → 清 `html[data-nav-pending]` 與全部計時器。
 * - 快速連點：先清舊計時器再重新計時；返回／前進命中快取時鍵可能已提交，開始與 150 ms 時都比一次。
 * - 8 秒還沒到：不算完成，骨架留著並加「仍在載入……」＋重新整理連結。
 * - 骨架顯示只靠 `html[data-nav-pending]` 的 CSS；沒有 `style=`（CSP）。
 */

const SHOW_DELAY_MS = 150
const SLOW_AFTER_MS = 8000

function NavPendingTracker() {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [slowHref, setSlowHref] = useState<string | null>(null)
  const committed = useRef<string | null>(null)
  const clearRef = useRef<() => void>(() => {})

  useEffect(() => {
    const root = document.documentElement
    let showTimer: number | undefined
    let slowTimer: number | undefined
    let target: string | null = null

    const clear = () => {
      window.clearTimeout(showTimer)
      window.clearTimeout(slowTimer)
      showTimer = slowTimer = undefined
      target = null
      delete root.dataset.navPending
      setSlowHref(null)
    }
    clearRef.current = clear

    const start = (key: string) => {
      clear()
      if (key === committed.current) return
      target = key
      showTimer = window.setTimeout(() => {
        if (target === committed.current) return clear()
        root.dataset.navPending = '1'
      }, SHOW_DELAY_MS)
      slowTimer = window.setTimeout(() => setSlowHref(window.location.href), SLOW_AFTER_MS)
    }

    const onClick = (event: MouseEvent) => {
      const anchor = (event.target as Element | null)?.closest?.('a[href]')
      if (!(anchor instanceof HTMLAnchorElement)) return
      if (!shouldTrackClick(anchor, event, window.location.href)) return
      start(navKey(new URL(anchor.href, window.location.href)))
    }
    const onPopState = () => start(navKey(window.location.href))

    document.addEventListener('click', onClick, true)
    window.addEventListener('popstate', onPopState)
    return () => {
      document.removeEventListener('click', onClick, true)
      window.removeEventListener('popstate', onPopState)
      clear()
      clearRef.current = () => {}
    }
  }, [])

  useEffect(() => {
    // 讀網址本身（Next 在這之前已更新 history）：跟點擊時用的 `anchor.href` 同一種編碼。
    const key = navKey(window.location.href)
    if (committed.current !== null && key !== committed.current) clearRef.current()
    committed.current = key
  }, [pathname, searchParams])

  return (
    <div className="nav-skeleton" role="status" aria-live="polite" hidden>
      <span className="sr-only">載入中</span>
      <div className="nav-skeleton-bars" aria-hidden>
        <span />
        <span />
        <span />
      </div>
      {slowHref ? (
        <p className="nav-skeleton-slow">
          仍在載入……<a href={slowHref}>重新整理</a>
        </p>
      ) : null}
    </div>
  )
}

/** `useSearchParams` 要在 Suspense 裡；邊界只包骨架本身，頁面在外面，狀態碼不受影響（AC-46）。 */
export function NavPending() {
  return (
    <Suspense fallback={null}>
      <NavPendingTracker />
    </Suspense>
  )
}
