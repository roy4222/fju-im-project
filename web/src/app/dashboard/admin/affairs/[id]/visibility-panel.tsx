'use client'
import { useActionState, useState } from 'react'
import { setAdvisorVisibilityAction } from './actions'
import { cn } from '@/shared/cn'

/**
 * 「主指導閱覽」面板（票 22；產品模組 05 §4「誰看得到個人回答」、SUB-24；模組實作設計 05 §5 `setAdvisorVisibility`）。
 *
 * 個人一份的收件預設只有本人與系辦看得到回答。開放後，學生填寫頁會先告知「主指導可查看正式回答」，
 * 學生**目前組別**的主指導才看得到正式送出的內容（草稿永遠不給老師）；換老師後舊老師馬上看不到。
 * 已經有人作答就不能開（那些人填寫時沒看到告知），按鈕停用並說明原因；關閉隨時可以。
 * 開關前先開一個確認對話框講清楚影響，送出後在對話框裡顯示伺服器回的結果。
 */

export type VisibilityActionState = { ok: boolean; message: string } | undefined

export type VisibilityPanelProps = {
  itemId: string
  enabled: boolean
  effectiveFromVersionNo: number | null
  /** 「由誰、何時」改的（已排版好的字）；沒設過是 null。 */
  changedText: string | null
  hasResponses: boolean
  requestId: string
}

const BUTTON =
  'inline-flex h-10 items-center justify-center rounded-md border border-border px-4 text-sm font-medium text-ink hover:bg-muted disabled:opacity-60'
const PRIMARY =
  'inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60'

export function VisibilityPanel({ itemId, enabled, effectiveFromVersionNo, changedText, hasResponses, requestId }: VisibilityPanelProps) {
  const [state, formAction, pending] = useActionState(setAdvisorVisibilityAction, undefined)
  const [dialog, setDialog] = useState<HTMLDialogElement | null>(null)
  const [baseline, setBaseline] = useState(state)
  const result = state !== baseline && !pending ? state : undefined
  const blocked = !enabled && hasResponses

  const open = () => {
    setBaseline(state)
    dialog?.showModal()
  }

  return (
    <section aria-labelledby="visibility-title" className="rounded-card border border-border bg-background p-5" data-testid="visibility-panel">
      <h2 id="visibility-title" className="text-base font-semibold text-ink">
        主指導閱覽
      </h2>
      <p className="mt-2 text-sm font-semibold text-ink" data-testid="visibility-state">
        {enabled ? `開放中・欄位第 ${effectiveFromVersionNo ?? 1} 版起` : '不開放'}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        {enabled
          ? '學生目前組別的主指導看得到正式送出的回答（草稿不給）；學生填寫前會看到告知。'
          : '個人回答只有本人與系辦看得到，老師看不到。'}
      </p>
      {changedText ? <p className="mt-1 text-xs text-muted-foreground tabular-nums">{changedText}</p> : null}
      {blocked ? (
        <p className="mt-3 rounded-md bg-muted px-3 py-2 text-xs text-ink" data-testid="visibility-blocked">
          已經有人作答，不能再開放：那些同學填寫時沒看到「主指導可查看」的告知。需要老師看，請另建一份收件並在發布前開好。
        </p>
      ) : null}
      <button type="button" className={cn(enabled ? BUTTON : PRIMARY, 'mt-3 w-full')} disabled={blocked} onClick={open}>
        {enabled ? '關閉主指導閱覽' : '開放主指導閱覽'}
      </button>

      <dialog
        ref={setDialog}
        aria-label={enabled ? '關閉主指導閱覽' : '開放主指導閱覽'}
        className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-card border border-border bg-background p-0 backdrop:bg-ink/40"
      >
        {result ? (
          <div className="space-y-3 p-5">
            <h2 className="text-base font-semibold text-ink">{result.ok ? '設定已更新' : '沒有改成功'}</h2>
            <p
              role={result.ok ? 'status' : 'alert'}
              className={cn('rounded-md px-3 py-2 text-sm', result.ok ? 'bg-muted text-ink' : 'bg-danger-subtle text-danger-on-subtle')}
            >
              {result.message}
            </p>
            <div className="flex justify-end">
              <button type="button" className={BUTTON} onClick={() => dialog?.close()}>
                關閉
              </button>
            </div>
          </div>
        ) : (
          <form action={formAction} className="space-y-4 p-5">
            <div>
              <h2 className="text-base font-semibold text-ink">{enabled ? '關閉主指導閱覽？' : '開放主指導閱覽？'}</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {enabled
                  ? '關閉後老師馬上看不到這份收件的個人回答與附件；學生填寫頁的告知也會拿掉。之後要再開，必須還沒有人作答。'
                  : '開放後，學生填寫頁會先出現「你的主指導老師可以查看正式送出的回答」。學生目前組別的主指導看得到正式版本（草稿不給）；換老師後舊老師就看不到。'}
              </p>
            </div>
            <input type="hidden" name="itemId" value={itemId} />
            <input type="hidden" name="enabled" value={enabled ? 'false' : 'true'} />
            <input type="hidden" name="requestId" value={requestId} />
            <div className="flex justify-end gap-2 border-t border-border pt-4">
              <button type="button" className={BUTTON} onClick={() => dialog?.close()}>
                先不要
              </button>
              <button type="submit" disabled={pending} className={PRIMARY}>
                {pending ? '處理中…' : enabled ? '確定關閉' : '確定開放'}
              </button>
            </div>
          </form>
        )}
      </dialog>
    </section>
  )
}
