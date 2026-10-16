import { describe, expect, it } from 'vitest'
import { TRAIL_QUERY, mediaQueryStore } from './media-query'

/** 假的 `window.matchMedia`：記錄訂閱，`set` 模擬使用者改了系統設定。 */
function fakeWindow(initial: Record<string, boolean>) {
  const state = { ...initial }
  const listeners = new Map<string, Set<() => void>>()
  const win = {
    matchMedia(query: string) {
      return {
        get matches() {
          return state[query] ?? false
        },
        addEventListener(_type: 'change', cb: () => void) {
          if (!listeners.has(query)) listeners.set(query, new Set())
          listeners.get(query)?.add(cb)
        },
        removeEventListener(_type: 'change', cb: () => void) {
          listeners.get(query)?.delete(cb)
        },
      }
    },
  }
  return {
    win,
    set(query: string, value: boolean) {
      state[query] = value
      listeners.get(query)?.forEach((cb) => cb())
    },
    count: (query: string) => listeners.get(query)?.size ?? 0,
  }
}

describe('Pixel Trail 的載入條件（共用規格 §3.5）', () => {
  it('條件是：有 hover、精準指標、沒開減少動態', () => {
    expect(TRAIL_QUERY).toBe('(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)')
  })

  it('伺服器端與第一次 hydration 一律 false（不渲染、不下載）', () => {
    const fake = fakeWindow({ [TRAIL_QUERY]: true })
    expect(mediaQueryStore(TRAIL_QUERY, () => fake.win).getServerSnapshot()).toBe(false)
  })

  it('瀏覽器端照 matchMedia 的結果', () => {
    const desktop = fakeWindow({ [TRAIL_QUERY]: true })
    expect(mediaQueryStore(TRAIL_QUERY, () => desktop.win).getSnapshot()).toBe(true)
    const phone = fakeWindow({ [TRAIL_QUERY]: false })
    expect(mediaQueryStore(TRAIL_QUERY, () => phone.win).getSnapshot()).toBe(false)
  })

  it('沒有 window 或沒有 matchMedia（舊瀏覽器）就當作不符合', () => {
    expect(mediaQueryStore(TRAIL_QUERY, () => undefined).getSnapshot()).toBe(false)
    expect(mediaQueryStore(TRAIL_QUERY, () => ({})).getSnapshot()).toBe(false)
    expect(() => mediaQueryStore(TRAIL_QUERY, () => ({})).subscribe(() => {})()).not.toThrow()
  })

  it('訂閱 change：使用者中途開「減少動態」會通知；取消訂閱後拿掉 listener', () => {
    const fake = fakeWindow({ [TRAIL_QUERY]: true })
    const store = mediaQueryStore(TRAIL_QUERY, () => fake.win)
    const seen: boolean[] = []
    const unsubscribe = store.subscribe(() => seen.push(store.getSnapshot()))
    expect(fake.count(TRAIL_QUERY)).toBe(1)
    fake.set(TRAIL_QUERY, false)
    expect(seen).toEqual([false])
    unsubscribe()
    expect(fake.count(TRAIL_QUERY)).toBe(0)
  })
})
