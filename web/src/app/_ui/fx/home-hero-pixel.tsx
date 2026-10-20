'use client'
import './home-hero-pixel.css'
import { useEffect, useRef } from 'react'
import { useFxAllowed, usePixelTouchAllowed } from './media-query'
import type { PixelMode } from './pixel-canvas'

/** 顏色、格距、速度同後台橫幅（規格④ §2.2、§3）；「淡」由 CSS 把整層壓到 50%。 */
const COLORS = '#8DB6E6,#8DB6E6,#BFDDF5,#F1BA4B,#F59A3C'

/**
 * 前台首頁橫幅的 Pixel（規格④ §3）。放在 hero `<section>` 裡、漸層之後、文字之前；`/office-edit` 用同一個首頁元件，自動一起有。
 * 伺服器端與第一次 hydration 不渲染（SSR 只有照片＋漸層）；開了減少動態的不渲染、也不下載引擎 chunk。
 * 桌機常駐閃＋移入／點擊漣漪；手機只有點擊漣漪。
 */
export function HomeHeroPixel() {
  const fx = useFxAllowed()
  const touch = usePixelTouchAllowed()
  if (!fx && !touch) return null
  return <PixelLayer mode={fx ? 'always' : 'tap'} />
}

/** 引擎（`pixel-canvas.ts`）掛上後才 `import()`，不算進首頁的 First Load JS。 */
function PixelLayer({ mode }: { mode: PixelMode }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    let stop: (() => void) | undefined
    void import('./pixel-canvas').then(({ mountPixelCanvas }) => {
      const root = ref.current
      const canvas = root?.querySelector('canvas')
      if (cancelled || !root || !canvas) return
      stop = mountPixelCanvas(root, canvas, mode)
    })
    return () => {
      cancelled = true
      stop?.()
    }
  }, [mode])

  return (
    <div ref={ref} className="home-hero-pixel" aria-hidden="true" data-testid="home-hero-pixel" data-colors={COLORS} data-gap="10" data-speed="35">
      <canvas />
    </div>
  )
}
