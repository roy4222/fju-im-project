import { describe, expect, it } from 'vitest'
import { startFrameLoop, type LoopEnv } from './frame-loop'

/** 假的瀏覽器：手動推進 rAF（每次 16.7 ms＝60 Hz）、切畫面內外、切分頁隱藏。 */
function fakeEnv() {
  let now = 0
  let nextId = 1
  const frames = new Map<number, (now: number) => void>()
  let observer: ((onScreen: boolean) => void) | undefined
  let visibility: (() => void) | undefined
  let hidden = false
  const env: LoopEnv = {
    requestFrame(cb) {
      frames.set(nextId, cb)
      return nextId++
    },
    cancelFrame: (id) => void frames.delete(id),
    observe(_el, cb) {
      observer = cb
      return () => (observer = undefined)
    },
    isHidden: () => hidden,
    onVisibilityChange(cb) {
      visibility = cb
      return () => (visibility = undefined)
    },
  }
  return {
    env,
    /** 推進 n 個 60 Hz 的幀。 */
    advance(n: number) {
      for (let i = 0; i < n; i++) {
        now += 1000 / 60
        const pending = [...frames.entries()]
        frames.clear()
        for (const [, cb] of pending) cb(now)
      }
    },
    setOnScreen: (v: boolean) => observer?.(v),
    setHidden(v: boolean) {
      hidden = v
      visibility?.()
    },
    pending: () => frames.size,
    listening: () => observer !== undefined || visibility !== undefined,
  }
}

const el = {} as Element

describe('frame-loop：共用 rAF 迴圈（規格④ §9.5）', () => {
  it('fps 30：60 Hz 的 rAF 每兩幀才 tick 一次', () => {
    const fake = fakeEnv()
    let ticks = 0
    startFrameLoop(el, () => ticks++, { fps: 30, env: fake.env })
    fake.advance(60)
    expect(ticks).toBe(30)
  })

  it('fps 20：每三幀 tick 一次（效能退路第一步）', () => {
    const fake = fakeEnv()
    let ticks = 0
    startFrameLoop(el, () => ticks++, { fps: 20, env: fake.env })
    fake.advance(60)
    expect(ticks).toBe(20)
  })

  it('分頁隱藏時 tick 不呼叫、也不排 rAF；回來從頭起，第一幀 dt 是一格的時間（不補播）', () => {
    const fake = fakeEnv()
    const dts: number[] = []
    const running: boolean[] = []
    startFrameLoop(el, (dt) => dts.push(dt), { fps: 30, env: fake.env, onRunningChange: (r) => running.push(r) })
    fake.advance(4)
    fake.setHidden(true)
    const before = dts.length
    expect(fake.pending()).toBe(0)
    fake.advance(120)
    expect(dts.length).toBe(before)
    fake.setHidden(false)
    fake.advance(1)
    expect(dts.at(-1)).toBeCloseTo(1000 / 30)
    expect(running).toEqual([true, false, true])
  })

  it('離開視窗（IntersectionObserver）時暫停，回來再起', () => {
    const fake = fakeEnv()
    let ticks = 0
    const loop = startFrameLoop(el, () => ticks++, { env: fake.env })
    fake.setOnScreen(false)
    expect(loop.isRunning()).toBe(false)
    fake.advance(30)
    expect(ticks).toBe(0)
    fake.setOnScreen(true)
    expect(loop.isRunning()).toBe(true)
    fake.advance(2)
    expect(ticks).toBe(1)
  })

  it('一開始隱藏就不跑，並回報 running=false', () => {
    const fake = fakeEnv()
    fake.setHidden(true)
    const running: boolean[] = []
    let ticks = 0
    startFrameLoop(el, () => ticks++, { env: fake.env, onRunningChange: (r) => running.push(r) })
    fake.advance(10)
    expect(ticks).toBe(0)
    expect(running).toEqual([false])
  })

  it('active=false 不跑；setActive(true) 才開始（手機點擊漣漪）', () => {
    const fake = fakeEnv()
    let ticks = 0
    const loop = startFrameLoop(el, () => ticks++, { active: false, env: fake.env })
    fake.advance(10)
    expect(ticks).toBe(0)
    loop.setActive(true)
    fake.advance(2)
    expect(ticks).toBe(1)
    loop.setActive(false)
    fake.advance(10)
    expect(ticks).toBe(1)
  })

  it('stop：不再 tick、拿掉觀察者與 visibilitychange', () => {
    const fake = fakeEnv()
    let ticks = 0
    const loop = startFrameLoop(el, () => ticks++, { env: fake.env })
    loop.stop()
    fake.advance(10)
    expect(ticks).toBe(0)
    expect(fake.listening()).toBe(false)
    loop.setActive(true)
    expect(loop.isRunning()).toBe(false)
  })
})
