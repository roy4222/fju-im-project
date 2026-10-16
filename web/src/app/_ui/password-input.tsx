'use client'
import { useState } from 'react'
import { IconEye, IconEyeOff } from '@tabler/icons-react'
import { cn } from '@/shared/cn'

/**
 * 密碼輸入框＋「顯示／隱藏」眼睛按鈕（登入、註冊、改密碼、帳號設定共用）。
 *
 * 預設隱藏；按一下顯示明文、再按隱藏。按鈕是 `type="button"`，不會送出表單；
 * `autocomplete` 照呼叫端給的值，切換顯示不影響瀏覽器的密碼管理員。
 * 按鈕固定在輸入框底部右側，所以輸入框自己帶的上方間距（`mt-…`）不影響對齊。
 */
export function PasswordInput({
  id,
  name,
  autoComplete,
  required = true,
  invalid,
  describedBy,
  className,
}: {
  id: string
  name: string
  autoComplete?: string
  required?: boolean
  invalid?: boolean
  describedBy?: string
  /** 輸入框的外觀（各頁沿用自己的 class）；右側會再留出按鈕的空間。 */
  className?: string
}) {
  const [visible, setVisible] = useState(false)
  return (
    <div className="relative">
      <input
        id={id}
        name={name}
        type={visible ? 'text' : 'password'}
        autoComplete={autoComplete}
        required={required}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        // Edge 自己也會畫一顆眼睛，關掉免得出現兩顆。
        className={cn(className, 'pr-11 [&::-ms-reveal]:hidden')}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? '隱藏密碼' : '顯示密碼'}
        aria-pressed={visible}
        aria-controls={id}
        className="absolute right-0 bottom-0 flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-primary/20"
      >
        {visible ? <IconEyeOff className="size-4.5" aria-hidden /> : <IconEye className="size-4.5" aria-hidden />}
      </button>
    </div>
  )
}
