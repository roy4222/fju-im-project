'use client'
import { useActionState, useState, type FormEvent, type ReactNode } from 'react'
import { PasswordInput } from '@/app/_ui/password-input'
import type { SignupFormState } from './form-data'
import { signupFieldErrors } from './signup-checks'

const INPUT =
  'mt-1.5 h-11 w-full rounded-md border border-input bg-background px-3 text-sm outline-none transition-[border-color,box-shadow] focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-primary/20 aria-[invalid=true]:border-danger'

type FieldName = 'email' | 'password' | 'passwordConfirm'

/**
 * 註冊第 1 步的表單：Email、密碼、確認密碼、Turnstile（由頁面當 `turnstile` 傳進來，放在 `<form>` 裡）。
 *
 * 格式（空白、太短、兩次不同）先在瀏覽器擋：欄位下紅字、**不送出**（AC-VI-45）。伺服器 hook 一樣會再擋一次。
 * 送出失敗時保留 Email，密碼要重打（伺服器不把密碼帶回來）。
 */
export function RegisterForm({
  action,
  initialEmail,
  passwordMin,
  turnstile,
}: {
  action: (state: SignupFormState, formData: FormData) => Promise<SignupFormState>
  initialEmail: string
  passwordMin: number
  turnstile?: ReactNode
}) {
  const [state, formAction, pending] = useActionState(action, undefined)
  const [local, setLocal] = useState<Partial<Record<FieldName, string>>>({})
  const serverField = state?.field
  const errors: Partial<Record<FieldName, string>> = { ...local, ...(serverField && state ? { [serverField]: state.error } : {}) }
  // 伺服器的錯誤若不是某一欄的（限速、人機驗證、Email 無法註冊…），放在按鈕上方。
  const general = state && !serverField ? state.error : undefined

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    const data = new FormData(event.currentTarget)
    const found = signupFieldErrors(
      {
        email: String(data.get('email') ?? ''),
        password: String(data.get('password') ?? ''),
        passwordConfirm: String(data.get('passwordConfirm') ?? ''),
      },
      passwordMin,
    )
    setLocal(found)
    const first = (['email', 'password', 'passwordConfirm'] as const).find((k) => found[k])
    if (first) {
      event.preventDefault()
      document.getElementById(`signup-${first}`)?.focus()
    }
  }

  return (
    <form key={state?.attempt ?? 0} action={formAction} onSubmit={onSubmit} noValidate className="space-y-4">
      <div>
        <label htmlFor="signup-email" className="block text-sm font-semibold text-foreground">
          Email
        </label>
        <input
          id="signup-email"
          name="email"
          type="email"
          required
          defaultValue={state?.email ?? initialEmail}
          autoComplete="email"
          maxLength={254}
          placeholder="name@mail.fju.edu.tw"
          aria-invalid={errors.email ? true : undefined}
          aria-describedby={errors.email ? 'signup-email-error' : 'signup-email-hint'}
          className={INPUT}
        />
        {errors.email ? (
          <FieldError id="signup-email-error">{errors.email}</FieldError>
        ) : (
          <p id="signup-email-hint" className="mt-1 text-xs text-muted-foreground">
            之後用這個 Email 登入，註冊後不能自行更換。
          </p>
        )}
      </div>
      <div>
        <label htmlFor="signup-password" className="block text-sm font-semibold text-foreground">
          密碼
        </label>
        <PasswordInput
          id="signup-password"
          name="password"
          autoComplete="new-password"
          invalid={Boolean(errors.password)}
          describedBy={errors.password ? 'signup-password-error' : 'signup-password-hint'}
          className={INPUT}
        />
        {errors.password ? (
          <FieldError id="signup-password-error">{errors.password}</FieldError>
        ) : (
          <p id="signup-password-hint" className="mt-1 text-xs text-muted-foreground">
            至少 {passwordMin} 個字元
          </p>
        )}
      </div>
      <div>
        <label htmlFor="signup-passwordConfirm" className="block text-sm font-semibold text-foreground">
          確認密碼
        </label>
        <PasswordInput
          id="signup-passwordConfirm"
          name="passwordConfirm"
          autoComplete="new-password"
          invalid={Boolean(errors.passwordConfirm)}
          describedBy={errors.passwordConfirm ? 'signup-passwordConfirm-error' : undefined}
          className={INPUT}
        />
        {errors.passwordConfirm ? <FieldError id="signup-passwordConfirm-error">{errors.passwordConfirm}</FieldError> : null}
      </div>

      {turnstile}

      {general ? (
        <p role="alert" className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger-on-subtle">
          {general}
        </p>
      ) : null}

      <button type="submit" disabled={pending} className="btn-fju h-12 w-full text-base">
        {pending ? '建立中…' : '建立帳號'}
      </button>
    </form>
  )
}

function FieldError({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} className="mt-1 text-[13px] font-semibold text-danger">
      {children}
    </p>
  )
}
