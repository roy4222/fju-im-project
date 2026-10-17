'use client'
import { useActionState, useEffect, useState, type ReactNode } from 'react'
import {
  linkGoogleAction,
  reconfirmAction,
  sendAccountVerifyOtpAction,
  setPasswordAction,
  updateContactAction,
  verifyAccountOtpAction,
} from './actions'
import { PasswordInput } from '@/app/_ui/password-input'
import { OtpInput } from '@/app/register/_components/otp-input'

export type AccountFormState =
  | { error: string; code?: string; field?: string; values?: Record<string, string>; attempt: number }
  | undefined

/** 「驗證 Email」寄碼的結果：寄出（`sentAt`）或錯誤。 */
export type VerifyEmailSendState = { sentAt?: number; error?: string; code?: string; attempt: number } | undefined

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
          <PasswordInput
            id="field-newPassword"
            name="newPassword"
            autoComplete="new-password"
            invalid={state?.field === 'newPassword'}
            describedBy="field-newPassword-hint"
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
          <PasswordInput
            id="field-passwordConfirm"
            name="passwordConfirm"
            autoComplete="new-password"
            invalid={state?.field === 'passwordConfirm'}
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

/** 重寄冷卻（伺服器 hook 一樣擋 120 秒；這裡只是顯示）。 */
const RESEND_SECONDS = 120

/**
 * 「驗證 Email」（VB-5；visitor-r3 §3.7）：按下寄 6 碼到登入 Email，同一處出現 6 格，填對就回帳號頁。
 * 不掛 Turnstile（本人 fresh session 擋；伺服器在 hook 裡查）。session 不夠新時伺服器回 `FRESH_SESSION_REQUIRED`，
 * 這裡順手給「重新登入確認身分」。
 */
export function VerifyEmailForm() {
  const [sent, sendAction, sending] = useActionState(sendAccountVerifyOtpAction, undefined)
  const [checked, verifyAction, verifying] = useActionState(verifyAccountOtpAction, undefined)
  const [opened, setOpened] = useState(false)
  const [code, setCode] = useState('')
  const [left, setLeft] = useState(0)

  useEffect(() => {
    if (!sent?.sentAt) return
    setOpened(true)
    setLeft(RESEND_SECONDS)
  }, [sent?.sentAt])

  useEffect(() => {
    if (left <= 0) return
    const timer = setTimeout(() => setLeft((s) => s - 1), 1000)
    return () => clearTimeout(timer)
  }, [left])

  // 驗證碼錯了：清空重填。
  useEffect(() => {
    if (checked?.attempt) setCode('')
  }, [checked?.attempt])

  return (
    <div className="space-y-3">
      {opened ? (
        <form action={verifyAction} className="space-y-3">
          <input type="hidden" name="otp" value={code} />
          <p className="text-sm text-foreground" role="status">
            驗證碼已寄到登入 Email，10 分鐘內有效。
          </p>
          <div className="max-w-sm">
            <OtpInput value={code} onChange={setCode} invalid={Boolean(checked?.error)} />
          </div>
          <ErrorLine state={checked} />
          <button type="submit" disabled={verifying} className={SECONDARY}>
            {verifying ? '驗證中…' : '確認驗證碼'}
          </button>
        </form>
      ) : null}
      <form action={sendAction}>
        {opened ? (
          <button
            type="submit"
            disabled={sending || left > 0}
            className="text-sm font-semibold text-primary hover:underline disabled:cursor-not-allowed disabled:text-muted-foreground disabled:no-underline"
          >
            {sending ? '寄送中…' : left > 0 ? `重寄驗證碼（${left} 秒後可重寄）` : '重寄驗證碼'}
          </button>
        ) : (
          <button type="submit" disabled={sending} className={SECONDARY}>
            {sending ? '寄送中…' : '驗證 Email'}
          </button>
        )}
      </form>
      {sent?.error ? (
        <p role="alert" className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger-on-subtle">
          {sent.error}
        </p>
      ) : null}
      {sent?.code === 'FRESH_SESSION_REQUIRED' ? <ReconfirmButton /> : null}
    </div>
  )
}
