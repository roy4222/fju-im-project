'use client'
import { useActionState, useState } from 'react'
import { respondAction } from './actions'
import { DIALOG, Feedback, INPUT, LABEL, PRIMARY, SECONDARY, useCloseOnSuccess, useDialog } from '@/app/dashboard/admin/groups/admin-group-forms'

/**
 * 本人表態（票 26；原型「勾選已閱讀 → 我已閱讀並同意 → 確認框『只代表你自己的一票』」「不同意：原因必填」）。
 *
 * - 同意：先勾「我已完整閱讀全文與附件」才按得下去，按了再跳確認框。
 * - 不同意（學生）／退回（老師）：對話框裡理由必填。
 * - 表單帶著這一版的內容核對碼：頁面過期（版本已換、內容不同）時伺服器拒絕，不會把票記到別的版本上。
 * - 按鈕上的字和伺服器記進 `approvals.button_text` 的是同一份常數（`BUTTON_TEXT`），由頁面傳進來。
 */

export type RespondActionState = { ok: boolean; message: string } | undefined

export function RespondForm({
  versionId,
  contentChecksum,
  requestId,
  role,
  agreeText,
  rejectText,
  reasonMaxLength,
}: {
  versionId: string
  contentChecksum: string
  requestId: string
  role: 'student' | 'advisor'
  agreeText: string
  rejectText: string
  reasonMaxLength: number
}) {
  const [state, formAction, pending] = useActionState(respondAction, undefined)
  const [read, setRead] = useState(false)
  const agree = useDialog()
  const reject = useDialog()
  useCloseOnSuccess(state, agree.close)
  useCloseOnSuccess(state, reject.close)
  const who = role === 'student' ? '你自己' : '你以指導老師身分'
  const hidden = (
    <>
      <input type="hidden" name="versionId" value={versionId} />
      <input type="hidden" name="contentChecksum" value={contentChecksum} />
      <input type="hidden" name="requestId" value={requestId} />
    </>
  )

  return (
    <section aria-label="表態" className="space-y-3 rounded-md border border-primary/40 bg-primary-subtle/40 p-4" data-testid="respond-form">
      <label className="flex items-start gap-2 text-sm text-ink">
        <input type="checkbox" checked={read} onChange={(e) => setRead(e.target.checked)} className="mt-1" />
        <span>我已完整閱讀這一版的全文{role === 'student' ? '、附件與授權範圍' : '與附件'}</span>
      </label>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={PRIMARY} disabled={!read || pending} onClick={agree.open}>
          {agreeText}
        </button>
        <button type="button" className={SECONDARY} disabled={pending} onClick={reject.open}>
          {rejectText}
        </button>
      </div>
      <p className="text-xs text-muted-foreground">每人一票、投了不能改；系辦與其他人都不能替你按。</p>

      <dialog ref={agree.ref} aria-label="確認同意" className={DIALOG}>
        <form action={formAction} className="space-y-4 p-5">
          {hidden}
          <input type="hidden" name="decision" value="agree" />
          <h2 className="text-base font-semibold text-ink">確認同意？</h2>
          <p className="text-sm text-muted-foreground">這一票只代表{who}；送出後會記下時間、這次的登入方式與按鈕原文，不能改票。</p>
          <Feedback state={state?.ok ? undefined : state} />
          <div className="flex justify-end gap-2 border-t border-border pt-4">
            <button type="button" className={SECONDARY} onClick={agree.close}>
              再看一下
            </button>
            <button type="submit" disabled={pending} className={PRIMARY}>
              {pending ? '送出中…' : agreeText}
            </button>
          </div>
        </form>
      </dialog>

      <dialog ref={reject.ref} aria-label={rejectText} className={DIALOG}>
        <form action={formAction} className="space-y-4 p-5">
          {hidden}
          <input type="hidden" name="decision" value="reject" />
          <h2 className="text-base font-semibold text-ink">{rejectText}？</h2>
          <p className="text-sm text-muted-foreground">
            送出後這一版回到「退回修正中」，全組要等系辦重開新版再重新閱讀；你的理由會記在紀錄上，參與者與系辦看得到。
          </p>
          <div>
            <label htmlFor={`reason-${versionId}`} className={LABEL}>
              理由（必填）
            </label>
            <textarea id={`reason-${versionId}`} name="reason" rows={3} maxLength={reasonMaxLength} className={INPUT} />
          </div>
          <Feedback state={state?.ok ? undefined : state} />
          <div className="flex justify-end gap-2 border-t border-border pt-4">
            <button type="button" className={SECONDARY} onClick={reject.close}>
              先不要
            </button>
            <button type="submit" disabled={pending} className={PRIMARY}>
              {pending ? '送出中…' : `確定${rejectText}`}
            </button>
          </div>
        </form>
      </dialog>
    </section>
  )
}
