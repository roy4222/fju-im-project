'use client'
import './fx/letter-glitch.css'
import dynamic from 'next/dynamic'
import { usePathname } from 'next/navigation'
import { useCallback, useState, useSyncExternalStore } from 'react'
import { mediaQueryStore } from './fx/media-query'

/** WebGL2 引擎另切 chunk，只在瀏覽器、可以動的時候才下載（規格④ §9.3）。 */
const LetterGlitch = dynamic(() => import('./fx/letter-glitch').then((m) => m.LetterGlitch), { ssr: false })

const motionStore = mediaQueryStore('(prefers-reduced-motion: no-preference)', () =>
  typeof window === 'undefined' ? undefined : window,
)

/**
 * 登入／註冊群組的整頁背景（規格④ §4.1）：放在 `login`、`register`、`reset-password` 的 `layout.tsx`，
 * 群組內換頁不重掛（註冊三步之間是同一張 canvas）。`exclude` 裡的路徑（含子路徑）不鋪背景。
 *
 * 外層 `.auth-glitch` 伺服器就畫（底色 #13305C 不閃白）；開了減少動態、WebGL2 不支援或 context 掉了，
 * 不掛 canvas、改 `.auth-glitch-static` 靜態字元紋理（伺服器端與第一次 hydration 也先是紋理）。
 */
export function AuthGlitch({ exclude = [] }: { exclude?: readonly string[] }) {
  const pathname = usePathname()
  const motion = useSyncExternalStore(motionStore.subscribe, motionStore.getSnapshot, motionStore.getServerSnapshot)
  const [failed, setFailed] = useState(false)
  const onFail = useCallback(() => setFailed(true), [])
  if (exclude.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return null
  const live = motion && !failed
  return (
    <div
      className={live ? 'auth-glitch' : 'auth-glitch auth-glitch-static'}
      aria-hidden="true"
      data-testid="letter-glitch"
      data-colors="#E8B544,#F08F3A,#8DB6E6"
    >
      {live ? <LetterGlitch onFail={onFail} /> : null}
    </div>
  )
}
