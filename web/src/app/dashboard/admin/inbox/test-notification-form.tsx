'use client'
import { useActionState } from 'react'
import { sendTestNotificationAction } from './actions'
import { cn } from '@/shared/cn'

/**
 * 「發一則測試通知」表單（票 12；只在測試站出現）。
 *
 * 請求編號由頁面在伺服器端產生、放在隱藏欄位：同一張表單按兩次只會發一次。
 * 發成功後頁面換一個新編號（`key` 會變），才能再發下一則。
 */

export type TestNotificationState =
  | { ok: boolean; message: string; values?: { recipientUserId: string; cohortId: string; title: string } }
  | undefined

const INPUT = 'mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm'

export function TestNotificationForm({
  requestId,
  recipients,
  cohorts,
  titleMaxLength,
}: {
  requestId: string
  recipients: readonly { userId: string; label: string }[]
  cohorts: readonly { cohortId: string; code: string }[]
  titleMaxLength: number
}) {
  const [state, formAction, pending] = useActionState(sendTestNotificationAction, undefined)
  const values = state?.ok ? undefined : state?.values

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="requestId" value={requestId} />
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="test-recipient" className="block text-sm font-medium text-ink">
            收件人
          </label>
          <select
            id="test-recipient"
            name="recipientUserId"
            required
            defaultValue={values?.recipientUserId ?? ''}
            key={`r-${values?.recipientUserId ?? ''}`}
            className={INPUT}
          >
            <option value="" disabled>
              選一位已核准的帳號
            </option>
            {recipients.map((r) => (
              <option key={r.userId} value={r.userId}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="test-cohort" className="block text-sm font-medium text-ink">
            屆別
          </label>
          <select
            id="test-cohort"
            name="cohortId"
            defaultValue={values?.cohortId ?? ''}
            key={`c-${values?.cohortId ?? ''}`}
            className={INPUT}
          >
            <option value="">全站（不屬於任何屆別）</option>
            {cohorts.map((c) => (
              <option key={c.cohortId} value={c.cohortId}>
                {c.code}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <label htmlFor="test-title" className="block text-sm font-medium text-ink">
          標題
        </label>
        <input
          id="test-title"
          name="title"
          maxLength={titleMaxLength}
          autoComplete="off"
          placeholder="測試通知"
          defaultValue={values?.title}
          key={`t-${values?.title ?? ''}`}
          className={INPUT}
        />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
        >
          {pending ? '處理中…' : '發送測試通知'}
        </button>
        <p className="text-xs text-muted-foreground">只有測試站有這個功能；每次發送都留稽核紀錄。</p>
      </div>
      {state ? (
        <p
          role={state.ok ? 'status' : 'alert'}
          className={cn(
            'rounded-md px-3 py-2 text-sm',
            state.ok ? 'bg-primary-subtle text-primary-on-subtle' : 'bg-danger-subtle text-danger-on-subtle',
          )}
        >
          {state.message}
        </p>
      ) : null}
    </form>
  )
}
