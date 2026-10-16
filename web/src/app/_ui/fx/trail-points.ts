/**
 * Pixel Trail 的軌跡點（共用規格 §3.5 做法 (a)）：純資料，沒有 DOM、沒有 WebGL。
 *
 * 座標是 uv：以橫幅長邊為邊長的正方形，0～1，y 朝上（跟 fragment shader 的 `gl_FragCoord` 同方向）。
 * 每幀 `tick` 變老、`pack` 把 (x, y, age, force) 寫進 `Float32Array`，再整包當 `uniform vec4 u_points[64]`
 * 送進 shader；格子亮度在 shader 裡算，CPU 這邊每幀只有這 64 個點的加減。
 */

/** shader 的 `u_points` 長度；插補出來的點也算在內，超過就丟最舊的。 */
export const MAX_POINTS = 64

export type TrailPoint = { x: number; y: number; age: number; force: number }

export type TrailOptions = {
  /** 點活多久（ms）；age ≥ maxAge 就移除。 */
  maxAge: number
  /** 點的最大半徑（uv）。 */
  trailSize: number
  /** 插補密度：兩次指標位置之間每 `trailSize / 2 / interpolate` 補一個點；0 不補。 */
  interpolate: number
}

/** 強度下限：剛進來的第一個點、移動很慢時。 */
const MIN_FORCE = 0.3

export class TrailPoints {
  readonly points: TrailPoint[] = []
  /** 上一個指標位置還算數嗎（`leave` 之後下一次 `add` 不從舊位置補線）。 */
  private connected = false

  constructor(private readonly options: TrailOptions) {}

  /** 指標移到 (x, y)。 */
  add(x: number, y: number): void {
    const last = this.connected ? this.points.at(-1) : undefined
    let force = MIN_FORCE
    if (last) {
      const dx = x - last.x
      const dy = y - last.y
      // 照 React Bits：用距離平方換算強度（慢慢移是淡的、正常速度就滿）。
      force = Math.max(MIN_FORCE, Math.min((dx * dx + dy * dy) * 10000, 1))
      const { trailSize, interpolate } = this.options
      if (interpolate > 0) {
        const spacing = trailSize / 2 / interpolate
        // 一次最多補到上限，免得一大步先產生一堆點再丟掉。
        const steps = Math.min(Math.ceil(Math.hypot(dx, dy) / spacing), MAX_POINTS)
        for (let i = 1; i < steps; i++) {
          this.points.push({ x: last.x + (dx * i) / steps, y: last.y + (dy * i) / steps, age: 0, force })
        }
      }
    }
    this.points.push({ x, y, age: 0, force })
    this.connected = true
    if (this.points.length > MAX_POINTS) this.points.splice(0, this.points.length - MAX_POINTS)
  }

  /** 指標離開橫幅（或視窗失焦）。 */
  leave(): void {
    this.connected = false
  }

  /** 經過 `deltaMs`：每個點變老，age ≥ maxAge 的移除。 */
  tick(deltaMs: number): void {
    let kept = 0
    for (const point of this.points) {
      point.age += deltaMs
      if (point.age < this.options.maxAge) this.points[kept++] = point
    }
    this.points.length = kept
  }

  /** 沒有活著的點：可以停 `requestAnimationFrame`，下一次指標移動再叫醒。 */
  isIdle(): boolean {
    return this.points.length === 0
  }

  clear(): void {
    this.points.length = 0
    this.connected = false
  }

  /** 所有點的外框（uv），每邊再外擴 `margin`。沒有點時是空框（min > max）。 */
  bounds(margin = 0): { minX: number; minY: number; maxX: number; maxY: number } {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const { x, y } of this.points) {
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
    }
    return { minX: minX - margin, minY: minY - margin, maxX: maxX + margin, maxY: maxY + margin }
  }

  /** 依序寫入 (x, y, age, force)，回傳點數。`out` 至少要 `MAX_POINTS * 4` 長。 */
  pack(out: Float32Array): number {
    this.points.forEach((point, i) => {
      out[i * 4] = point.x
      out[i * 4 + 1] = point.y
      out[i * 4 + 2] = point.age
      out[i * 4 + 3] = point.force
    })
    return this.points.length
  }
}
