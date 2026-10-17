'use client'
import { startTransition, useActionState, useEffect, useRef, useState, type FormEvent } from 'react'
import { IconX } from '@tabler/icons-react'
import type { IndustryActionState } from '@/app/dashboard/_industry/opportunity-forms'
import { DIALOG, GHOST_BUTTON, OUTLINE_BUTTON_SM, PRIMARY_BUTTON } from '@/app/dashboard/teacher/_ui/dash'
import { linkGroupAction } from '@/app/dashboard/teacher/industry/link-action'
import { cn } from '@/shared/cn'

/** 一個可選的組別；`label` 是伺服器端算好的「屆別名稱（代碼）・組別代碼」。 */
export type LinkTargetOption = { groupId: string; label: string; leaderName: string | null; revision: number }

/**
 * 「我的合作案」每列的「連結組別」（TE-B3）：案主老師把一組連到自己負責的已發布合作案。
 * 選項只有未封存屆別裡、還沒連任何合作案的產學組（組別代碼＋組長名）；已連別案的組要由組長或系辦換案。
 * 首次連結不發通知；組員在組別頁的合作案分頁看得到。
 */
export function LinkGroupDialog({
  opportunityId,
  opportunityName,
  options,
  requestId,
}: {
  opportunityId: string
  opportunityName: string
  options: readonly LinkTargetOption[]
  requestId: string
}) {
  const [state, action, pending] = useActionState<IndustryActionState, FormData>(linkGroupAction, undefined)
  const ref = useRef<HTMLDialogElement>(null)
  const [picked, setPicked] = useState<string | null>(null)
  const chosen = options.find((o) => o.groupId === picked) ?? null
  useEffect(() => {
    if (state?.ok) ref.current?.close()
  }, [state])

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const formData = new FormData(event.currentTarget)
    startTransition(() => action(formData))
  }

  return (
    <>
      <button
        type="button"
        className={OUTLINE_BUTTON_SM}
        aria-label={`連結組別：${opportunityName}`}
        onClick={() => {
          setPicked(null)
          ref.current?.showModal()
        }}
      >
        連結組別
      </button>
      {state?.ok ? (
        <span className="sr-only" role="status">
          {state.message}
        </span>
      ) : null}
      <dialog ref={ref} aria-label={`連結組別到「${opportunityName}」`} className={DIALOG}>
        <form onSubmit={submit} className="relative flex flex-col gap-4 p-6">
          <button
            type="button"
            onClick={() => ref.current?.close()}
            aria-label="關閉對話框"
            className={cn(GHOST_BUTTON, 'absolute top-2 right-2 size-7 px-0')}
          >
            <IconX />
          </button>
          <div className="pr-8">
            <h2 className="text-lg font-extrabold text-foreground">把組別連到「{opportunityName}」</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              只列出還沒連任何合作案的產學組；已連別案的組要由組長或系辦換案。連結後組員在組別頁看得到，不另發通知。
            </p>
          </div>
          <input type="hidden" name="opportunityId" value={opportunityId} />
          <input type="hidden" name="requestId" value={requestId} />
          <input type="hidden" name="groupId" value={chosen?.groupId ?? ''} />
          <input type="hidden" name="revision" value={chosen?.revision ?? ''} />
          {options.length === 0 ? (
            <p className="rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">目前沒有可以連結的組別。</p>
          ) : (
            <fieldset className="flex max-h-[50vh] flex-col gap-1 overflow-y-auto">
              <legend className="mb-1.5 text-sm font-semibold text-foreground">選一組</legend>
              {options.map((o) => (
                <label key={o.groupId} className="flex items-center gap-3 rounded-lg px-2 py-1.5 text-sm hover:bg-accent">
                  <input
                    type="radio"
                    name="pick"
                    value={o.groupId}
                    checked={picked === o.groupId}
                    onChange={() => setPicked(o.groupId)}
                    className="accent-primary"
                  />
                  <span className="tabular font-semibold text-foreground">{o.label}</span>
                  <span className="text-muted-foreground">組長 {o.leaderName ?? '（未定）'}</span>
                </label>
              ))}
            </fieldset>
          )}
          {state && !state.ok ? (
            <p role="alert" className="rounded-lg bg-destructive-subtle px-3 py-2 text-sm text-destructive-on-subtle">
              {state.message}
            </p>
          ) : null}
          <button type="submit" disabled={pending || !chosen} className={cn(PRIMARY_BUTTON, 'w-full')}>
            {pending ? '處理中…' : '確認連結'}
          </button>
        </form>
      </dialog>
    </>
  )
}
