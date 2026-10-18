/**
 * 共用的 requestAnimationFrame 迴圈（規格④ 設計方案 §9.5）：fps 節流、畫面外暫停、分頁隱藏暫停。
 * 回到視窗／分頁時從頭起（第一幀 dt 當一格的時間），不補播中間錯過的幀。
 * `env` 抽出來是為了單元測試（node 環境沒有 rAF、IntersectionObserver、document）。
 */
export type LoopEnv = {
  requestFrame(cb: (now: number) => void): number
  cancelFrame(id: number): void
  /** 觀察 `el` 在不在視窗裡（IntersectionObserver threshold 0）；回傳取消函式。 */
  observe(el: Element, cb: (onScreen: boolean) => void): () => void
  isHidden(): boolean
  onVisibilityChange(cb: () => void): () => void
}

export type FrameLoopOptions = {
  /** 每秒最多幾幀（預設 30）。 */
  fps?: number
  /** 一開始要不要跑（預設 true）；手機只在點擊漣漪期間 `setActive(true)`。 */
  active?: boolean
  /** 實際在跑（想跑＋在畫面上＋分頁可見）與否改變時通知，給 `data-running` 用。 */
  onRunningChange?: (running: boolean) => void
  env?: LoopEnv
}

export type FrameLoop = {
  setActive(active: boolean): void
  isRunning(): boolean
  stop(): void
}

export function browserLoopEnv(): LoopEnv {
  return {
    requestFrame: (cb) => window.requestAnimationFrame(cb),
    cancelFrame: (id) => window.cancelAnimationFrame(id),
    observe(el, cb) {
      const io = new IntersectionObserver((entries) => cb(entries.some((e) => e.isIntersecting)), { threshold: 0 })
      io.observe(el)
      return () => io.disconnect()
    },
    isHidden: () => document.hidden,
    onVisibilityChange(cb) {
      document.addEventListener('visibilitychange', cb)
      return () => document.removeEventListener('visibilitychange', cb)
    },
  }
}

/**
 * 開始一個迴圈：`tick(dt, now)` 最多每 1000/fps ms 呼叫一次。
 * 在 IntersectionObserver 第一次回報之前當作在畫面上（掛載時通常看得到）。
 */
export function startFrameLoop(el: Element, tick: (dt: number, now: number) => void, options: FrameLoopOptions = {}): FrameLoop {
  const env = options.env ?? browserLoopEnv()
  const interval = 1000 / (options.fps ?? 30)
  let active = options.active ?? true
  let onScreen = true
  let alive = true
  let raf = 0
  let last = 0
  let running = false

  const frame = (now: number) => {
    raf = 0
    if (!running) return
    // 容許 2 ms 誤差：60 Hz 的 rAF 在 30 fps 時剛好每兩幀跑一次。
    if (last && now - last < interval - 2) {
      raf = env.requestFrame(frame)
      return
    }
    const dt = last ? now - last : interval
    last = now
    tick(dt, now)
    if (running && !raf) raf = env.requestFrame(frame)
  }

  const update = () => {
    const next = alive && active && onScreen && !env.isHidden()
    if (next === running) return
    running = next
    if (running) {
      last = 0
      raf = env.requestFrame(frame)
    } else if (raf) {
      env.cancelFrame(raf)
      raf = 0
    }
    options.onRunningChange?.(running)
  }

  const unobserve = env.observe(el, (visible) => {
    onScreen = visible
    update()
  })
  const unlisten = env.onVisibilityChange(update)
  update()
  if (!running) options.onRunningChange?.(false)

  return {
    setActive(next) {
      active = next
      update()
    },
    isRunning: () => running,
    stop() {
      alive = false
      update()
      unobserve()
      unlisten()
    },
  }
}
