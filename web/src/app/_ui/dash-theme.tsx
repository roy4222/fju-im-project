'use client'
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { IconMoon, IconSun } from '@tabler/icons-react'

/**
 * 後台專用深淺色（原型 `components/layout/dash-theme.tsx`；票 35 開啟）。前台固定淺色。
 *
 * - 主題存 localStorage `fju-dash-theme`（跟原型同一個鍵）；只是這台瀏覽器的偏好，不進資料庫。
 * - `dark` class 掛在 `<html>`：對話框、下拉選單、手機側欄抽屜是 portal 到 `<body>` 的，
 *   掛在後台外框上會漏掉它們。`DashThemeRoot` 放在三個角色的 layout（換頁不重掛），
 *   離開後台（回前台）時卸載、把 class 拿掉，前台維持淺色。
 * - 切換動畫：從按鈕位置一圈擴開（View Transitions API）；不支援或 reduced-motion 直接換。
 *   圓心與半徑用 `style.setProperty` 寫 CSS 變數（CSSOM，不是 style 屬性，CSP 不擋）。
 * - 第一次載入是伺服器先畫淺色、瀏覽器讀到偏好後才換深色（原型一樣會閃一下）。
 */

const KEY = 'fju-dash-theme'
const listeners = new Set<() => void>()

function subscribe(cb: () => void) {
  listeners.add(cb)
  window.addEventListener('storage', cb)
  return () => {
    listeners.delete(cb)
    window.removeEventListener('storage', cb)
  }
}

function readDark(): boolean {
  try {
    return localStorage.getItem(KEY) === 'dark'
  } catch {
    return false
  }
}

function writeDark(value: boolean) {
  try {
    localStorage.setItem(KEY, value ? 'dark' : 'light')
  } catch {
    // 無痕模式等存不進去：這次瀏覽仍照樣切換（下面直接改 class）。
  }
  document.documentElement.classList.toggle('dark', value)
  listeners.forEach((l) => l())
}

function useDark() {
  return useSyncExternalStore(subscribe, readDark, () => false)
}

type DocWithViewTransition = Document & {
  startViewTransition?: (cb: () => void) => { finished: Promise<void> }
}

/** 放在後台 layout：依偏好把 `dark` 掛到 `<html>`，離開後台時拿掉。 */
export function DashThemeRoot({ children }: { children: ReactNode }) {
  const dark = useDark()
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
  }, [dark])
  useEffect(() => () => document.documentElement.classList.remove('dark'), [])
  return <>{children}</>
}

/** 頂列的深淺色切換鈕（原型 `DashThemeToggle`）。 */
export function DashThemeToggle() {
  const dark = useDark()
  const busy = useRef(false)

  function toggle(origin: { x: number; y: number }) {
    if (busy.current) return
    const next = !dark
    const doc = document as DocWithViewTransition
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (!doc.startViewTransition || reduced) {
      writeDark(next)
      return
    }
    const r = Math.hypot(Math.max(origin.x, innerWidth - origin.x), Math.max(origin.y, innerHeight - origin.y))
    const root = document.documentElement
    root.style.setProperty('--reveal-x', `${origin.x}px`)
    root.style.setProperty('--reveal-y', `${origin.y}px`)
    root.style.setProperty('--reveal-r', `${r}px`)
    busy.current = true
    // flushSync：快照前就把畫面換好，圓圈裡直接是新顏色。
    const vt = doc.startViewTransition(() => {
      flushSync(() => writeDark(next))
    })
    // 分頁在背景或動畫被打斷時 finished 會 reject；主題已經換好，吞掉即可。
    vt.finished
      .catch(() => {})
      .finally(() => {
        busy.current = false
      })
  }

  return (
    <button
      type="button"
      data-testid="dash-theme-toggle"
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect()
        toggle({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
      }}
      aria-label={dark ? '切換為淺色' : '切換為深色'}
      className="relative inline-flex size-9 items-center justify-center overflow-hidden rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      <IconSun
        aria-hidden
        className={`absolute size-[18px] transition-[transform,opacity] duration-300 ${dark ? 'translate-y-0 opacity-100' : '-translate-y-6 opacity-0'}`}
      />
      <IconMoon
        aria-hidden
        className={`absolute size-[18px] transition-[transform,opacity] duration-300 ${dark ? 'translate-y-6 opacity-0' : 'translate-y-0 opacity-100'}`}
      />
    </button>
  )
}
