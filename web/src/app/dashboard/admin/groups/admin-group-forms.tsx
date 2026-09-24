'use client'
import { useActionState, useCallback, useEffect, useRef, useState } from 'react'
import { saveGroupingSettingsAction, voidProposalAction } from './actions'
import { cn } from '@/shared/cn'

/**
 * 分組總覽會動的部分（票 13）：分組設定對話框、作廢提案對話框。回饋一律是伺服器回的句子。
 */

export type AdminGroupActionState = { ok: boolean; message: string } | undefined

export const PRIMARY =
  'inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium ' +
  'text-primary-foreground hover:bg-primary/90 disabled:opacity-60'
export const SECONDARY =
  'inline-flex items-center justify-center whitespace-nowrap rounded-md border border-border px-3 py-1.5 ' +
  'text-sm font-medium text-ink hover:bg-muted disabled:opacity-60'
export const INPUT = 'mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm'
export const LABEL = 'block text-sm font-medium text-ink'
export const DIALOG = 'm-auto w-[min(32rem,calc(100vw-2rem))] rounded-card border border-border bg-background p-0 backdrop:bg-ink/40'

export function Feedback({ state }: { state: AdminGroupActionState }) {
  if (!state) return null
  return (
    <p
      role={state.ok ? 'status' : 'alert'}
      className={cn(
        'rounded-md px-3 py-2 text-sm',
        state.ok ? 'bg-primary-subtle text-primary-on-subtle' : 'bg-danger-subtle text-danger-on-subtle',
      )}
    >
      {state.message}
    </p>
  )
}

export function useDialog() {
  const ref = useRef<HTMLDialogElement>(null)
  const open = useCallback(() => ref.current?.showModal(), [])
  const close = useCallback(() => ref.current?.close(), [])
  return { ref, open, close }
}

export function useCloseOnSuccess(state: AdminGroupActionState, close: () => void) {
  useEffect(() => {
    if (state?.ok) close()
  }, [state, close])
}

export function GroupingSettingsEditor({
  cohortId,
  cohortCode,
  revision,
  requestId,
  values,
  sizeLimit,
  daysLimit,
}: {
  cohortId: string
  cohortCode: string
  revision: number
  requestId: string
  values: { groupSizeMin: number; groupSizeMax: number; proposalDefaultDays: number }
  sizeLimit: number
  daysLimit: number
}) {
  const [state, formAction, pending] = useActionState(saveGroupingSettingsAction, undefined)
  const dialog = useDialog()
  const [draft, setDraft] = useState(values)
  const [seenRevision, setSeenRevision] = useState(revision)
  useCloseOnSuccess(state, dialog.close)

  // 資料換版時，對話框的初始值跟著最新資料走（渲染中依 prop 調整 state）。
  if (seenRevision !== revision) {
    setSeenRevision(revision)
    setDraft(values)
  }

  const field = (name: keyof typeof values, label: string, max: number, hint?: string) => (
    <div>
      <label htmlFor={`grouping-${name}`} className={LABEL}>
        {label}
      </label>
      <input
        id={`grouping-${name}`}
        name={name}
        type="number"
        min={1}
        max={max}
        required
        value={draft[name]}
        onChange={(e) => setDraft((d) => ({ ...d, [name]: Number(e.target.value) }))}
        className={INPUT}
      />
      {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )

  return (
    <div className="space-y-3">
      <button type="button" className={PRIMARY} onClick={dialog.open}>
        分組設定
      </button>
      <Feedback state={state?.ok ? state : undefined} />
      <dialog ref={dialog.ref} aria-label={`${cohortCode} 的分組設定`} className={DIALOG}>
        <form action={formAction} className="space-y-4 p-5">
          <h2 className="text-base font-semibold text-ink">{cohortCode} 的分組設定</h2>
          <p className="text-sm text-muted-foreground">
            學生提案的人數（含自己）要落在最少到最多之間；只影響之後發起的提案。特殊情況由系辦直接調整組員。
          </p>
          <input type="hidden" name="cohortId" value={cohortId} />
          <input type="hidden" name="revision" value={revision} />
          <input type="hidden" name="requestId" value={requestId} />
          <div className="grid gap-3 sm:grid-cols-3">
            {field('groupSizeMin', '每組最少人數', sizeLimit)}
            {field('groupSizeMax', '每組最多人數', sizeLimit)}
            {field('proposalDefaultDays', '提案預設天數', daysLimit, '到期不會超過成組期')}
          </div>
          <Feedback state={state?.ok ? undefined : state} />
          <div className="flex justify-end gap-2 border-t border-border pt-4">
            <button type="button" className={SECONDARY} onClick={dialog.close}>
              先不改
            </button>
            <button type="submit" disabled={pending} className={PRIMARY}>
              {pending ? '處理中…' : '儲存'}
            </button>
          </div>
        </form>
      </dialog>
    </div>
  )
}

export function VoidProposalButton({
  proposalId,
  label,
  requestId,
  reasonMaxLength,
}: {
  proposalId: string
  /** 例如「王小明的提案」，給按鈕與對話框的無障礙名稱。 */
  label: string
  requestId: string
  reasonMaxLength: number
}) {
  const [state, formAction, pending] = useActionState(voidProposalAction, undefined)
  const dialog = useDialog()
  useCloseOnSuccess(state, dialog.close)

  return (
    <div className="space-y-2">
      <button type="button" className={SECONDARY} aria-label={`作廢：${label}`} onClick={dialog.open}>
        作廢
      </button>
      <Feedback state={state?.ok ? state : undefined} />
      <dialog ref={dialog.ref} aria-label={`作廢${label}？`} className={DIALOG}>
        <form action={formAction} className="space-y-4 p-5">
          <h2 className="text-base font-semibold text-ink">作廢{label}？</h2>
          <p className="text-sm text-muted-foreground">
            作廢後整份提案終止、所有人釋放。理由只留在系辦紀錄，學生的通知只會說「管理員作廢」。
          </p>
          <input type="hidden" name="proposalId" value={proposalId} />
          <input type="hidden" name="requestId" value={requestId} />
          <div>
            <label htmlFor={`void-reason-${proposalId}`} className={LABEL}>
              理由（必填）
            </label>
            <textarea
              id={`void-reason-${proposalId}`}
              name="reason"
              rows={3}
              maxLength={reasonMaxLength}
              className={INPUT}
            />
          </div>
          <Feedback state={state?.ok ? undefined : state} />
          <div className="flex justify-end gap-2 border-t border-border pt-4">
            <button type="button" className={SECONDARY} onClick={dialog.close}>
              先不要
            </button>
            <button type="submit" disabled={pending} className={PRIMARY}>
              {pending ? '處理中…' : '確定作廢'}
            </button>
          </div>
        </form>
      </dialog>
    </div>
  )
}
