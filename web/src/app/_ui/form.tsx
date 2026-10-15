'use client'
import { createContext, useActionState, useContext } from 'react'
import { PasswordInput } from '@/app/_ui/password-input'
import { cn } from '@/shared/cn'

/**
 * 伺服器回給表單的狀態。失敗時可以帶回填過的值（`values`，**密碼一律不帶**）與第幾次失敗
 * （`attempt`）：表單用 `attempt` 當 `key` 重新掛上、欄位用 `values` 當預設值，
 * 使用者只要補打錯的那一格（跟註冊表單同一個做法）。
 */
export type ActionFormState = { error?: string; values?: Record<string, string>; attempt?: number } | undefined

const FormValuesContext = createContext<Record<string, string> | undefined>(undefined)

/**
 * 表單外殼（S01-05）。
 *
 * 用 `useActionState` 顯示伺服器回來的錯誤訊息與送出中的狀態。
 * 沒有 JavaScript 時它退化成一個普通的 `<form action=…>`：照樣送得出去、照樣登得進去，
 * 只是看不到「送出中」而已。錯誤訊息是**伺服器**回的字串，不在瀏覽器端判斷任何規則。
 */
export function ActionForm<S extends ActionFormState>({
  action,
  submitLabel,
  children,
  className,
}: {
  action: (state: S | undefined, formData: FormData) => Promise<S | undefined>
  submitLabel: string
  children: React.ReactNode
  className?: string
}) {
  const [state, formAction, pending] = useActionState(action, undefined)

  return (
    // React 送出後會把沒受控的欄位清空；換 `key` 重新掛上，欄位才會吃到伺服器帶回來的值。
    <form key={state?.attempt ?? 0} action={formAction} className={cn('flex flex-col gap-4.5', className)}>
      <FormValuesContext value={state?.values}>{children}</FormValuesContext>
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
  const returned = useContext(FormValuesContext)?.[name]
  const inputClass =
    'h-11 w-full rounded-md border border-input bg-background px-3 text-sm transition-[border-color,box-shadow] outline-none focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-primary/20'
  return (
    // 原型 auth-card 的 Field：粗體標籤、44px 高的輸入框。
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={id} className="text-sm font-semibold text-foreground">
          {label}
        </label>
        {trailing}
      </div>
      {type === 'password' ? (
        // 密碼欄不吃預設值：伺服器本來就不會把密碼帶回來。
        <PasswordInput id={id} name={name} autoComplete={autoComplete} required={!optional} className={inputClass} />
      ) : (
        <input
          id={id}
          name={name}
          type={type}
          autoComplete={autoComplete}
          defaultValue={returned ?? defaultValue}
          required={!optional}
          className={inputClass}
        />
      )}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

/** 帶進 Server Action 但不顯示的值（例如登入後要回去的頁面）。 */
export function HiddenField({ name, value }: { name: string; value: string }) {
  return <input type="hidden" name={name} value={value} />
}
