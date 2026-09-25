'use client'
import { useActionState, type ReactNode } from 'react'
import {
  linkGoogleAction,
  reconfirmAction,
  setPasswordAction,
  updateContactAction,
} from './actions'

export type AccountFormState =
  | { error: string; code?: string; field?: string; values?: Record<string, string>; attempt: number }
  | undefined

/**
 * 帳號頁的三個表單（票 10；原型 `/account`）。
 *
 * 規則全在伺服器（`SelfAccountCommand`）；這裡只顯示伺服器回來的錯誤。沒有 JavaScript 時
 * 退化成普通的 `<form action=…>`，照樣送得出去。
 */

// 外觀照原型 `/account`：44px 輸入框、系網橘實心主按鈕、白底細框次要按鈕。
const INPUT =
  'mt-1.5 h-11 w-full rounded-md border border-input bg-background px-3 text-sm outline-none transition-[border-color,box-shadow] ' +
  'focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-primary/20 aria-[invalid=true]:border-danger'
const PRIMARY = 'btn-fju h-11 px-5 text-[15px] disabled:opacity-60'
const SECONDARY =
  'press inline-flex h-10 items-center justify-center rounded-[4px] border border-border bg-background px-4 text-sm font-semibold text-foreground transition-colors hover:bg-accent disabled:opacity-60'
const LABEL = 'block text-sm font-semibold text-foreground'

function ErrorLine({ state }: { state: AccountFormState }) {
  if (!state?.error) return null
  return (
    <p role="alert" className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger-on-subtle">
      {state.error}
    </p>
  )
}

/** 伺服器說要重新確認身分（fresh session）時，順手給一顆「重新登入」。 */
function FreshHint({ state }: { state: AccountFormState }) {
  if (state?.code !== 'FRESH_SESSION_REQUIRED') return null
  return <ReconfirmButton />
}

/** 登出這一台、重新登入後回帳號頁。 */
export function ReconfirmButton() {
  return (
    <form action={reconfirmAction}>
      <button type="submit" className={SECONDARY}>
        重新登入確認身分
      </button>
    </form>
  )
}

export function ContactForm({
  phone,
  contactEmail,
  revision,
  leading,
  leadingCount = 0,
}: {
  phone: string
  contactEmail: string
  revision: number
  /** 排在前面的唯讀欄位（姓名、學號…登入 Email）：跟手機、聯絡 Email 放在同一個兩欄格裡（原型成對排列）。 */
  leading?: ReactNode
  /** 唯讀欄位有幾格：單數時最後一格跟「手機」同一列、聯絡 Email 自己一整列（原型「屆別｜手機」→「聯絡 Email」）。 */
  leadingCount?: number
}) {
  const [state, formAction, pending] = useActionState(updateContactAction, undefined)
  const values = state?.values ?? { phone, contactEmail }
  return (
    <form key={state?.attempt ?? 0} action={formAction} className="space-y-4">
      <input type="hidden" name="expectedRevision" value={String(revision)} />
      <div className="grid gap-x-3.5 gap-y-4 sm:grid-cols-2">
        {leading}
        <div>
          <label htmlFor="field-phone" className={LABEL}>
            手機
          </label>
          <input
            id="field-phone"
            name="phone"
            type="tel"
            required
            inputMode="tel"
            autoComplete="tel"
            maxLength={25}
            defaultValue={values.phone}
            aria-invalid={state?.field === 'phone' || undefined}
            className={INPUT}
          />
        </div>
        <div className={leadingCount % 2 === 1 ? 'sm:col-span-2' : undefined}>
          <label htmlFor="field-contactEmail" className={LABEL}>
            聯絡 Email
          </label>
          <input
            id="field-contactEmail"
            name="contactEmail"
            type="email"
            required
            autoComplete="email"
            maxLength={254}
            defaultValue={values.contactEmail}
            aria-invalid={state?.field === 'contactEmail' || undefined}
            aria-describedby="field-contactEmail-hint"
            className={INPUT}
          />
          <p id="field-contactEmail-hint" className="mt-1 text-xs text-muted-foreground">
            系辦聯絡你用的信箱；改這個不會改登入 Email。
          </p>
        </div>
      </div>
      <ErrorLine state={state} />
      <button type="submit" disabled={pending} className={PRIMARY}>
        {pending ? '儲存中…' : '儲存變更'}
      </button>
    </form>
  )
}

export function LinkGoogleForm() {
  const [state, formAction, pending] = useActionState(linkGoogleAction, undefined)
  return (
    <div className="space-y-2">
      <form action={formAction}>
        <button type="submit" disabled={pending} className={SECONDARY}>
          {pending ? '前往 Google…' : '連結 Google'}
        </button>
      </form>
      <ErrorLine state={state} />
      <FreshHint state={state} />
    </div>
  )
}

export function SetPasswordForm({ minLength }: { minLength: number }) {
  const [state, formAction, pending] = useActionState(setPasswordAction, undefined)
  return (
    <div className="space-y-2">
    <form key={state?.attempt ?? 0} action={formAction} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="field-newPassword" className={LABEL}>
            新密碼
          </label>
          <input
            id="field-newPassword"
            name="newPassword"
            type="password"
            required
            autoComplete="new-password"
            aria-invalid={state?.field === 'newPassword' || undefined}
            aria-describedby="field-newPassword-hint"
            className={INPUT}
          />
          <p id="field-newPassword-hint" className="mt-1 text-xs text-muted-foreground">
            至少 {minLength} 個字元
          </p>
        </div>
        <div>
          <label htmlFor="field-passwordConfirm" className={LABEL}>
            確認新密碼
          </label>
          <input
            id="field-passwordConfirm"
            name="passwordConfirm"
            type="password"
            required
            autoComplete="new-password"
            aria-invalid={state?.field === 'passwordConfirm' || undefined}
            className={INPUT}
          />
        </div>
      </div>
      <ErrorLine state={state} />
      <button type="submit" disabled={pending} className={SECONDARY}>
        {pending ? '設定中…' : '設定密碼'}
      </button>
    </form>
    {/* 表單不能巢狀：「重新登入」自己是一個 form，放在外面。 */}
    <FreshHint state={state} />
    </div>
  )
}
