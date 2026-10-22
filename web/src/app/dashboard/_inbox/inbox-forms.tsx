'use client'
import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { markAllReadAction, markReadAction, openNotificationAction } from './actions'
import { BTN_OUTLINE } from '@/app/_ui/dashboard-kit'
import { cn } from '@/shared/cn'

/**
 * 通知匣的按鈕（票 12；C2-15 加「點開」）。都是真的 `<form>` 送 Server Action：沒有 JavaScript 也按得動，
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

function OpenSubmit({ title, className }: { title: string; className: string }) {
  const { pending } = useFormStatus()
  return (
    <button type="submit" disabled={pending} className={cn('block max-w-full cursor-pointer text-left disabled:opacity-60', className)}>
      {title}
    </button>
  )
}

/**
 * 有來源頁的通知標題（C2-15）：樣子像連結，其實是送 `openNotificationAction` 的按鈕——
 * 點了才標已讀並導去來源頁。`inbox` 是失敗時要回去的本人收件匣。
 */
export function OpenNotificationButton({
  notificationId,
  title,
  inbox,
  className,
}: {
  notificationId: string
  title: string
  inbox: string
  className: string
}) {
  return (
    <form action={openNotificationAction} className="min-w-0">
      <input type="hidden" name="notificationId" value={notificationId} />
      <input type="hidden" name="inbox" value={inbox} />
      <OpenSubmit title={title} className={className} />
    </form>
  )
}
