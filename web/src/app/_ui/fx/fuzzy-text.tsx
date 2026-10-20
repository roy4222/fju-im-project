import { useEffect } from 'react'

/**
 * 404／403「壞掉」頁的特效載入器（規格④ §6）：三段字與按鈕全由伺服器輸出（`broken-page.tsx`，純 server），
 * 頁面上有 `[data-broken-fx]` 而且沒開「減少動態」時才 `import()` 引擎（`fuzzy-engine.ts`，另切 chunk）。
 * 掛在每頁都有的 `SiteHeader` 裡；`import()` 本身寫在 `dash-theme.tsx`（`loadBrokenFx`）：後台 layout 也載那支，
 * 延遲載入樁跟深淺色切換放在一起才不會讓 Turbopack 把 tabler＋深淺色那個 chunk 拆成兩份（後台每條 +1.8 KB）。
 * 另外：根層 not-found 若自己帶 client 元件，Turbopack 會為它另建 chunk、
 * 把頁首的模組重複打包進每條路由的首載（C4-05 量測，主腦裁定選項 1）。這支要越小越好（上限 0.25 KB）。
 */
export function useBrokenFx(load: () => Promise<typeof import('./fuzzy-engine')>) {
  useEffect(() => {
    const root = document.querySelector('[data-broken-fx]')
    if (!root || !matchMedia('(prefers-reduced-motion: no-preference)').matches) return
    let stop: (() => void) | undefined
    let dead = false
    void document.fonts.ready
      .then(load)
      .then((m) => {
        if (!dead) stop = m.mountBrokenFx(root)
      })
    return () => {
      dead = true
      stop?.()
    }
  }, [load])
}
