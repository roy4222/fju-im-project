'use client'
import './hero-pixel.css'
import { useEffect, useRef } from 'react'
import { useFxAllowed, usePixelTouchAllowed } from './media-query'
import type { PixelMode } from './pixel-canvas'

/** 「疏」那組（規格④ §2.2）：淺藍 ×2、淡藍、黃、橘；格距 10 px、速度 35。 */
const COLORS = '#8DB6E6,#8DB6E6,#BFDDF5,#F1BA4B,#F59A3C'

/**
 * 「現在」橫幅的 Pixel Card（規格④ §2；取代 Pixel Trail）。只由 `HomeHero` 的 `trail` 掛（放在 `section.hero` 裡）。
 * 鋪滿橫幅、壓在文字與按鈕底下、`pointer-events: none`（不擋點擊）；`section.hero` 不加 `tabIndex`。
 * 伺服器端與第一次 hydration 不渲染；開了減少動態的不渲染、也不下載引擎 chunk。
 * 桌機（hover＋精準指標）常駐閃＋移入／點擊／焦點漣漪；手機（粗指標）只有點擊漣漪。
 */
export function HeroPixel() {
  const fx = useFxAllowed()
  const touch = usePixelTouchAllowed()
  if (!fx && !touch) return null
  return <PixelLayer mode={fx ? 'always' : 'tap'} />
}

/**
 * 引擎（`pixel-canvas.ts`）另切一個 chunk，掛上後才 `import()`，不算進首頁的 First Load JS。
 * `data-state`（idle｜pulse）、`data-running`（0｜1）由引擎設，給 e2e 與 `perf:trail`。
 */
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
    <div ref={ref} className="hero-pixel" aria-hidden="true" data-testid="hero-pixel" data-colors={COLORS} data-gap="10" data-speed="35">
      <canvas />
    </div>
  )
}
