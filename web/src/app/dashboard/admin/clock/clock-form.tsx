'use client'
import { useActionState } from 'react'
import { setBusinessClockAction } from './actions'
import { cn } from '@/shared/cn'

/**
 * 模擬業務鐘的表單（票 11）。時間用 `datetime-local` 帶秒（step=1），當臺灣時間解讀；
 * 原因必填。回饋一律是伺服器回的句子。
 */

export type ClockActionState =
  | { ok: boolean; message: string; values?: { businessAt: string; reason: string } }
  | undefined

const INPUT = 'mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm'

export function ClockForm({
  requestId,
  defaultBusinessAt,
  reasonMaxLength,
}: {
  requestId: string
  defaultBusinessAt: string
  reasonMaxLength: number
}) {
  const [state, formAction, pending] = useActionState(setBusinessClockAction, undefined)
  const values = state?.ok ? undefined : state?.values

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="requestId" value={requestId} />
      <div className="grid gap-3 sm:grid-cols-[16rem_1fr]">
        <div>
          <label htmlFor="business-at" className="block text-sm font-medium text-ink">
            業務時間（臺灣時間，到秒）
          </label>
          <input
            id="business-at"
            name="businessAt"
            type="datetime-local"
            step={1}
            required
            defaultValue={values?.businessAt ?? defaultBusinessAt}
            key={`at-${values?.businessAt ?? defaultBusinessAt}`}
            className={INPUT}
          />
        </div>
        <div>
          <label htmlFor="clock-reason" className="block text-sm font-medium text-ink">
            原因
          </label>
          <input
            id="clock-reason"
            name="reason"
            maxLength={reasonMaxLength}
            autoComplete="off"
            placeholder="例：驗證期中截止後一秒"
            defaultValue={values?.reason}
            key={`reason-${values?.reason ?? ''}`}
            className={INPUT}
          />
        </div>
      </div>
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
        >
          {pending ? '處理中…' : '設定業務時間'}
        </button>
        <p className="text-xs text-muted-foreground">可以往前也可以倒退；每次設定都留紀錄，不能改也不能刪。</p>
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
