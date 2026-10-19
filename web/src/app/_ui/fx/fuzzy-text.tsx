'use client'
import { useEffect } from 'react'

/**
 * 404／403「壞掉」頁的特效載入器（規格④ §6）：三段字與按鈕由伺服器輸出（`broken-page.tsx`），
 * 這裡只在沒開「減少動態」時 `import()` 引擎（`fuzzy-engine.ts`，另切 chunk）掛上 canvas 與按鈕抖動。
 * 根層 not-found 的 client 程式會進每條路由的首載，所以這支要越小越好（C4-05 主腦裁定 `$shared` ≤ +0.1 KB）。
 */
export function BrokenFx() {
  useEffect(() => {
    if (!matchMedia('(prefers-reduced-motion: no-preference)').matches) return
    let stop: (() => void) | undefined
    let dead = false
    void document.fonts.ready
      .then(() => import('./fuzzy-engine'))
      .then((m) => {
        if (!dead) stop = m.mountBrokenFx(document)
      })
    return () => {
      dead = true
      stop?.()
    }
  }, [])
  return null
}
