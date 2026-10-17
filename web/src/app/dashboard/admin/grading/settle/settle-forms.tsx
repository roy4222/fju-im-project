'use client'
import { useActionState } from 'react'
import { releaseSettlementAction, settleStageAction } from '@/app/dashboard/admin/grading/actions'
import type { ResultsActionState } from '@/app/dashboard/admin/grading/results-forms'
import { DIALOG, Feedback, LABEL, PRIMARY, SECONDARY, useCloseOnSuccess, useDialog } from '@/app/dashboard/admin/groups/admin-group-forms'

/**
 * 系辦結算頁的兩個動作（B 階段 AD-B1；設計方案 §2.5）：「結算」「解除結算」，按下開理由對話框（必填）。
 * 規則全在用例裡判（理由 1–500 字、已封存、已有人結算、已解除）；畫面只收表單、顯示伺服器回來的句子。
 */

const TEXTAREA = 'mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm'

type Dialog = {
  title: string
  hint: string
  label: string
  submit: string
  trigger: string
  triggerLabel: string
  hidden: Record<string, string>
  action: (state: ResultsActionState, formData: FormData) => Promise<ResultsActionState>
}

function ReasonDialog({ title, hint, label, submit, trigger, triggerLabel, hidden, action: serverAction }: Dialog) {
  const [state, action, pending] = useActionState(serverAction, undefined)
  const dialog = useDialog()
  useCloseOnSuccess(state, dialog.close)
  return (
    <div className="space-y-1">
      <button type="button" className={SECONDARY} onClick={dialog.open} aria-label={triggerLabel}>
        {trigger}
      </button>
      <Feedback state={state?.ok ? state : undefined} />
      <dialog ref={dialog.ref} aria-label={title} className={DIALOG}>
        <form action={action} className="space-y-4 p-5">
          <div>
            <h2 className="text-lg font-extrabold text-foreground">{title}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{hint}</p>
          </div>
          {Object.entries(hidden).map(([name, value]) => (
            <input key={name} type="hidden" name={name} value={value} />
          ))}
          <label className={LABEL}>
            {label}
            <textarea name="reason" required maxLength={500} rows={3} className={TEXTAREA} />
          </label>
          <Feedback state={state?.ok ? undefined : state} />
          <div className="flex justify-end gap-2 border-t border-border pt-4">
            <button type="button" className={SECONDARY} onClick={dialog.close}>
              先不要
            </button>
            <button type="submit" disabled={pending} className={PRIMARY}>
              {pending ? '處理中…' : submit}
            </button>
          </div>
        </form>
      </dialog>
    </div>
  )
}

export function SettleForm({ cohortId, stageKey, stageName, requestId }: { cohortId: string; stageKey: string; stageName: string; requestId: string }) {
  return (
    <ReasonDialog
      title={`結算「${stageName}」`}
      hint="結算後，老師不能再暫存、送出或重新送出這個階段的分數，系辦也不能退回；要修改請先解除結算。採計份數以按下的當下為準。"
      label="結算理由（必填）"
      submit="確認結算"
      trigger="結算"
      triggerLabel={`結算「${stageName}」`}
      hidden={{ cohortId, stageKey, requestId }}
      action={settleStageAction}
    />
  )
}

export function ReleaseForm({ settlementId, stageName, requestId }: { settlementId: string; stageName: string; requestId: string }) {
  return (
    <ReasonDialog
      title={`解除「${stageName}」的結算`}
      hint="解除後，老師又可以修改與重新送出這個階段的分數。這筆結算與解除理由會留在結算紀錄。"
      label="解除理由（必填）"
      submit="確認解除"
      trigger="解除結算"
      triggerLabel={`解除「${stageName}」的結算`}
      hidden={{ settlementId, requestId }}
      action={releaseSettlementAction}
    />
  )
}
