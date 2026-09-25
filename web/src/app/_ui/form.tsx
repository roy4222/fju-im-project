'use client'
import { useActionState } from 'react'
import { cn } from '@/shared/cn'

/**
 * 表單外殼（S01-05）。
 *
 * 用 `useActionState` 顯示伺服器回來的錯誤訊息與送出中的狀態。
 * 沒有 JavaScript 時它退化成一個普通的 `<form action=…>`：照樣送得出去、照樣登得進去，
 * 只是看不到「送出中」而已。錯誤訊息是**伺服器**回的字串，不在瀏覽器端判斷任何規則。
 */
export function ActionForm({
  action,
  submitLabel,
  children,
  className,
}: {
  action: (state: { error?: string } | undefined, formData: FormData) => Promise<{ error?: string } | undefined>
  submitLabel: string
  children: React.ReactNode
  className?: string
}) {
  const [state, formAction, pending] = useActionState(action, undefined)

  return (
    <form action={formAction} className={cn('flex flex-col gap-4.5', className)}>
      {children}
      {state?.error ? (
        <p role="alert" className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger-on-subtle">
          {state.error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="btn-fju h-12 w-full text-base"
      >
        {pending ? '處理中…' : submitLabel}
      </button>
    </form>
  )
}

export function Field({
  label,
  name,
  type = 'text',
  autoComplete,
  hint,
  defaultValue,
  optional = false,
  trailing,
}: {
  label: string
  name: string
  type?: string
  autoComplete?: string
  hint?: string
  defaultValue?: string
  /** 選填欄位（預設必填）。 */
  optional?: boolean
  /** 標籤右側的小連結（原型登入頁「密碼」旁的「忘記密碼」）。 */
  trailing?: React.ReactNode
}) {
  const id = `field-${name}`
  return (
    // 原型 auth-card 的 Field：粗體標籤、44px 高的輸入框。
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={id} className="text-sm font-semibold text-foreground">
          {label}
        </label>
        {trailing}
      </div>
      <input
        id={id}
        name={name}
        type={type}
        autoComplete={autoComplete}
        defaultValue={defaultValue}
        required={!optional}
        className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm transition-[border-color,box-shadow] outline-none focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-primary/20"
      />
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

/** 帶進 Server Action 但不顯示的值（例如登入後要回去的頁面）。 */
export function HiddenField({ name, value }: { name: string; value: string }) {
  return <input type="hidden" name={name} value={value} />
}
