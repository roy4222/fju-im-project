import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  IDLE_ALPHA,
  PULSE_MS,
  addPulse,
  buildGrid,
  cellAlpha,
  idleAlpha,
  isPulsing,
  livePulses,
  makePulse,
  mountPixelCanvas,
  paint,
  pulseGlow,
  pulseRadius,
  readParams,
  type Cell,
  type Painter,
} from './pixel-canvas'

/** 固定的亂數序列，結果可重現。 */
function seeded(seed = 1) {
  let s = seed
  return () => {
    s = (s * 16807) % 2147483647
    return (s - 1) / 2147483646
  }
}

const opts = { gap: 10, speed: 35, colorCount: 5 }

function recorder() {
  const calls = { clear: 0, colors: [] as number[], rects: [] as { x: number; y: number; alpha: number }[] }
  const painter: Painter = {
    clear: () => calls.clear++,
    color: (i) => calls.colors.push(i),
    rect: (x, y, _size, alpha) => calls.rects.push({ x, y, alpha }),
  }
  return { calls, painter }
}

describe('pixel-canvas：像素格子引擎（規格④ §2.2、§2.4）', () => {
  it('建格：gap 10 的 1000×300 是 100×30 格；像素邊長 2 或 3；依顏色排序', () => {
    const cells = buildGrid(1000, 300, opts, seeded())
    expect(cells).toHaveLength(100 * 30)
    expect(new Set(cells.map((c) => c.size))).toEqual(new Set([2, 3]))
    expect(cells.every((c) => c.color >= 0 && c.color < 5)).toBe(true)
    expect(cells.map((c) => c.color)).toEqual([...cells.map((c) => c.color)].sort((a, b) => a - b))
  })

  it('建格：尺寸或參數不合理時沒有格子', () => {
    expect(buildGrid(0, 300, opts)).toEqual([])
    expect(buildGrid(100, 100, { ...opts, gap: 0 })).toEqual([])
    expect(buildGrid(100, 100, { ...opts, colorCount: 0 })).toEqual([])
  })

  it('idle 呼吸：每格透明度在 0～30% 之間，而且隨時間變（常駐閃）', () => {
    const cells = buildGrid(200, 100, opts, seeded(7))
    const samples = [0, 250, 500, 1000, 3000].flatMap((t) => cells.map((c) => idleAlpha(c, t)))
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...samples)).toBeLessThanOrEqual(IDLE_ALPHA)
    const at = (t: number) => cells.map((c) => idleAlpha(c, t))
    expect(at(1000)).not.toEqual(at(0))
  })

  it('漣漪半徑隨時間擴開：0 → 結束時大於最遠角落', () => {
    const pulse = makePulse(500, 150, 1000, 300, 1000)
    expect(pulse.reach).toBeCloseTo(Math.hypot(500, 150))
    expect(pulseRadius(pulse, 1000)).toBe(0)
    const mid = pulseRadius(pulse, 1000 + PULSE_MS / 2)
    expect(mid).toBeGreaterThan(0)
    expect(mid).toBeLessThan(pulseRadius(pulse, 1000 + PULSE_MS * 0.9))
    expect(pulseRadius(pulse, 1000 + PULSE_MS)).toBeGreaterThan(pulse.reach)
    expect(isPulsing(pulse, 1000 + PULSE_MS - 1)).toBe(true)
    expect(isPulsing(pulse, 1000 + PULSE_MS)).toBe(false)
  })

  it('點擊漣漪從點擊處擴開：近的格子先亮、遠的後亮', () => {
    const pulse = makePulse(0, 0, 1000, 300, 0)
    const near: Cell = { x: 20, y: 0, size: 2, color: 0, phase: 0, rate: 0 }
    const far: Cell = { x: 900, y: 250, size: 2, color: 0, phase: 0, rate: 0 }
    const firstLit = (cell: Cell) => {
      for (let t = 0; t < PULSE_MS; t += 10) if (pulseGlow(pulse, cell, t) > 0) return t
      return Infinity
    }
    expect(firstLit(near)).toBeLessThan(firstLit(far))
    expect(firstLit(far)).toBeLessThan(PULSE_MS)
    expect(pulseGlow(pulse, near, PULSE_MS)).toBe(0)
  })

  it('tap 模式（手機）沒有 idle：沒漣漪時整張是空的；always 有', () => {
    const cells = buildGrid(200, 100, opts, seeded(3))
    const tap = recorder()
    paint(cells, [], 500, 'tap', tap.painter)
    expect(tap.calls.clear).toBe(1)
    expect(tap.calls.rects).toHaveLength(0)
    const always = recorder()
    paint(cells, [], 500, 'always', always.painter)
    expect(always.calls.rects.length).toBeGreaterThan(0)
    // 依顏色排序後每種顏色只換一次 fillStyle。
    expect(always.calls.colors).toEqual([...new Set(always.calls.colors)])
  })

  it('tap 模式點一下：漣漪經過的格子會亮', () => {
    const cells = buildGrid(200, 100, opts, seeded(3))
    const pulse = makePulse(100, 50, 200, 100, 0)
    const lit = cells.filter((c) => cellAlpha(c, [pulse], PULSE_MS / 2, 'tap') > 0)
    expect(lit.length).toBeGreaterThan(0)
  })

  it('漣漪清單：最多 4 個、結束的拿掉', () => {
    let pulses = [0, 1, 2, 3, 4].map((i) => makePulse(0, 0, 10, 10, i * 100))
    pulses = pulses.reduce((list, p) => addPulse(list, p), [] as typeof pulses)
    expect(pulses.map((p) => p.start)).toEqual([100, 200, 300, 400])
    expect(livePulses(pulses, 100 + PULSE_MS).map((p) => p.start)).toEqual([200, 300, 400])
  })

  it('data-* 參數：照給的讀，格式不對用「疏」那組預設', () => {
    expect(readParams({ colors: '#8DB6E6, #F59A3C', gap: '10', speed: '35' })).toEqual({ colors: ['#8DB6E6', '#F59A3C'], gap: 10, speed: 35 })
    expect(readParams({ colors: 'red;background:url(x)', gap: 'x', speed: '-1' })).toEqual({ colors: ['#8DB6E6'], gap: 10, speed: 35 })
  })
})

/**
 * 假的瀏覽器，給 `mountPixelCanvas`：手動推進 rAF、切分頁隱藏、切畫面內外；
 * 記錄每一幀畫出的最大透明度（idle 最多 0.3，超過代表漣漪還在畫）。
 */
function fakeBrowser() {
  const t = { now: 1000, hidden: false, maxAlpha: 0 }
  const frames = new Map<number, (now: number) => void>()
  const timers = new Map<number, () => void>()
  const hero = new Map<string, (event: unknown) => void>()
  let nextId = 1
  let visibility: () => void = () => {}
  let intersect: (visible: boolean) => void = () => {}
  vi.stubGlobal('performance', { now: () => t.now })
  vi.stubGlobal('document', {
    get hidden() {
      return t.hidden
    },
    addEventListener: (_type: string, cb: () => void) => (visibility = cb),
    removeEventListener() {},
  })
  vi.stubGlobal('window', {
    devicePixelRatio: 1,
    requestAnimationFrame: (cb: (now: number) => void) => (frames.set(nextId, cb), nextId++),
    cancelAnimationFrame: (id: number) => frames.delete(id),
    setTimeout: (cb: () => void) => (timers.set(nextId, cb), nextId++),
    clearTimeout: (id: number) => timers.delete(id),
  })
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
        intersect = (visible) => cb([{ isIntersecting: visible }])
      }
      observe() {
        intersect(true)
      }
      disconnect() {}
    },
  )
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const ctx = {
    globalAlpha: 1,
    fillStyle: '',
    clearRect: () => (t.maxAlpha = 0),
    fillRect(this: { globalAlpha: number }) {
      t.maxAlpha = Math.max(t.maxAlpha, this.globalAlpha)
    },
    setTransform() {},
  }
  const root = {
    dataset: { gap: '10', speed: '35', colors: '#8DB6E6' } as Record<string, string>,
    clientWidth: 1000,
    clientHeight: 300,
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    parentElement: { addEventListener: (n: string, cb: (e: unknown) => void) => hero.set(n, cb), removeEventListener() {} },
  }
  const canvas = { width: 0, height: 0, getContext: () => ctx }
  return {
    t,
    root,
    mount: (mode: 'always' | 'tap') => mountPixelCanvas(root as unknown as HTMLElement, canvas as unknown as HTMLCanvasElement, mode),
    tap: (x: number, y: number) => hero.get('pointerdown')?.({ clientX: x, clientY: y }),
    setHidden(v: boolean) {
      t.hidden = v
      visibility()
    },
    setOnScreen: (v: boolean) => intersect(v),
    /** 推進時間並跑一輪排著的 rAF。 */
    frame(ms: number) {
      t.now += ms
      const pending = [...frames.entries()]
      frames.clear()
      for (const [, cb] of pending) cb(t.now)
    },
  }
}

describe('mountPixelCanvas：暫停後從 idle 重起、不續播漣漪（規格④ §9.5、AC-13；Review #721 P2）', () => {
  afterEach(() => vi.unstubAllGlobals())

  for (const kind of ['分頁隱藏', '捲出畫面'] as const) {
    it(`桌機：點擊後${kind} 200 ms 再回來 → data-state idle、畫面只有 idle 呼吸（≤ 30%）`, () => {
      const b = fakeBrowser()
      const stop = b.mount('always')
      b.tap(20, 20)
      expect(b.root.dataset.state).toBe('pulse')
      if (kind === '分頁隱藏') b.setHidden(true)
      else b.setOnScreen(false)
      expect(b.root.dataset.running).toBe('0')
      expect(b.root.dataset.state).toBe('idle')
      b.t.now += 200
      if (kind === '分頁隱藏') b.setHidden(false)
      else b.setOnScreen(true)
      b.frame(0)
      expect(b.root.dataset.running).toBe('1')
      expect(b.root.dataset.state).toBe('idle')
      expect(b.t.maxAlpha).toBeGreaterThan(0)
      expect(b.t.maxAlpha).toBeLessThanOrEqual(IDLE_ALPHA)
      stop()
    })
  }

  it('手機：點擊後分頁隱藏再回來 → 不續播，回到不跑（data-running 0）', () => {
    const b = fakeBrowser()
    const stop = b.mount('tap')
    expect(b.root.dataset.running).toBe('0')
    b.tap(20, 20)
    expect(b.root.dataset.running).toBe('1')
    b.setHidden(true)
    b.t.now += 200
    b.setHidden(false)
    b.frame(0)
    expect(b.root.dataset.state).toBe('idle')
    expect(b.root.dataset.running).toBe('0')
    expect(b.t.maxAlpha).toBe(0)
    stop()
  })

  it('暫停期間的觸發（例如焦點）不排漣漪', () => {
    const b = fakeBrowser()
    const stop = b.mount('always')
    b.setHidden(true)
    b.tap(20, 20)
    expect(b.root.dataset.state).toBe('idle')
    b.setHidden(false)
    b.frame(0)
    expect(b.t.maxAlpha).toBeLessThanOrEqual(IDLE_ALPHA)
    stop()
  })
})
