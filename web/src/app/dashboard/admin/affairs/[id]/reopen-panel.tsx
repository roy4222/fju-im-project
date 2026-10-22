'use client'
import { useActionState, useEffect, useState } from 'react'
import { reopenAction } from './actions'
import { BTN_OUTLINE, BTN_OUTLINE_SM, BTN_PRIMARY, DIALOG, FIELD_LABEL, INPUT, TEXTAREA } from '@/app/_ui/dashboard-kit'
import { cn } from '@/shared/cn'

/**
 * 「讓他補交」（第三波 W10；最小版的 S08-07）：收件已截止時，系辦替名單上的一位學生（整組一份：一組）開補交期限。
 *
 * 日常動作，不另跳確認框：按「讓他補交」展開表單（期限＋理由），送出就生效、只通知這一位（或這一組的組員）。
 * 其他人仍是已截止；不改名單、不動收件的截止時間。期限與理由在伺服器再驗一次（晚於現在、理由選填且 200 字內，X2）。
 *
 * 兩個入口：點進那一位的畫面裡展開表單（`ReopenPanel`），或繳交狀況名單列上的「讓他補交」開對話框（`ReopenDialog`，C1-07、AC-11）。
 */

export type ReopenActionState = { ok: boolean; message: string } | undefined

export type ReopenPanelProps = {
  itemId: string
  receiverId: string
  /** 按鈕與說明裡的稱呼：「他」或「這一組」。 */
  group: boolean
  /** 期限預設值（`datetime-local`，臺灣時間）：明天 17:00。 */
  defaultDueAt: string
  requestId: string
}

export function ReopenPanel({ itemId, receiverId, group, defaultDueAt, requestId }: ReopenPanelProps) {
  const [state, formAction, pending] = useActionState(reopenAction, undefined)
  const [open, setOpen] = useState(false)
  const [baseline, setBaseline] = useState(state)
  const result = state !== baseline && !pending ? state : undefined
  const label = group ? '讓這一組補交' : '讓他補交'

  if (!open || result?.ok) {
    return (
      <div className="mt-3 space-y-2">
        {result?.ok ? (
          <p role="status" className="rounded-lg bg-success-subtle px-3 py-2 text-sm font-semibold text-success-on-subtle" data-testid="reopen-result">
            {result.message}
          </p>
        ) : null}
        <button
          type="button"
          className={BTN_OUTLINE}
          onClick={() => {
            setBaseline(state)
            setOpen(true)
          }}
        >
          {result?.ok ? '再改一次期限' : label}
        </button>
      </div>
    )
  }

  return (
    <form action={formAction} className="mt-3 flex max-w-md flex-col gap-4 rounded-lg border border-border p-4" data-testid="reopen-form">
      <input type="hidden" name="itemId" value={itemId} />
      <input type="hidden" name="receiverId" value={receiverId} />
      <input type="hidden" name="requestId" value={requestId} />
      <label className={FIELD_LABEL}>
        補交期限（臺灣時間，含這一分鐘）
        <input type="datetime-local" key={defaultDueAt} name="dueAt" required defaultValue={defaultDueAt} className={INPUT} />
      </label>
      <label className={FIELD_LABEL}>
        理由（選填；學生會看到，200 字內）
        <textarea name="reason" maxLength={200} rows={2} className={TEXTAREA} />
      </label>
      <p className="text-xs text-muted-foreground">
        只有{group ? '這一組的組員' : '這位學生'}會收到通知、可以在期限前交；送出的版本標「補交」。其他人仍是已截止。
      </p>
      {result && !result.ok ? (
        <p role="alert" className="rounded-lg bg-destructive-subtle px-3 py-2 text-sm font-semibold text-destructive-on-subtle">
          {result.message}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <button type="button" className={BTN_OUTLINE} onClick={() => setOpen(false)}>
          取消
        </button>
        <button type="submit" disabled={pending} className={BTN_PRIMARY}>
          {pending ? '處理中…' : '開放補交'}
        </button>
      </div>
    </form>
  )
}

/** 名單列上的「讓他補交」：對話框填期限與理由（選填）；成功就關窗，名單那一列變「補交到 m/d」。 */
export function ReopenDialog({
  itemId,
  receiverId,
  name,
  group,
  defaultDueAt,
  requestId,
}: Omit<ReopenPanelProps, 'group'> & { group: boolean; name: string }) {
  const [state, formAction, pending] = useActionState(reopenAction, undefined)
  const [dialog, setDialog] = useState<HTMLDialogElement | null>(null)
  const [baseline, setBaseline] = useState(state)
  const result = state !== baseline && !pending ? state : undefined

  useEffect(() => {
    if (result?.ok) dialog?.close()
  }, [result, dialog])

  return (
    <>
      <button
        type="button"
        className={cn(BTN_OUTLINE_SM, 'pointer-coarse:min-h-11')}
        onClick={() => {
          setBaseline(state)
          dialog?.showModal()
        }}
      >
        讓他補交
      </button>
      <dialog ref={setDialog} aria-label={`讓 ${name} 補交`} className={DIALOG}>
        <form action={formAction} className="flex flex-col gap-4 p-5" data-testid="reopen-form">
          <div>
            <h2 className="text-lg font-extrabold">讓 {name} 補交</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              只有{group ? '這一組的組員' : '這位學生'}會收到通知、可以在期限前交；送出的版本標「補交」。其他人仍是已截止。
            </p>
          </div>
          <input type="hidden" name="itemId" value={itemId} />
          <input type="hidden" name="receiverId" value={receiverId} />
          <input type="hidden" name="requestId" value={requestId} />
          <label className={FIELD_LABEL}>
            補交期限（臺灣時間，含這一分鐘）
            <input type="datetime-local" key={defaultDueAt} name="dueAt" required defaultValue={defaultDueAt} className={INPUT} />
          </label>
          <label className={FIELD_LABEL}>
            理由（選填；學生會看到，200 字內）
            <textarea name="reason" maxLength={200} rows={2} className={TEXTAREA} />
          </label>
          {result && !result.ok ? (
            <p role="alert" className="rounded-lg bg-destructive-subtle px-3 py-2 text-sm font-semibold text-destructive-on-subtle">
              {result.message}
            </p>
          ) : null}
          <div className="flex justify-end gap-2 border-t border-border pt-4">
            <button type="button" className={BTN_OUTLINE} onClick={() => dialog?.close()}>
              取消
            </button>
            <button type="submit" disabled={pending} className={BTN_PRIMARY}>
              {pending ? '處理中…' : '開放補交'}
            </button>
          </div>
        </form>
      </dialog>
    </>
  )
}
