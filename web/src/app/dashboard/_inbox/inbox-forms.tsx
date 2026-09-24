'use client'
import { useActionState } from 'react'
import { markAllReadAction, markReadAction } from './actions'
import { cn } from '@/shared/cn'

/**
 * 通知匣的兩顆按鈕（票 12）。都是真的 `<form>` 送 Server Action：沒有 JavaScript 也按得動，
 * 有 JavaScript 時顯示「處理中…」與伺服器回的一句話。
 */

export type InboxActionState = { ok: boolean; message: string } | undefined

function Feedback({ state }: { state: InboxActionState }) {
  if (!state) return null
  return (
    <p
      role={state.ok ? 'status' : 'alert'}
      className={cn(
        'rounded-md px-3 py-1.5 text-sm',
        state.ok ? 'bg-primary-subtle text-primary-on-subtle' : 'bg-danger-subtle text-danger-on-subtle',
      )}
    >
      {state.message}
    </p>
  )
}

export function MarkAllReadButton({ cohort, disabled }: { cohort: string; disabled: boolean }) {
  const [state, formAction, pending] = useActionState(markAllReadAction, undefined)
  return (
    <form action={formAction} className="flex flex-wrap items-center justify-end gap-3">
      <input type="hidden" name="cohort" value={cohort} />
      <Feedback state={state} />
      <button
        type="submit"
        disabled={pending || disabled}
        className="inline-flex items-center justify-center rounded-md border border-border bg-background px-4 py-2 text-sm font-medium text-ink hover:bg-muted disabled:opacity-50"
      >
        {pending ? '處理中…' : '全部標為已讀'}
      </button>
    </form>
  )
}

export function MarkReadButton({ notificationId, title }: { notificationId: string; title: string }) {
  const [state, formAction, pending] = useActionState(markReadAction, undefined)
  return (
    <form action={formAction} className="flex flex-col items-end gap-1">
      <input type="hidden" name="notificationId" value={notificationId} />
      <button
        type="submit"
        disabled={pending}
        aria-label={`把「${title}」標為已讀`}
        className="rounded-md px-2 py-1 text-xs font-medium text-primary hover:bg-primary-subtle disabled:opacity-50"
      >
        {pending ? '處理中…' : '標為已讀'}
      </button>
      {state && !state.ok ? <Feedback state={state} /> : null}
    </form>
  )
}
