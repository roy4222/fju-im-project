import { useSyncExternalStore } from 'react'

/**
 * 特效的完整版載入條件（規格④ §2.3，沿用 Pixel Trail 的條件）：有滑鼠（hover＋精準指標）而且沒開「減少動態」。
 * 開了減少動態的人連 chunk 都不下載（`hero-pixel.tsx` 不符合時不渲染、不 `import()`）。
 */
export const FX_QUERY = '(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)'

/** 手機、觸控（粗指標）而且沒開「減少動態」：Pixel 不常駐閃，只留點擊漣漪（規格④ §2.2）。 */
export const PIXEL_TOUCH_QUERY = '(pointer: coarse) and (prefers-reduced-motion: no-preference)'

type MediaWindow = {
  matchMedia?: (query: string) => {
    readonly matches: boolean
    addEventListener(type: 'change', cb: () => void): void
    removeEventListener(type: 'change', cb: () => void): void
  }
}

/**
 * `useSyncExternalStore` 用的三個函式。`getWindow` 抽出來是為了單元測試（node 環境沒有 window）。
 * 伺服器端與第一次 hydration 回 false，所以 SSR 不會畫出特效、也不會先載 chunk。
 */
export function mediaQueryStore(query: string, getWindow: () => MediaWindow | undefined) {
  const list = () => getWindow()?.matchMedia?.(query)
  return {
    subscribe(cb: () => void) {
      const mq = list()
      mq?.addEventListener('change', cb)
      return () => mq?.removeEventListener('change', cb)
    },
    getSnapshot: () => list()?.matches ?? false,
    getServerSnapshot: () => false,
  }
}

const browserWindow = () => (typeof window === 'undefined' ? undefined : window)
const fxStore = mediaQueryStore(FX_QUERY, browserWindow)
const touchStore = mediaQueryStore(PIXEL_TOUCH_QUERY, browserWindow)

/** 這台裝置該不該掛完整特效（常駐動畫）。使用者中途改系統設定會跟著變。 */
export function useFxAllowed(): boolean {
  return useSyncExternalStore(fxStore.subscribe, fxStore.getSnapshot, fxStore.getServerSnapshot)
}

/** 這台裝置是不是「觸控、沒開減少動態」（Pixel 只留點擊漣漪）。 */
export function usePixelTouchAllowed(): boolean {
  return useSyncExternalStore(touchStore.subscribe, touchStore.getSnapshot, touchStore.getServerSnapshot)
}

/** 首頁掛上後才訂閱；與 React hooks 共用相同條件，換頁時由呼叫端取消。 */
function subscribePixelMode(onChange: (mode: 'always' | 'tap' | null) => void): () => void {
  let previous: 'always' | 'tap' | null | undefined
  const update = () => {
    const mode = fxStore.getSnapshot() ? 'always' : touchStore.getSnapshot() ? 'tap' : null
    if (mode === previous) return
    previous = mode
    onChange(mode)
  }
  const stopFx = fxStore.subscribe(update)
  const stopTouch = touchStore.subscribe(update)
  update()
  return () => {
    stopFx()
    stopTouch()
  }
}

/** 條件改變就換模式／移除；舊模式的引擎下載晚到時，不得重新掛回。 */
export function observeHomePixel(marker: Element, loadPixel: () => Promise<typeof import('./home-hero-pixel')>): () => void {
  let stop: (() => void) | undefined
  let dead = false
  let revision = 0
  const unsubscribe = subscribePixelMode((mode) => {
    const current = ++revision
    stop?.()
    stop = undefined
    if (!mode) return
    void loadPixel().then((pixel) => {
      if (!dead && current === revision) stop = pixel.mountHomeHeroPixel(marker, mode)
    })
  })
  return () => {
    dead = true
    unsubscribe()
    stop?.()
  }
}
