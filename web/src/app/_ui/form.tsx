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
    <form action={formAction} className={cn('space-y-4', className)}>
      {children}
      {state?.error ? (
        <p role="alert" className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger-on-subtle">
          {state.error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
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
}: {
  label: string
  name: string
  type?: string
  autoComplete?: string
  hint?: string
  defaultValue?: string
}) {
  const id = `field-${name}`
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-ink">
        {label}
      </label>
      <input
        id={id}
        name={name}
        type={type}
        autoComplete={autoComplete}
        defaultValue={defaultValue}
        required
        className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
      />
      {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

/** 帶進 Server Action 但不顯示的值（例如登入後要回去的頁面）。 */
export function HiddenField({ name, value }: { name: string; value: string }) {
  return <input type="hidden" name={name} value={value} />
}
