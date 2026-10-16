import { useSyncExternalStore } from 'react'

/**
 * Pixel Trail 的載入條件（共用規格 §3.5）：有滑鼠（hover＋精準指標）而且沒開「減少動態」。
 * 手機、觸控、開了減少動態的人連 chunk 都不下載（`hero-trail.tsx` 不符合時不渲染 `next/dynamic` 的元件）。
 */
export const TRAIL_QUERY = '(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)'

type MediaWindow = {
  matchMedia?: (query: string) => {
    readonly matches: boolean
    addEventListener(type: 'change', cb: () => void): void
    removeEventListener(type: 'change', cb: () => void): void
  }
}

/**
 * `useSyncExternalStore` 用的三個函式。`getWindow` 抽出來是為了單元測試（node 環境沒有 window）。
 * 伺服器端與第一次 hydration 回 false，所以 SSR 不會畫出拖尾、也不會先載 chunk。
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
const trailStore = mediaQueryStore(TRAIL_QUERY, browserWindow)

/** 這台裝置該不該掛 Pixel Trail。使用者中途改系統設定會跟著變。 */
export function useTrailAllowed(): boolean {
  return useSyncExternalStore(trailStore.subscribe, trailStore.getSnapshot, trailStore.getServerSnapshot)
}
