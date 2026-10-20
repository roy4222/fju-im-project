'use client'
import dynamic from 'next/dynamic'
import { useSyncExternalStore } from 'react'
import { mediaQueryStore } from '@/app/_ui/fx/media-query'
import type { GanttProps } from '@/app/dashboard/_timeline/gantt/gantt-model'

const DESKTOP_QUERY = '(min-width: 768px)'
const desktop = mediaQueryStore(DESKTOP_QUERY, () => (typeof window === 'undefined' ? undefined : window))

/** 甘特還沒載好時佔位；手機（< 768px）是 `hidden`，SSR 時也不知道寬度，所以兩邊都先畫它。 */
const placeholder = <div aria-hidden className="hidden h-80 rounded-2xl border border-border bg-card md:block" />

// `ssr: false`：橫條位置靠瀏覽器端 CSSOM 設定（CSP 不能輸出 `style=`）。只有寬度成立才 render，chunk 才會下載。
const Gantt = dynamic(() => import('@/app/dashboard/_timeline/gantt/gantt'), { ssr: false, loading: () => placeholder })

/**
 * 前台 `/timeline` 的唯讀甘特（規格③ §9.5，`mode='view'`）。
 *
 * 手機不載甘特 chunk：伺服器與第一次 hydration 一律當「不是電腦」，client 確認 `(min-width: 768px)` 成立才
 * `import()`；畫面下方的活動清單是 SSR 的，手機只看它。視窗從窄拉寬會在那時才載。
 */
export function GanttView(props: Omit<GanttProps, 'mode' | 'editor'>) {
  const wide = useSyncExternalStore(desktop.subscribe, desktop.getSnapshot, desktop.getServerSnapshot)
  return wide ? <Gantt {...props} mode="view" /> : placeholder
}
