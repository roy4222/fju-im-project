import { startFrameLoop } from './frame-loop'

/** 每列水平位移的範圍（px），乘上強度（0.35 → ±約 10 px），同 React Bits Fuzzy Text 的 fuzzRange。 */
const FUZZ_RANGE = 30

/**
 * 404／403「壞掉」頁的特效引擎（規格④ §6）：只有沒開「減少動態」、頁面有 `[data-broken-fx]` 時由 `fuzzy-text.tsx` 的載入器（掛在 `SiteHeader`）`import()`，
 * 另切一個 chunk——根層 not-found 的 client 程式會進每條路由的首載，引擎不能跟著進去（C4-05 主腦裁定）。
 * 標記全由伺服器輸出（`broken-page.tsx`）：`[data-fuzzy]` 是一段字（真文字是它的第一個子元素），
 * 參數走 `data-*`（`data-gradient`、`data-intensity`、`data-max-shift`、`data-fps`）；`.broken-glitch` 是要抖的按鈕。
 * 引擎在每段字裡加 `aria-hidden` 的 canvas、設 `data-ready`（CSS 把真文字改成 sr-only），回傳的函式全部收掉。
 */
export function mountBrokenFx(root: ParentNode): () => void {
  const stops: Array<() => void> = []
  for (const el of root.querySelectorAll<HTMLElement>('[data-fuzzy]')) {
    const text = el.firstElementChild as HTMLElement | null
    if (!text) continue
    const canvas = document.createElement('canvas')
    canvas.setAttribute('aria-hidden', 'true')
    canvas.dataset.gradient = el.dataset.gradient ?? ''
    el.append(canvas)
    const stop = mountFuzzy(el, text, canvas, {
      intensity: Number(el.dataset.intensity) || 0.2,
      maxShift: el.dataset.maxShift ? Number(el.dataset.maxShift) : undefined,
      fps: Number(el.dataset.fps) || 30,
    })
    el.dataset.ready = ''
    stops.push(() => {
      stop()
      canvas.remove()
      delete el.dataset.ready
    })
  }
  for (const link of root.querySelectorAll<HTMLElement>('.broken-glitch')) stops.push(glitch(link))
  return () => stops.forEach((s) => s())
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
  const stops = (canvas.dataset.gradient || '#E56E00,#F1BA4B,#8DB6E6').split(',')
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
    shift = Math.min(FUZZ_RANGE * intensity, maxShift ?? Infinity)
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
 * 按鈕每 4–7 秒隨機抖 0.4 秒：切 `is-glitching` class（樣式在 `broken-page.css`，只動 transform 與 text-shadow），
 * 抖動中照樣可點、focus 樣式不變。
 */
function glitch(link: HTMLElement): () => void {
  let timer: ReturnType<typeof setTimeout>
  const next = () => {
    timer = setTimeout(
      () => {
        link.classList.add('is-glitching')
        timer = setTimeout(() => {
          link.classList.remove('is-glitching')
          next()
        }, 400)
      },
      4000 + Math.random() * 3000,
    )
  }
  next()
  return () => {
    clearTimeout(timer)
    link.classList.remove('is-glitching')
  }
}
