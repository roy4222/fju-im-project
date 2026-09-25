'use client'
import { useActionState } from 'react'

/**
 * 註冊表單與「修改資料」表單（票 7；原型 `/register` 的版型）。
 *
 * 兩處共用同一組欄位：姓名、學號、系級、手機；註冊多了登入 Email 與密碼，
 * 修改多了聯絡 Email（登入 Email 本人不能改，§2.3 Q3）。屆別不由學生填（§2.4 Q6）。
 *
 * 規則全部在伺服器：這裡只把伺服器回來的錯誤訊息顯示出來。送出失敗時伺服器把填過的值
 * 帶回來（密碼除外），表單用新的 `key` 重新掛上，使用者不必整份重打。
 */

export type ApplicationFormValues = {
  appliedName: string
  studentNo: string
  departmentClass: string
  phone: string
  loginEmail?: string
  contactEmail?: string
}

export type ApplicationFormState =
  | { error: string; field?: string; values: ApplicationFormValues; attempt: number }
  | undefined

const INPUT =
  'mt-1.5 h-11 w-full rounded-md border border-input bg-background px-3 text-sm outline-none transition-[border-color,box-shadow] focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-primary/20 aria-[invalid=true]:border-danger'

function Input({
  label,
  name,
  defaultValue,
  invalidField,
  type = 'text',
  autoComplete,
  maxLength,
  placeholder,
  hint,
  inputMode,
}: {
  label: string
  name: string
  defaultValue?: string
  invalidField?: string
  type?: string
  autoComplete?: string
  maxLength?: number
  placeholder?: string
  hint?: string
  inputMode?: 'text' | 'tel' | 'email' | 'numeric'
}) {
  const id = `field-${name}`
  const invalid = invalidField === name
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-semibold text-foreground">
        {label}
      </label>
      <input
        id={id}
        name={name}
        type={type}
        required
        defaultValue={defaultValue}
        autoComplete={autoComplete}
        maxLength={maxLength}
        placeholder={placeholder}
        inputMode={inputMode}
        aria-invalid={invalid || undefined}
        aria-describedby={hint ? `${id}-hint` : undefined}
        className={INPUT}
      />
      {hint ? (
        <p id={`${id}-hint`} className="mt-1 text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  )
}

export function ApplicationForm({
  mode,
  action,
  initial,
  expectedRevision,
  submitLabel,
  limits,
}: {
  mode: 'register' | 'revise'
  action: (state: ApplicationFormState, formData: FormData) => Promise<ApplicationFormState>
  initial?: ApplicationFormValues
  /** 修改時畫面上看到的版本；另一個分頁先改過，伺服器會回「請重新整理」。 */
  expectedRevision?: number | null
  submitLabel: string
  limits: { nameMax: number; departmentClassMax: number; passwordMin: number }
}) {
  const [state, formAction, pending] = useActionState(action, undefined)
  const values = state?.values ?? initial
  const invalidField = state?.field

  return (
    <form key={state?.attempt ?? 0} action={formAction} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Input
          label="姓名"
          name="appliedName"
          defaultValue={values?.appliedName}
          invalidField={invalidField}
          autoComplete="name"
          maxLength={limits.nameMax}
          placeholder="與學籍相同"
        />
        <Input
          label="學號"
          name="studentNo"
          defaultValue={values?.studentNo}
          invalidField={invalidField}
          maxLength={20}
          placeholder="411410123"
          inputMode="text"
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Input
          label="系級"
          name="departmentClass"
          defaultValue={values?.departmentClass}
          invalidField={invalidField}
          maxLength={limits.departmentClassMax}
          placeholder="資管二甲"
        />
        <Input
          label="手機"
          name="phone"
          type="tel"
          defaultValue={values?.phone}
          invalidField={invalidField}
          autoComplete="tel"
          maxLength={25}
          placeholder="0912-345-678"
          inputMode="tel"
        />
      </div>

      {mode === 'register' ? (
        <>
          <Input
            label="登入 Email"
            name="loginEmail"
            type="email"
            defaultValue={values?.loginEmail}
            invalidField={invalidField}
            autoComplete="email"
            maxLength={254}
            placeholder="name@mail.fju.edu.tw"
            hint="之後用這個 Email 登入，註冊後不能自行更換；也是預設的聯絡 Email。"
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label="密碼"
              name="password"
              type="password"
              invalidField={invalidField}
              autoComplete="new-password"
              hint={`至少 ${limits.passwordMin} 個字元`}
            />
            <Input
              label="確認密碼"
              name="passwordConfirm"
              type="password"
              invalidField={invalidField}
              autoComplete="new-password"
            />
          </div>
        </>
      ) : (
        <Input
          label="聯絡 Email"
          name="contactEmail"
          type="email"
          defaultValue={values?.contactEmail}
          invalidField={invalidField}
          autoComplete="email"
          maxLength={254}
          hint="系辦聯絡你用的信箱；改這個不會改登入 Email。"
        />
      )}

      {mode === 'revise' ? (
        <input type="hidden" name="expectedRevision" value={expectedRevision === null || expectedRevision === undefined ? '' : String(expectedRevision)} />
      ) : null}

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
        {pending ? '送出中…' : submitLabel}
      </button>
    </form>
  )
}
