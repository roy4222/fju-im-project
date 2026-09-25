'use client'
import { useActionState } from 'react'
import { markAllReadAction, markReadAction } from './actions'
import { BTN_OUTLINE } from '@/app/_ui/dashboard-kit'
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
        'rounded-lg px-3 py-1.5 text-sm font-semibold',
        state.ok ? 'bg-success-subtle text-success-on-subtle' : 'bg-destructive-subtle text-destructive-on-subtle',
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
        className={BTN_OUTLINE}
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
        className="rounded-md px-2 py-1 text-xs font-semibold text-primary transition-colors hover:bg-accent disabled:opacity-50"
      >
        {pending ? '處理中…' : '標為已讀'}
      </button>
      {state && !state.ok ? <Feedback state={state} /> : null}
    </form>
  )
}
