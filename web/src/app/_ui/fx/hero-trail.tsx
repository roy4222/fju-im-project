'use client'
import './hero-trail.css'
import dynamic from 'next/dynamic'
import { useTrailAllowed } from './media-query'

/** WebGL 那份另切一個 chunk：符合載入條件才下載，也不算進首頁的 First Load JS。 */
const PixelTrail = dynamic(() => import('./pixel-trail'), { ssr: false })

/**
 * 「現在」橫幅的金屬像素拖尾（原型 v4 `components/dashboard/hero-trail.tsx`；共用規格 §3.5）。
 * 只由 `HomeHero` 的 `trail` 掛（放在 `section.hero` 裡）；角色頁不要直接用。
 * 鋪滿橫幅、壓在文字與按鈕底下、`pointer-events: none`（不擋點擊）。
 * 伺服器端與第一次 hydration 不渲染；手機、觸控、開了減少動態的不渲染也不下載 chunk。
 */
export function HeroTrail() {
  return useTrailAllowed() ? <PixelTrail /> : null
}
