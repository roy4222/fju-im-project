'use client'
import { useActionState } from 'react'
import { IconChecks } from '@tabler/icons-react'
import { markAllReadAction, markReadAction } from '@/app/dashboard/_inbox/actions'
import type { InboxActionState } from '@/app/dashboard/_inbox/inbox-forms'
import { OUTLINE_BUTTON } from '@/app/dashboard/teacher/_ui/dash'
import { cn } from '@/shared/cn'

/**
 * 老師通知匣的兩顆按鈕（票 37 換成原型外觀；動作與回饋跟三個角色共用的 `_inbox/actions.ts` 同一支）。
 * 都是真的 `<form>` 送 Server Action：沒有 JavaScript 也按得動。
 */

function Feedback({ state }: { state: InboxActionState }) {
  if (!state) return null
  return (
    <p
      role={state.ok ? 'status' : 'alert'}
      className={cn(
        'rounded-lg px-3 py-1.5 text-sm',
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
      <button type="submit" disabled={pending || disabled} className={OUTLINE_BUTTON}>
        <IconChecks />
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
        className="rounded-md px-2 py-0.5 text-xs font-semibold text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
      >
        {pending ? '處理中…' : '標為已讀'}
      </button>
      {state && !state.ok ? <Feedback state={state} /> : null}
    </form>
  )
}
