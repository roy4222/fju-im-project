'use client'
import { useActionState, useState } from 'react'
import { setExemptAction } from './actions'
import { BTN_OUTLINE, BTN_OUTLINE_SM, BTN_PRIMARY, DIALOG, FIELD_LABEL, TEXTAREA } from '@/app/_ui/dashboard-kit'

/**
 * 名單列的「設免繳」／「恢復」（B 階段 A-08；設計方案 §6）。
 *
 * 設免繳：按鈕開對話框填理由（1–200 字；系辦名單與稽核看得到，開放老師閱覽時主指導也看得到；不通知學生）；理由留空按確定，畫面直接提示「請填理由」、不送請求。
 * 恢復：對話框確認一次就送。已經交過的人也能設免繳，繳交內容保留；恢復後照原本的狀態顯示。
 * 成功後頁面刷新，這一列會移到另一個分頁（免繳／目前名單），分頁數與完成率跟著重算；失敗的句子留在對話框裡。
 */

export type ExemptActionState = { ok: boolean; message: string } | undefined

export type ExemptDialogProps = {
  itemId: string
  receiverId: string
  /** 對話框裡的稱呼（學生姓名，或「G03 組」）。 */
  name: string
  /** true＝這一列目前是免繳，按鈕是「恢復」；false＝按鈕是「設免繳」。 */
  exempt: boolean
  requestId: string
}

export function ExemptDialog({ itemId, receiverId, name, exempt, requestId }: ExemptDialogProps) {
  const [state, formAction, pending] = useActionState(setExemptAction, undefined)
  const [dialog, setDialog] = useState<HTMLDialogElement | null>(null)
  const [baseline, setBaseline] = useState(state)
  const [missingReason, setMissingReason] = useState(false)
  const result = state !== baseline && !pending ? state : undefined
  const label = exempt ? '恢復' : '設免繳'

  const open = () => {
    setBaseline(state)
    setMissingReason(false)
    dialog?.showModal()
  }

  return (
    <>
      <button type="button" className={BTN_OUTLINE_SM} onClick={open}>
        {label}
      </button>
      <dialog ref={setDialog} aria-label={exempt ? `恢復 ${name} 需繳交` : `設 ${name} 免繳`} className={DIALOG}>
        <form
          action={formAction}
          // 不用瀏覽器原生的必填檢查：它會擋在 onSubmit 前面，「請填理由」就出不來。
          noValidate
          onSubmit={(event) => {
            if (exempt) return
            const reason = new FormData(event.currentTarget).get('reason')
            if (typeof reason !== 'string' || reason.trim() === '') {
              event.preventDefault()
              setMissingReason(true)
            }
          }}
          className="space-y-4 p-5"
        >
          <div>
            <h2 className="text-lg font-extrabold">{exempt ? `恢復 ${name} 需繳交？` : `設 ${name} 免繳`}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {exempt
                ? '恢復後回到目前名單，算進需要繳交的總數；已經交過的版本照原樣，逾期與否依截止時間重算。'
                : '免繳的人不算在需要繳交的總數裡，也不能再填寫。已經交過的版本保留，之後可以恢復。不會通知學生。'}
            </p>
          </div>
          <input type="hidden" name="itemId" value={itemId} />
          <input type="hidden" name="receiverId" value={receiverId} />
          <input type="hidden" name="exempt" value={exempt ? 'false' : 'true'} />
          <input type="hidden" name="requestId" value={requestId} />
          {exempt ? null : (
            <label className={FIELD_LABEL}>
              理由（200 字內；開放老師閱覽時，主指導也看得到）
              <textarea
                name="reason"
                maxLength={200}
                rows={2}
                className={TEXTAREA}
                aria-invalid={missingReason || undefined}
                onChange={() => setMissingReason(false)}
              />
            </label>
          )}
          {missingReason ? (
            <p role="alert" className="text-sm font-semibold text-destructive" data-testid="exempt-reason-error">
              請填理由
            </p>
          ) : null}
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
              {pending ? '處理中…' : '確定'}
            </button>
          </div>
        </form>
      </dialog>
    </>
  )
}
