/*
 * Pixel Card — React Bits（https://reactbits.dev/components/pixel-card）
 * 改寫成不碰 React 的 canvas 2D 像素格子引擎（規格④ 設計方案 §2.2、§2.4）：建格、idle 常駐呼吸、
 * 從中心擴開的 enterPulse（原型自加）、從點擊處擴開的 clickPulse；Holo 不做。
 * 原版 root 的 `style="--pixel-card-radius…"` 與 `tabIndex=0` 都不照抄（CSP 不准 style 屬性、橫幅不搶 Tab）：
 * 參數走 `data-colors`／`data-gap`／`data-speed`，canvas 大小用 `width`／`height` 屬性。
 *
 * MIT + Commons Clause License Condition v1.0
 * Copyright (c) 2026 David Haz
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
 * documentation files (the "Software"), to deal in the Software without restriction, including without limitation
 * the rights to use, copy, modify, merge, publish, and distribute the Software as part of an application, website,
 * or product, subject to the following conditions: The above copyright notice and this permission notice shall be
 * included in all copies or substantial portions of the Software.
 * Commons Clause Restriction: You may use this Software, including for any commercial purpose, so long as you do
 * not sell, sublicense, or redistribute the components themselves — whether alone, in a bundle, or as a ported version.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
 */
import { startFrameLoop, type FrameLoopOptions } from './frame-loop'

/** 一格像素。座標是 CSS px（左上角），`color` 是 `colors` 的索引。 */
export type Cell = { x: number; y: number; size: number; color: number; phase: number; rate: number }

export type GridOptions = {
  /** 格距（CSS px）。 */
  gap: number
  /** 呼吸速度（React Bits 的 speed 刻度，35＝「疏」那組）。 */
  speed: number
  colorCount: number
}

/** `always`：桌機，常駐呼吸＋漣漪。`tap`：手機，不常駐，只有點擊漣漪。 */
export type PixelMode = 'always' | 'tap'

/** idle 時每格透明度在 0～這個值之間呼吸（0–30%）。 */
export const IDLE_ALPHA = 0.3
/** 一次漣漪從開始到 `data-state` 回 `idle` 的時間。 */
export const PULSE_MS = 1200
/** 同時最多幾個漣漪（連點時丟掉最舊的）。 */
const MAX_PULSES = 4

/**
 * 建格：從 (gap/2, gap/2) 起每 gap 一格，像素邊長 2 或 3，顏色、呼吸相位與速度隨機。
 * 回傳的格子依顏色排序（畫的時候少換 fillStyle）。
 */
export function buildGrid(width: number, height: number, { gap, speed, colorCount }: GridOptions, rand: () => number = Math.random): Cell[] {
  const cells: Cell[] = []
  if (width <= 0 || height <= 0 || gap <= 0 || colorCount <= 0) return cells
  for (let x = gap / 2; x < width; x += gap) {
    for (let y = gap / 2; y < height; y += gap) {
      const size = rand() < 0.5 ? 2 : 3
      cells.push({
        x: Math.round(x - size / 2),
        y: Math.round(y - size / 2),
        size,
        color: Math.min(colorCount - 1, Math.floor(rand() * colorCount)),
        phase: rand() * Math.PI * 2,
        // speed 35 → 每格週期約 1.2～3.6 秒。
        rate: speed * 0.00005 * (0.5 + rand()),
      })
    }
  }
  return cells.sort((a, b) => a.color - b.color)
}

/** idle 呼吸的透明度（0～IDLE_ALPHA）。 */
export function idleAlpha(cell: Cell, now: number): number {
  return IDLE_ALPHA * (0.5 + 0.5 * Math.sin(cell.phase + now * cell.rate))
}

/** 一個漣漪：圓心 (x, y)，`reach` 是圓心到最遠角落的距離，`band` 是亮帶寬度。 */
export type Pulse = { x: number; y: number; start: number; reach: number; band: number }

export function makePulse(x: number, y: number, width: number, height: number, start: number): Pulse {
  const reach = Math.max(Math.hypot(x, y), Math.hypot(width - x, y), Math.hypot(x, height - y), Math.hypot(width - x, height - y))
  return { x, y, start, reach, band: Math.max(40, reach * 0.25) }
}

/** 半徑隨時間線性擴開，PULSE_MS 時亮帶剛好整條掃出最遠的角落。 */
export function pulseRadius(pulse: Pulse, now: number): number {
  const t = Math.min(1, Math.max(0, (now - pulse.start) / PULSE_MS))
  return (pulse.reach + pulse.band) * t
}

export function isPulsing(pulse: Pulse, now: number): boolean {
  return now >= pulse.start && now - pulse.start < PULSE_MS
}

/** 這一格被漣漪點亮多少（0～1）：波前剛掃過最亮，之後在 `band` 內淡回去。 */
export function pulseGlow(pulse: Pulse, cell: Cell, now: number): number {
  if (!isPulsing(pulse, now)) return 0
  const behind = pulseRadius(pulse, now) - Math.hypot(cell.x - pulse.x, cell.y - pulse.y)
  if (behind < 0 || behind > pulse.band) return 0
  return 1 - behind / pulse.band
}

/** 這一格這一幀的透明度。`tap` 模式沒有 idle 呼吸。 */
export function cellAlpha(cell: Cell, pulses: readonly Pulse[], now: number, mode: PixelMode): number {
  let alpha = mode === 'always' ? idleAlpha(cell, now) : 0
  for (const pulse of pulses) alpha = Math.max(alpha, pulseGlow(pulse, cell, now))
  return alpha
}

/** 畫筆：canvas 版在 `mountPixelCanvas`，單元測試用假的記錄呼叫。 */
export type Painter = { clear(): void; color(index: number): void; rect(x: number, y: number, size: number, alpha: number): void }

/** 畫一幀；透明度太低（看不出來）的格子跳過。 */
export function paint(cells: readonly Cell[], pulses: readonly Pulse[], now: number, mode: PixelMode, painter: Painter) {
  painter.clear()
  let current = -1
  for (const cell of cells) {
    const alpha = cellAlpha(cell, pulses, now, mode)
    if (alpha < 0.02) continue
    if (cell.color !== current) {
      current = cell.color
      painter.color(current)
    }
    painter.rect(cell.x, cell.y, cell.size, alpha)
  }
}

/** 漣漪清單：加新的（超過上限丟最舊）、拿掉結束的。 */
export function addPulse(pulses: readonly Pulse[], pulse: Pulse): Pulse[] {
  return [...pulses, pulse].slice(-MAX_PULSES)
}

export function livePulses(pulses: readonly Pulse[], now: number): Pulse[] {
  return pulses.filter((p) => now - p.start < PULSE_MS)
}

/** 從 `data-*` 讀參數；格式不對時用「疏」那組的預設。 */
export function readParams(data: { colors?: string; gap?: string; speed?: string }) {
  const colors = (data.colors ?? '').split(',').map((c) => c.trim()).filter((c) => /^#[0-9a-f]{3,8}$/i.test(c))
  const gap = Number(data.gap)
  const speed = Number(data.speed)
  return {
    colors: colors.length > 0 ? colors : ['#8DB6E6'],
    gap: Number.isFinite(gap) && gap >= 4 ? gap : 10,
    speed: Number.isFinite(speed) && speed > 0 ? speed : 35,
  }
}

/**
 * 把引擎接到 DOM：`root`（帶 `data-*` 參數的那層，鋪滿橫幅）裡的 `canvas`；指標事件聽在 `root.parentElement`（橫幅本身）。
 * `root` 會被設 `data-state`（idle｜pulse）與 `data-running`（0｜1）。回傳清除函式。
 */
export function mountPixelCanvas(root: HTMLElement, canvas: HTMLCanvasElement, mode: PixelMode, loopOptions: Pick<FrameLoopOptions, 'fps'> = {}) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return () => {}
  const params = readParams(root.dataset)
  const hero = root.parentElement ?? root
  let width = 0
  let height = 0
  let cells: Cell[] = []
  let pulses: Pulse[] = []
  let stateTimer = 0

  const painter: Painter = {
    clear: () => ctx.clearRect(0, 0, width, height),
    color: (i) => (ctx.fillStyle = params.colors[i] ?? '#8DB6E6'),
    rect(x, y, size, alpha) {
      ctx.globalAlpha = alpha
      ctx.fillRect(x, y, size, size)
    },
  }

  const draw = (now: number) => {
    pulses = livePulses(pulses, now)
    paint(cells, pulses, now, mode, painter)
    ctx.globalAlpha = 1
  }

  const loop = startFrameLoop(
    root,
    (_dt, now) => {
      draw(now)
      // 手機沒有常駐閃：漣漪畫完（最後一幀已清空）就停。
      if (mode === 'tap' && pulses.length === 0) loop.setActive(false)
    },
    { fps: loopOptions.fps ?? 30, active: mode === 'always', onRunningChange: (running) => (root.dataset.running = running ? '1' : '0') },
  )

  const resize = () => {
    const ratio = Math.min(window.devicePixelRatio || 1, 2)
    width = root.clientWidth
    height = root.clientHeight
    canvas.width = Math.max(1, Math.floor(width * ratio))
    canvas.height = Math.max(1, Math.floor(height * ratio))
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    cells = buildGrid(width, height, { gap: params.gap, speed: params.speed, colorCount: params.colors.length })
    draw(performance.now())
  }

  const pulseAt = (x: number, y: number) => {
    const now = performance.now()
    pulses = addPulse(livePulses(pulses, now), makePulse(x, y, width, height, now))
    root.dataset.state = 'pulse'
    window.clearTimeout(stateTimer)
    stateTimer = window.setTimeout(() => (root.dataset.state = 'idle'), PULSE_MS)
    loop.setActive(true)
  }
  const pulseCenter = () => pulseAt(width / 2, height / 2)
  const onEnter = (event: PointerEvent) => {
    if (event.pointerType === 'mouse' || event.pointerType === 'pen') pulseCenter()
  }
  const onDown = (event: PointerEvent) => {
    const rect = root.getBoundingClientRect()
    pulseAt(event.clientX - rect.left, event.clientY - rect.top)
  }

  root.dataset.state = 'idle'
  const resizeObserver = new ResizeObserver(resize)
  resizeObserver.observe(root)
  hero.addEventListener('pointerenter', onEnter)
  hero.addEventListener('pointerdown', onDown, { passive: true })
  hero.addEventListener('focusin', pulseCenter)
  resize()

  return () => {
    loop.stop()
    window.clearTimeout(stateTimer)
    resizeObserver.disconnect()
    hero.removeEventListener('pointerenter', onEnter)
    hero.removeEventListener('pointerdown', onDown)
    hero.removeEventListener('focusin', pulseCenter)
  }
}
