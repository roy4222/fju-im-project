'use client'

import { useEffect } from 'react'
import { trackEvent, type GaEvent, type GaParams } from './track'

/**
 * 掛在 Server Component 頁面裡、載入時送一次事件（B 設計方案 §7.3.1）：
 * `<TrackOnMount event="register_step" params={{ step: 1 }} />`。
 */
export function TrackOnMount<E extends GaEvent>({ event, params }: { event: E; params?: GaParams[E] }) {
  // 參數是 RSC 傳下來的新物件，用內容當相依，同一頁重畫不會重送。
  const key = JSON.stringify(params ?? {})
  useEffect(() => {
    const parsed = JSON.parse(key) as GaParams[E]
    ;(trackEvent as (name: GaEvent, params?: unknown) => void)(event, parsed)
  }, [event, key])
  return null
}
