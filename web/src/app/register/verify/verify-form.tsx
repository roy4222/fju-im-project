'use client'
import { useActionState, useEffect, useRef, useState, type ReactNode } from 'react'
import { OtpInput } from '../_components/otp-input'
import { isCompleteOtp } from '../_components/signup-checks'
import type { ResendFormState, VerifyFormState } from '../_components/form-data'

/** 重寄冷卻（伺服器 hook 一樣擋 120 秒；這裡只是顯示）。 */
export const RESEND_SECONDS = 120

/**
 * 第 2 步的填碼表單：6 格填滿就自動送出；錯了清空重填。
 */
export function VerifyForm({
  action,
  mode,
}: {
  action: (state: VerifyFormState, formData: FormData) => Promise<VerifyFormState>
  mode: 'signup' | 'resume'
}) {
  const [state, formAction, pending] = useActionState(action, undefined)
  const [code, setCode] = useState('')
  const form = useRef<HTMLFormElement>(null)
  const lastSubmitted = useRef('')

  // 伺服器回錯：清空，讓人重填（AC-VI-47「欄位清空」）。
  useEffect(() => {
    if (!state?.attempt) return
    setCode('')
    lastSubmitted.current = ''
  }, [state?.attempt])

  // 6 碼填滿自動送出（同一串不重送）。
  useEffect(() => {
    if (!isCompleteOtp(code) || pending || lastSubmitted.current === code) return
    lastSubmitted.current = code
    form.current?.requestSubmit()
  }, [code, pending])

  return (
    <form ref={form} action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="otp" value={code} />
      <input type="hidden" name="mode" value={mode} />
      <OtpInput value={code} onChange={setCode} invalid={Boolean(state?.error)} describedBy={state?.error ? 'otp-error' : undefined} />
      {state?.error ? (
        <p id="otp-error" role="alert" className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger-on-subtle">
          {state.error}
        </p>
      ) : null}
      <button type="submit" disabled={pending} className="btn-fju h-12 w-full text-base">
        {pending ? '驗證中…' : '驗證'}
      </button>
    </form>
  )
}

/**
 * 「重寄驗證碼」：載入時與每次寄出後倒數 120 秒，倒數中按鈕 disabled。
 * Turnstile 由頁面當 `turnstile` 傳進來（每次送出後 widget 自己 reset 拿新 token）。
 */
export function ResendForm({
  action,
  turnstile,
}: {
  action: (state: ResendFormState, formData: FormData) => Promise<ResendFormState>
  turnstile?: ReactNode
}) {
  const [state, formAction, pending] = useActionState(action, undefined)
  const [left, setLeft] = useState(RESEND_SECONDS)

  useEffect(() => {
    if (state?.sentAt) setLeft(RESEND_SECONDS)
  }, [state?.sentAt])

  useEffect(() => {
    if (left <= 0) return
    const timer = setTimeout(() => setLeft((s) => s - 1), 1000)
    return () => clearTimeout(timer)
  }, [left])

  return (
    <form action={formAction} className="flex flex-col items-center gap-3 text-sm">
      {turnstile}
      <button
        type="submit"
        disabled={pending || left > 0}
        className="rounded-md px-3 py-1.5 font-bold text-primary hover:underline disabled:cursor-not-allowed disabled:text-muted-foreground disabled:no-underline"
      >
        {pending ? '寄送中…' : left > 0 ? `重寄驗證碼（${left} 秒後可重寄）` : '重寄驗證碼'}
      </button>
      <p aria-live="polite" className="text-center text-[13px]">
        {state?.error ? (
          <span role="alert" className="font-semibold text-danger">
            {state.error}
          </span>
        ) : state?.sentAt ? (
          <span className="font-semibold text-success">已重新寄出新的驗證碼，之前那封的碼不能再用。</span>
        ) : null}
      </p>
    </form>
  )
}
