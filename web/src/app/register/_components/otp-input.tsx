'use client'
import { useRef } from 'react'
import { fillOtp, OTP_LENGTH } from './signup-checks'

/**
 * 6 格驗證碼輸入（原型 `auth-fields.tsx` 的 `OtpInput`）。第一格收整串（簡訊／信件自動填入、貼上），
 * 打一個字自動跳下一格，Backspace 在空格時回上一格。值由呼叫端保管（`value`／`onChange`）。
 */
export function OtpInput({
  value,
  onChange,
  invalid,
  describedBy,
}: {
  value: string
  onChange: (value: string) => void
  invalid?: boolean
  describedBy?: string
}) {
  const refs = useRef<(HTMLInputElement | null)[]>([])
  const digits = Array.from({ length: OTP_LENGTH }, (_, i) => (value[i] ?? '').trim())

  function put(from: number, text: string) {
    const next = fillOtp(value, from, text)
    onChange(next)
    const typed = text.replace(/\D/g, '').length
    if (typed > 0) refs.current[Math.min(from + typed, OTP_LENGTH - 1)]?.focus()
  }

  return (
    <div className="flex justify-between gap-2" role="group" aria-label="6 位數驗證碼" aria-describedby={describedBy}>
      {digits.map((digit, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el
          }}
          value={digit}
          inputMode="numeric"
          autoComplete={i === 0 ? 'one-time-code' : 'off'}
          maxLength={i === 0 ? OTP_LENGTH : 1}
          aria-label={`驗證碼第 ${i + 1} 位`}
          aria-invalid={invalid || undefined}
          onChange={(e) => put(i, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Backspace' && !digit && i > 0) {
              e.preventDefault()
              onChange(fillOtp(value, i - 1, ''))
              refs.current[i - 1]?.focus()
            } else if (e.key === 'ArrowLeft' && i > 0) {
              e.preventDefault()
              refs.current[i - 1]?.focus()
            } else if (e.key === 'ArrowRight' && i < OTP_LENGTH - 1) {
              e.preventDefault()
              refs.current[i + 1]?.focus()
            }
          }}
          onPaste={(e) => {
            e.preventDefault()
            put(i, e.clipboardData.getData('text'))
          }}
          onFocus={(e) => e.target.select()}
          className="h-14 w-full min-w-0 rounded-lg border border-input bg-background text-center text-2xl font-bold tabular-nums outline-none transition-[border-color,box-shadow] focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-primary/20 aria-[invalid=true]:border-danger sm:h-16"
        />
      ))}
    </div>
  )
}
