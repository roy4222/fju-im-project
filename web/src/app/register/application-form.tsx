'use client'
import { useActionState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { trackEvent } from '@/app/_analytics/track'

/**
 * 註冊第 3 步「填學生資料」與等待審核頁的「修改資料」共用的表單（票 7；VB-3 拿掉 Email／密碼欄）。
 *
 * 欄位：姓名、學號、系級、手機、聯絡 Email（預設＝登入 Email；登入 Email 本人不能改，§2.3 Q3）。
 * **沒有密碼欄**——密碼在第 1 步。屆別不由學生填（§2.4 Q6）。
 *
 * 規則全部在伺服器：這裡只把伺服器回來的錯誤訊息顯示出來。送出失敗時伺服器把填過的值
 * 帶回來（密碼除外），表單用新的 `key` 重新掛上，使用者不必整份重打。
 */

export type ApplicationFormValues = {
  appliedName: string
  studentNo: string
  departmentClass: string
  phone: string
  contactEmail?: string
}

export type ApplicationFormState =
  | { error: string; field?: string; values: ApplicationFormValues; attempt: number }
  /** 第 3 步送出成功：送 GA `register_step`（`done`）再換頁（VB-3）。 */
  | { done: string }
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
  /** `apply`：註冊第 3 步第一次送出；`revise`：等待審核頁修改或重送。 */
  mode: 'apply' | 'revise'
  action: (state: ApplicationFormState, formData: FormData) => Promise<ApplicationFormState>
  initial?: ApplicationFormValues
  /** 修改時畫面上看到的版本；另一個分頁先改過，伺服器會回「請重新整理」。 */
  expectedRevision?: number | null
  submitLabel: string
  limits: { nameMax: number; departmentClassMax: number; passwordMin?: number }
}) {
  const [state, formAction, pending] = useActionState(action, undefined)
  const router = useRouter()
  const failure = state && 'error' in state ? state : undefined
  const done = state && 'done' in state ? state.done : undefined
  const values = failure?.values ?? initial
  const invalidField = failure?.field

  useEffect(() => {
    if (!done) return
    // 註冊流程的最後一格（自動開通或進待審都算 done，B 設計方案 §7.3.1）；沒設 GA ID 時什麼都不送。
    trackEvent('register_step', { step: 'done' })
    router.replace(done)
  }, [done, router])

  return (
    <form key={failure?.attempt ?? 0} action={formAction} className="space-y-4">
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

      <Input
        label="聯絡 Email"
        name="contactEmail"
        type="email"
        defaultValue={values?.contactEmail}
        invalidField={invalidField}
        autoComplete="email"
        maxLength={254}
        hint={mode === 'apply' ? '預設是你的登入 Email；系辦聯絡你用的信箱，改這個不會改登入 Email。' : '系辦聯絡你用的信箱；改這個不會改登入 Email。'}
      />

      {mode === 'revise' ? (
        <input type="hidden" name="expectedRevision" value={expectedRevision === null || expectedRevision === undefined ? '' : String(expectedRevision)} />
      ) : null}

      {failure ? (
        <p role="alert" className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger-on-subtle">
          {failure.error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending || Boolean(done)}
        className="btn-fju h-12 w-full text-base"
      >
        {pending || done ? '送出中…' : submitLabel}
      </button>
    </form>
  )
}
