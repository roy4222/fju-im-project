'use client'
import { useSyncExternalStore } from 'react'
import { mediaQueryStore } from '@/app/_ui/fx/media-query'
import { Gantt } from '@/app/dashboard/_timeline/gantt/gantt'
import type { GanttProps } from '@/app/dashboard/_timeline/gantt/gantt-model'

const DESKTOP_QUERY = '(min-width: 768px)'
const desktop = mediaQueryStore(DESKTOP_QUERY, () => (typeof window === 'undefined' ? undefined : window))

/**
 * 前台 `/timeline` 的唯讀甘特（規格③ §9.5，`mode='view'`）。
 *
 * 甘特是**靜態 import**、進 `/timeline` 自己的路由 chunk：用 `import()` 會讓 Turbopack 為了這個非同步 chunk
 * 重切全站共用 chunk（`cn`、`Button` 被拆出來，每條路由 +1.2 KB；主腦 C3-14 裁定）。手機一樣下載程式碼但不畫：
 * 伺服器與第一次 hydration 一律當「不是電腦」（橫條位置靠瀏覽器端 CSSOM，SSR 不能輸出 `style=`），client 確認
 * `(min-width: 768px)` 成立才 render；畫面下方的活動清單是 SSR 的，手機只看它。
 */
export function GanttView(props: Omit<GanttProps, 'mode' | 'editor'>) {
  const wide = useSyncExternalStore(desktop.subscribe, desktop.getSnapshot, desktop.getServerSnapshot)
  return wide ? <Gantt {...props} mode="view" /> : <div aria-hidden className="hidden h-80 rounded-2xl border border-border bg-card md:block" />
}
