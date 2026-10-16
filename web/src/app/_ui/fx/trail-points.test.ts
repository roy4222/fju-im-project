import { describe, expect, it } from 'vitest'
import { MAX_POINTS, TrailPoints } from './trail-points'

const opts = { maxAge: 800, trailSize: 0.05, interpolate: 2 }

/** 沿 x 軸每次走 `step`，共 `n` 次（不會觸發插補的小步）。 */
function walk(trail: TrailPoints, n: number, step = 0.001) {
  for (let i = 0; i < n; i++) trail.add(0.1 + i * step, 0.5)
}

describe('TrailPoints 軌跡點（AC-SH-65）', () => {
  it('點數上限 64：超過時丟最舊的', () => {
    const trail = new TrailPoints(opts)
    walk(trail, 100)
    expect(MAX_POINTS).toBe(64)
    expect(trail.points).toHaveLength(64)
    // 留下來的是最後 64 個：第一個是第 37 次（索引 36）的位置，最後一個是第 100 次。
    expect(trail.points[0]?.x).toBeCloseTo(0.1 + 36 * 0.001)
    expect(trail.points.at(-1)?.x).toBeCloseTo(0.1 + 99 * 0.001)
  })

  it('插補也算進上限：一大步補出來的點不會讓總數超過 64', () => {
    const trail = new TrailPoints(opts)
    trail.add(0, 0.5)
    trail.add(1, 0.5)
    expect(trail.points).toHaveLength(64)
    expect(trail.points.at(-1)?.x).toBe(1)
  })

  it('兩次之間距離超過間距時補點，補出來的點間距不超過 trailSize / 2 / interpolate', () => {
    const trail = new TrailPoints(opts)
    trail.add(0.1, 0.5)
    trail.add(0.15, 0.5)
    const spacing = opts.trailSize / 2 / opts.interpolate
    const xs = trail.points.map((p) => p.x)
    expect(xs[0]).toBe(0.1)
    expect(xs.at(-1)).toBe(0.15)
    expect(xs.length).toBe(Math.ceil((0.15 - 0.1) / spacing) + 1)
    for (let i = 1; i < xs.length; i++) {
      const prev = xs[i - 1] ?? 0
      const cur = xs[i] ?? 0
      expect(cur).toBeGreaterThan(prev)
      expect(cur - prev).toBeLessThanOrEqual(spacing + 1e-9)
    }
  })

  it('指標離開後再進來是新的一筆，不會從離開的位置補一條線過來', () => {
    const trail = new TrailPoints(opts)
    trail.add(0.1, 0.5)
    trail.leave()
    trail.add(0.9, 0.5)
    expect(trail.points.map((p) => p.x)).toEqual([0.1, 0.9])
  })

  it('tick 讓每個點變老；age ≥ maxAge 的點被移除', () => {
    const trail = new TrailPoints(opts)
    trail.add(0.1, 0.5)
    trail.tick(500)
    trail.add(0.101, 0.5)
    expect(trail.points.map((p) => p.age)).toEqual([500, 0])
    trail.tick(300)
    // 第一個剛好 800（= maxAge）→ 移除；第二個 300 還在。
    expect(trail.points.map((p) => p.age)).toEqual([300])
    trail.tick(499)
    expect(trail.points).toHaveLength(1)
    trail.tick(1)
    expect(trail.points).toHaveLength(0)
  })

  it('指標離開且全部過期時 isIdle() 為 true；還有活著的點時為 false', () => {
    const trail = new TrailPoints(opts)
    expect(trail.isIdle()).toBe(true)
    walk(trail, 5)
    expect(trail.isIdle()).toBe(false)
    trail.leave()
    trail.tick(799)
    expect(trail.isIdle()).toBe(false)
    trail.tick(1)
    expect(trail.isIdle()).toBe(true)
  })

  it('指標停在橫幅裡不動、點也全部過期時同樣閒置（不動就沒有新點，沒必要一直畫）', () => {
    const trail = new TrailPoints(opts)
    walk(trail, 3)
    trail.tick(800)
    expect(trail.isIdle()).toBe(true)
  })

  it('force：移動距離換算的強度，介於 0.3～1', () => {
    const trail = new TrailPoints(opts)
    trail.add(0.5, 0.5)
    trail.add(0.5001, 0.5) // 很小一步 → 下限 0.3
    trail.add(0.52, 0.5) // 正常一步 → 1
    const forces = trail.points.map((p) => p.force)
    expect(forces[0]).toBe(0.3)
    expect(forces[1]).toBe(0.3)
    expect(forces.at(-1)).toBe(1)
  })

  it('pack 依序寫入 (x, y, age, force)，回傳點數；多出來的位置不動', () => {
    const trail = new TrailPoints(opts)
    trail.add(0.25, 0.75)
    trail.tick(100)
    const out = new Float32Array(MAX_POINTS * 4).fill(-1)
    expect(trail.pack(out)).toBe(1)
    expect(Array.from(out.slice(0, 4))).toEqual([0.25, 0.75, 100, Math.fround(0.3)])
    expect(out[4]).toBe(-1)
  })

  it('bounds：所有點的外框再外擴 margin；沒有點時是空框', () => {
    const trail = new TrailPoints(opts)
    const empty = trail.bounds(0.1)
    expect(empty.minX).toBeGreaterThan(empty.maxX)
    trail.add(0.2, 0.6)
    trail.leave()
    trail.add(0.4, 0.3)
    const box = trail.bounds(0.05)
    expect(box.minX).toBeCloseTo(0.15)
    expect(box.maxX).toBeCloseTo(0.45)
    expect(box.minY).toBeCloseTo(0.25)
    expect(box.maxY).toBeCloseTo(0.65)
  })

  it('clear 清掉全部點', () => {
    const trail = new TrailPoints(opts)
    walk(trail, 10)
    trail.clear()
    expect(trail.points).toHaveLength(0)
    expect(trail.isIdle()).toBe(true)
  })
})
