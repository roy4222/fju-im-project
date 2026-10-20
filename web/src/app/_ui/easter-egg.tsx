'use client'
import './easter-egg.css'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { loadFlyingButton } from '@/app/_ui/dash-theme'
import { EGG_START, EGG_WINDOW_MS, eggClick, eggStage, shouldCountClick, type EggState } from '@/app/_ui/easter-egg-rules'

const MESSAGE = '恭喜發現彩蛋！資管系祝你專題順利 🎉'
const MESSAGE_MS = 6000

type FlyingModule = Awaited<ReturnType<typeof loadFlyingButton>>

/**
 * 頁首 logo＋彩蛋（規格④ 設計方案 §10，規則在 `easter-egg-rules.ts`）：
 * 首頁 5 秒內連點 10 次；第 3 下起 logo 晃並預載 FlyingButton，第 10 下起飛＋訊息。
 * 首頁每一下都 `preventDefault()`（不重新導向、不閃骨架）；首頁以外第 1 下照常回首頁。
 * 減少動態：不晃、不下載 FlyingButton，第 10 下只顯示訊息。
 */
export function EasterEggLogo({ className, children }: { className: string; children: ReactNode }) {
  const pathname = usePathname()
  // 計數綁著路徑：換頁就歸零（回到首頁才從 0 開始算）。
  const [state, setState] = useState({ ...EGG_START, path: pathname })
  const egg = state.path === pathname ? state : EGG_START
  const setEgg = (next: EggState) => setState({ ...next, path: pathname })
  const [message, setMessage] = useState(false)
  const flying = useRef<Promise<FlyingModule> | null>(null)
  const stopFx = useRef<(() => void) | null>(null)
  const linkRef = useRef<HTMLAnchorElement>(null)

  // 卸載時清掉還在飛的分身。
  useEffect(() => () => stopFx.current?.(), [])
  useEffect(() => {
    if (!message) return
    const timer = window.setTimeout(() => setMessage(false), MESSAGE_MS)
    return () => window.clearTimeout(timer)
  }, [message])
  // 超過 5 秒沒點完：晃動停、計數歸零。
  useEffect(() => {
    if (egg.count === 0 || eggStage(egg.count) === 'fire') return
    const timer = window.setTimeout(() => setState((s) => ({ ...s, ...EGG_START })), EGG_WINDOW_MS - (Date.now() - egg.since) + 1)
    return () => window.clearTimeout(timer)
  }, [egg.count, egg.since])

  function onClick(event: MouseEvent<HTMLAnchorElement>) {
    if (!shouldCountClick(pathname, event)) return
    event.preventDefault()
    const next = eggClick(egg, Date.now())
    setEgg(next)
    const stage = eggStage(next.count)
    if (stage === 'idle') return
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
    if (!reduced) flying.current ??= loadFlyingButton()
    if (stage !== 'fire') return
    setMessage(true)
    if (reduced || stopFx.current) return
    const logo = linkRef.current?.querySelector('img')
    void flying.current
      ?.then((m) => {
        if (!logo) return
        stopFx.current = m.launchFlyingButton(logo, () => (stopFx.current = null))
      })
      .catch(() => {})
  }

  const stage = eggStage(egg.count)
  return (
    <>
      <Link
        ref={linkRef}
        href="/"
        onClick={onClick}
        data-egg-count={egg.count}
        className={stage === 'shake' ? `${className} is-shaking` : className}
      >
        {children}
      </Link>
      {message ? (
        <p role="status" data-testid="easter-egg" className="easter-egg-message">
          {MESSAGE}
        </p>
      ) : null}
    </>
  )
}
