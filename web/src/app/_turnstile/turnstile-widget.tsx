'use client'
import { useEffect, useRef } from 'react'

/** `api.js` 掛在 window 上的那幾個方法（只列用到的）。 */
type TurnstileApi = {
  render: (container: HTMLElement, options: Record<string, unknown>) => string | undefined
  reset: (widgetId: string) => void
  remove: (widgetId: string) => void
}

declare global {
  interface Window {
    turnstile?: TurnstileApi
  }
}

/** 等 `api.js` 載入的上限；被擋或斷線時不要一直輪詢。 */
const LOAD_WAIT_MS = 20_000
const POLL_MS = 50

/**
 * explicit render 的 widget。token 寫進同一個 `<form>` 的隱藏欄 `cf-turnstile-response`。
 *
 * token 只能驗一次（Cloudflare siteverify），所以表單每送出一次就 `reset()` 取新的——
 * 重寄驗證碼這類會在同一頁送很多次的表單才不會第二次就被擋。reset 延到下一輪事件，
 * React 送 Server Action 時已經先把表單內容讀走了。
 */
export function TurnstileWidget({ siteKey, action }: { siteKey: string; action: string }) {
  const container = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const element = container.current
    if (!element) return
    let widgetId: string | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let cancelled = false
    const startedAt = Date.now()

    const mount = () => {
      if (cancelled) return
      const api = window.turnstile
      if (!api) {
        if (Date.now() - startedAt < LOAD_WAIT_MS) timer = setTimeout(mount, POLL_MS)
        return
      }
      widgetId = api.render(element, {
        sitekey: siteKey,
        action,
        'response-field-name': 'cf-turnstile-response',
        language: 'zh-tw',
      })
    }
    mount()

    const form = element.closest('form')
    const onSubmit = () => {
      setTimeout(() => {
        if (widgetId) window.turnstile?.reset(widgetId)
      }, 0)
    }
    form?.addEventListener('submit', onSubmit)

    return () => {
      cancelled = true
      clearTimeout(timer)
      form?.removeEventListener('submit', onSubmit)
      if (widgetId) window.turnstile?.remove(widgetId)
    }
  }, [siteKey, action])

  return <div ref={container} className="min-h-[65px]" data-turnstile-action={action} aria-label="人機驗證" role="group" />
}
