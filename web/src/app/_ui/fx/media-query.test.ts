import { describe, expect, it } from 'vitest'
import { FX_QUERY, PIXEL_TOUCH_QUERY, mediaQueryStore } from './media-query'

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

describe('特效的載入條件（規格④ §2.3，沿用 Pixel Trail 的條件）', () => {
  it('條件是：有 hover、精準指標、沒開減少動態', () => {
    expect(FX_QUERY).toBe('(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)')
  })

  it('伺服器端與第一次 hydration 一律 false（不渲染、不下載）', () => {
    const fake = fakeWindow({ [FX_QUERY]: true })
    expect(mediaQueryStore(FX_QUERY, () => fake.win).getServerSnapshot()).toBe(false)
  })

  it('瀏覽器端照 matchMedia 的結果', () => {
    const desktop = fakeWindow({ [FX_QUERY]: true })
    expect(mediaQueryStore(FX_QUERY, () => desktop.win).getSnapshot()).toBe(true)
    const phone = fakeWindow({ [FX_QUERY]: false })
    expect(mediaQueryStore(FX_QUERY, () => phone.win).getSnapshot()).toBe(false)
  })

  it('沒有 window 或沒有 matchMedia（舊瀏覽器）就當作不符合', () => {
    expect(mediaQueryStore(FX_QUERY, () => undefined).getSnapshot()).toBe(false)
    expect(mediaQueryStore(FX_QUERY, () => ({})).getSnapshot()).toBe(false)
    expect(() => mediaQueryStore(FX_QUERY, () => ({})).subscribe(() => {})()).not.toThrow()
  })

  it('訂閱 change：使用者中途開「減少動態」會通知；取消訂閱後拿掉 listener', () => {
    const fake = fakeWindow({ [FX_QUERY]: true })
    const store = mediaQueryStore(FX_QUERY, () => fake.win)
    const seen: boolean[] = []
    const unsubscribe = store.subscribe(() => seen.push(store.getSnapshot()))
    expect(fake.count(FX_QUERY)).toBe(1)
    fake.set(FX_QUERY, false)
    expect(seen).toEqual([false])
    unsubscribe()
    expect(fake.count(FX_QUERY)).toBe(0)
  })

  it('手機觸控版的條件是：粗指標、沒開減少動態（不要求 hover）', () => {
    expect(PIXEL_TOUCH_QUERY).toBe('(pointer: coarse) and (prefers-reduced-motion: no-preference)')
    const phone = fakeWindow({ [FX_QUERY]: false, [PIXEL_TOUCH_QUERY]: true })
    expect(mediaQueryStore(FX_QUERY, () => phone.win).getSnapshot()).toBe(false)
    expect(mediaQueryStore(PIXEL_TOUCH_QUERY, () => phone.win).getSnapshot()).toBe(true)
    expect(mediaQueryStore(PIXEL_TOUCH_QUERY, () => phone.win).getServerSnapshot()).toBe(false)
  })
})
