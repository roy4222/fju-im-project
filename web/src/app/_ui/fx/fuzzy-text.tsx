'use client'
import Link from 'next/link'
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { startFrameLoop } from './frame-loop'
import { mediaQueryStore } from './media-query'

/** 輔大三色（規格④ §6）：橘 → 黃 → 淺藍，由左到右。canvas 讀 `data-gradient`，不輸出 `style=`。 */
export const BROKEN_GRADIENT = '#E56E00,#F1BA4B,#8DB6E6'

const motionStore = mediaQueryStore('(prefers-reduced-motion: no-preference)', () => (typeof window === 'undefined' ? undefined : window))

/** 沒開「減少動態」。伺服器端與第一次 hydration 回 false：SSR 只輸出真文字（靜態漸層字），掛上後才換 canvas。 */
function useMotionAllowed(): boolean {
  return useSyncExternalStore(motionStore.subscribe, motionStore.getSnapshot, motionStore.getServerSnapshot)
}

type Tag = 'h1' | 'p' | 'span'

/**
 * 「壞掉」頁的一段抖動字（規格④ §6，參考 React Bits 的 Fuzzy Text）：真文字一定在 DOM（`h1`／`p`），
 * canvas 畫上去後真文字改 sr-only（`data-ready`）、canvas `aria-hidden`；字型、大小、粗細都跟真文字的 computed style，
 * 所以字級由 `broken-page.css` 控制（手機縮小）。減少動態：不掛 canvas，真文字帶 `.broken-text` 靜態三色漸層。
 *
 * `intensity`：每一列水平位移的最大比例（字高的倍數，0.35／0.2）；`maxShift` 另外封頂位移的 px（小字 ±1 px）。
 */
export function FuzzyText({
  as: Tag,
  children,
  intensity,
  maxShift,
  fps = 30,
  className,
}: {
  as: Tag
  children: string
  intensity: number
  maxShift?: number
  fps?: number
  className?: string
}) {
  const motion = useMotionAllowed()
  const [ready, setReady] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const root = rootRef.current
    const text = root?.firstElementChild as HTMLElement | null | undefined
    const canvas = root?.querySelector('canvas')
    if (!motion || !root || !text || !canvas) return
    let stop: (() => void) | undefined
    let cancelled = false
    void document.fonts.ready.then(() => {
      if (cancelled) return
      stop = mountFuzzy(root, text, canvas, { intensity, maxShift, fps })
      setReady(true)
    })
    return () => {
      cancelled = true
      stop?.()
      setReady(false)
    }
  }, [motion, intensity, maxShift, fps])

  return (
    <div ref={rootRef} className="fuzzy-text" data-testid="fuzzy-text" data-ready={ready ? '' : undefined}>
      <Tag className={className ? `broken-text ${className}` : 'broken-text'}>{children}</Tag>
      {motion ? <canvas aria-hidden="true" data-gradient={BROKEN_GRADIENT} data-intensity={intensity} /> : null}
    </div>
  )
}

/**
 * 畫面：真文字先畫進離屏 canvas（三色漸層由字的左緣到右緣），每一幀把它一列一列貼到可見 canvas、每列隨機水平位移。
 * 寬度＝字寬＋左右各留最大位移；視窗變窄就重量（文字超過容器時整體縮小，不換行）。
 */
function mountFuzzy(
  root: HTMLElement,
  text: HTMLElement,
  canvas: HTMLCanvasElement,
  { intensity, maxShift, fps }: { intensity: number; maxShift?: number; fps: number },
): () => void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return () => {}
  const stops = (canvas.dataset.gradient ?? BROKEN_GRADIENT).split(',')
  const label = text.textContent ?? ''
  const off = document.createElement('canvas')
  const offCtx = off.getContext('2d')
  if (!offCtx) return () => {}
  let shift = 0
  let w = 0
  let h = 0
  let dpr = 1

  const layout = () => {
    const cs = getComputedStyle(text)
    const size = parseFloat(cs.fontSize) || 16
    const font = `${cs.fontWeight} ${size}px ${cs.fontFamily}`
    dpr = Math.min(window.devicePixelRatio || 1, 2)
    offCtx.font = font
    const m = offCtx.measureText(label)
    const ascent = m.actualBoundingBoxAscent || size * 0.8
    const descent = m.actualBoundingBoxDescent || size * 0.2
    const textW = Math.ceil(m.actualBoundingBoxLeft + m.actualBoundingBoxRight || m.width)
    shift = Math.min(size * intensity, maxShift ?? Infinity)
    const pad = Math.ceil(shift) + 2
    w = textW + pad * 2
    h = Math.ceil(ascent + descent) + 4
    off.width = Math.ceil(w * dpr)
    off.height = Math.ceil(h * dpr)
    offCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
    offCtx.font = font
    offCtx.textBaseline = 'alphabetic'
    const x = pad + (m.actualBoundingBoxLeft || 0)
    const grad = offCtx.createLinearGradient(pad, 0, pad + textW, 0)
    stops.forEach((c, i) => grad.addColorStop(stops.length === 1 ? 0 : i / (stops.length - 1), c))
    offCtx.fillStyle = grad
    offCtx.fillText(label, x, 2 + ascent)
    canvas.width = off.width
    canvas.height = off.height
    // 只有 CSSOM（CSP 沒有 unsafe-inline）；超過容器時由 CSS 的 max-width 等比縮。
    canvas.style.setProperty('width', `${w}px`)
    canvas.style.setProperty('aspect-ratio', `${off.width} / ${off.height}`)
  }

  const draw = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    const rows = off.height
    const step = Math.max(1, Math.round(dpr))
    for (let y = 0; y < rows; y += step) {
      const dx = Math.round((Math.random() - 0.5) * 2 * shift * dpr)
      ctx.drawImage(off, 0, y, off.width, step, dx, y, off.width, step)
    }
  }

  layout()
  draw()
  const loop = startFrameLoop(root, draw, { fps })
  const ro = new ResizeObserver(() => {
    const before = `${w}x${h}`
    layout()
    if (`${w}x${h}` !== before) draw()
  })
  ro.observe(root)
  return () => {
    loop.stop()
    ro.disconnect()
  }
}

/**
 * 「回首頁」：真的 `<a>`，每 4–7 秒隨機抖 0.4 秒（切 `is-glitching` class，樣式在 `broken-page.css`）；
 * 抖動中照樣可點、focus 樣式不變。減少動態不抖。
 */
export function GlitchLink({ href, className, children }: { href: string; className?: string; children: ReactNode }) {
  const motion = useMotionAllowed()
  const [glitching, setGlitching] = useState(false)

  useEffect(() => {
    if (!motion) return
    let timer: ReturnType<typeof setTimeout>
    const next = () => {
      timer = setTimeout(
        () => {
          setGlitching(true)
          timer = setTimeout(() => {
            setGlitching(false)
            next()
          }, 400)
        },
        4000 + Math.random() * 3000,
      )
    }
    next()
    return () => {
      clearTimeout(timer)
      setGlitching(false)
    }
  }, [motion])

  return (
    <Link href={href} className={`broken-glitch ${className ?? ''}${glitching ? ' is-glitching' : ''}`}>
      {children}
    </Link>
  )
}
