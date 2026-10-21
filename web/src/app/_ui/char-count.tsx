'use client'
import { useEffect, useState, type FormEvent } from 'react'
import { cn } from '@/shared/cn'
import { charLength } from '@/shared/text'

/**
 * 輸入框下方的「n／上限 字」（CL-4）：以字計（code point，同伺服器的 `charLength`），emoji 算一個字。
 *
 * 取代原生 `maxLength`：瀏覽器的 `maxLength` 按 UTF-16 算，emoji 會比後端早被擋。這裡不截字（不打斷輸入法組字），
 * 超過時字數變紅並說超過幾字；真正的上限仍由伺服器判、錯誤訊息照舊。
 *
 * - 受控欄位傳 `value`；不受控欄位不傳，元件自己聽 `forId` 那一欄的 `input` 與所屬表單的 `reset`。
 * - 欄位加 `aria-describedby={charCountId(forId)}`，螢幕報讀唸得到字數。
 */
/**
 * 不受控欄位送出前先擋超過上限（CL-4）：React 19 的 `<form action>` 跑完一律重設表單，等伺服器回「最多 N 字」時打的字已被清空。
 * 超過就 `preventDefault()`（action 不跑、表單不重設），回傳要顯示的訊息（跟伺服器同一句）；沒超過回 null。
 */
export function blockOverLimit(event: FormEvent<HTMLFormElement>, field: string, max: number, message: string): string | null {
  const value = new FormData(event.currentTarget).get(field)
  if (typeof value !== 'string' || charLength(value.trim()) <= max) return null
  event.preventDefault()
  return message
}

export function charCountId(forId: string): string {
  return `${forId}-count`
}

export function CharCount({ forId, max, value }: { forId: string; max: number; value?: string }) {
  const [typed, setTyped] = useState('')
  const controlled = value !== undefined

  useEffect(() => {
    if (controlled) return
    const el = document.getElementById(forId) as HTMLInputElement | HTMLTextAreaElement | null
    if (!el) return
    const read = () => setTyped(el.value)
    // 表單 reset 之後值才變，`input` 不會觸發：等這一輪結束再讀。
    const onReset = () => window.setTimeout(read, 0)
    read()
    el.addEventListener('input', read)
    el.form?.addEventListener('reset', onReset)
    return () => {
      el.removeEventListener('input', read)
      el.form?.removeEventListener('reset', onReset)
    }
  }, [forId, controlled])

  const count = charLength(controlled ? value : typed)
  const over = count - max
  return (
    <p
      id={charCountId(forId)}
      data-testid="char-count"
      className={cn('mt-1 text-right text-xs tabular-nums', over > 0 ? 'font-semibold text-destructive' : 'text-muted-foreground')}
    >
      {count}／{max} 字{over > 0 ? `（超過 ${over} 字）` : ''}
    </p>
  )
}
