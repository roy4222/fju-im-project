'use client'
import { useActionState, useCallback, useEffect, useRef, useState } from 'react'
import { saveGroupingSettingsAction, voidProposalAction } from './actions'
import { ALERT, DIALOG as LOOK_DIALOG, DIALOG_TITLE, INPUT as LOOK_INPUT, NOTE } from '@/app/_ui/dashboard/look'
import { buttonVariants } from '@/app/_ui/ui/button'
import { IconSettings } from '@tabler/icons-react'

/**
 * 分組總覽會動的部分（票 13）：分組設定對話框、作廢提案對話框。回饋一律是伺服器回的句子。
 */

export type AdminGroupActionState = { ok: boolean; message: string } | undefined

// 外觀照原型（票 36）：橘色主要動作、白框次要動作、h-10 輸入框、原型 Dialog 的圓角與淡灰遮罩。
// 這幾個常數分組、評分、簽核、精選、學生與老師的簽核表態都在用，改這裡會一起換樣子。
export const PRIMARY = 'btn-fju h-10 px-5 text-sm disabled:pointer-events-none disabled:opacity-60'
export const SECONDARY = buttonVariants({ variant: 'outline', size: 'lg', className: 'press rounded-lg px-3 disabled:opacity-60' })
export const INPUT = `mt-1.5 min-h-10 py-2 ${LOOK_INPUT.replace('h-10 ', '')}`
export const LABEL = 'block text-sm font-semibold text-foreground'
export const DIALOG = LOOK_DIALOG.lg

export function Feedback({ state }: { state: AdminGroupActionState }) {
  if (!state) return null
  return (
    <p role={state.ok ? 'status' : 'alert'} className={state.ok ? NOTE : ALERT}>
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
      <button type="button" className={SECONDARY} onClick={dialog.open}>
        <IconSettings aria-hidden />
        分組設定
      </button>
      <Feedback state={state?.ok ? state : undefined} />
      <dialog ref={dialog.ref} aria-label={`${cohortCode} 的分組設定`} className={DIALOG}>
        <form action={formAction} className="space-y-4 p-5">
          <h2 className={DIALOG_TITLE}>{cohortCode} 的分組設定</h2>
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
          <div className="flex justify-end gap-2 pt-1">
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
          <h2 className={DIALOG_TITLE}>作廢{label}？</h2>
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
          <div className="flex justify-end gap-2 pt-1">
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
