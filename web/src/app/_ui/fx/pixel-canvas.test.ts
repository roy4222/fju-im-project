import { describe, expect, it } from 'vitest'
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
