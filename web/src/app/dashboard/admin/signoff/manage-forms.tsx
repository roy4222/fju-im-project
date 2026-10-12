'use client'
import { useActionState } from 'react'
import { remindAction, restartAction, voidAction } from './actions'
import type { SignoffActionState } from './signoff-forms'
import { DIALOG, Feedback, INPUT, LABEL, SECONDARY, useCloseOnSuccess, useDialog } from '@/app/dashboard/admin/groups/admin-group-forms'
import { buttonVariants } from '@/app/_ui/ui/button'

/**
 * 系辦在版本頁上的管理動作（票 26；原型「提醒未同意者」「重置：列出將失效的簽署、原因必填」）。
 * 重置、重開、作廢都要填理由；提醒同一版 24 小時內一次。規則都在用例裡判，畫面只顯示伺服器回的句子。
 * **這裡沒有任何替人表態的按鈕。**
 *
 * 重置、重開、作廢放在版本頁的「危險操作」區（第三波 §9 規則 1、AC-37）：確認視窗寫對象、範圍、後果、能不能恢復。
 */

/** 危險動作的按鈕與確認鈕：淡紅，跟日常的白底按鈕分開。 */
const DANGER = buttonVariants({ variant: 'destructive', size: 'lg', className: 'press rounded-lg px-3 disabled:opacity-60' })

/** 確認視窗裡的「對象／範圍／後果／能不能恢復」（第三波 §9 規則 1）。 */
export type DangerFacts = { target: string; scope: string; effect: string; undo: string }

function Facts({ facts }: { facts: DangerFacts }) {
  const rows: [string, string][] = [
    ['對象', facts.target],
    ['範圍', facts.scope],
    ['後果', facts.effect],
    ['能不能恢復', facts.undo],
  ]
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm" data-testid="danger-facts">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="whitespace-nowrap text-muted-foreground">{k}</dt>
          <dd className="text-foreground">{v}</dd>
        </div>
      ))}
    </dl>
  )
}

/** 提醒未同意者；不能按時（已提醒過、不在收集中）按鈕不可用，旁邊寫原因。 */
export function RemindButton({ versionId, requestId, blockedReason }: { versionId: string; requestId: string; blockedReason: string | null }) {
  const [state, formAction, pending] = useActionState<SignoffActionState, FormData>(remindAction, undefined)
  return (
    <form action={formAction} className="space-y-2" aria-label="提醒未同意者">
      <input type="hidden" name="versionId" value={versionId} />
      <input type="hidden" name="requestId" value={requestId} />
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" className={SECONDARY} disabled={pending || blockedReason !== null}>
          {pending ? '送出中…' : '提醒未同意者'}
        </button>
        {blockedReason ? (
          <span className="text-xs text-muted-foreground" data-testid="remind-blocked">
            {blockedReason}
          </span>
        ) : null}
      </div>
      <Feedback state={state} />
    </form>
  )
}

/** 重置（收集中、等老師、已完成）或重開新版（退回、已失效、已作廢）：建新版、參與者依此刻重算；成功後直接帶到新版。 */
export function RestartButton({
  versionId,
  requestId,
  kind,
  label,
  affected,
  facts,
  reasonMaxLength,
}: {
  versionId: string
  requestId: string
  kind: 'reset' | 'reopen'
  label: string
  /** 將失效（不計入新版）的簽署，給對話框列出。 */
  affected: readonly string[]
  facts: DangerFacts
  reasonMaxLength: number
}) {
  const [state, formAction, pending] = useActionState<SignoffActionState, FormData>(restartAction, undefined)
  const dialog = useDialog()
  useCloseOnSuccess(state, dialog.close)
  return (
    <div className="space-y-2">
      <button type="button" className={DANGER} onClick={dialog.open}>
        {label}
      </button>
      <dialog ref={dialog.ref} aria-label={`${label}？`} className={DIALOG}>
        <form action={formAction} className="space-y-4 p-5">
          <input type="hidden" name="versionId" value={versionId} />
          <input type="hidden" name="requestId" value={requestId} />
          <input type="hidden" name="kind" value={kind} />
          <h2 className="text-lg font-extrabold text-foreground">{label}？</h2>
          <Facts facts={facts} />
          {affected.length > 0 ? (
            <div className="rounded-lg bg-surface px-3 py-2 text-sm" data-testid="restart-affected">
              <p className="font-medium text-foreground">將作廢的回覆（{affected.length}）</p>
              <p className="text-xs text-muted-foreground">{affected.join('、')}</p>
            </div>
          ) : null}
          <div>
            <label htmlFor={`restart-reason-${versionId}`} className={LABEL}>
              理由（必填）
            </label>
            <textarea id={`restart-reason-${versionId}`} name="reason" rows={3} maxLength={reasonMaxLength} className={INPUT} />
          </div>
          <Feedback state={state?.ok ? undefined : state} />
          <div className="flex justify-end gap-2 border-t border-border pt-4">
            <button type="button" className={SECONDARY} onClick={dialog.close}>
              先不要
            </button>
            <button type="submit" disabled={pending} className={DANGER}>
              {pending ? '處理中…' : `確定${label}`}
            </button>
          </div>
        </form>
      </dialog>
    </div>
  )
}

/** 作廢目前這一版：之後誰都不能再表態。 */
export function VoidButton({
  versionId,
  requestId,
  facts,
  reasonMaxLength,
}: {
  versionId: string
  requestId: string
  facts: DangerFacts
  reasonMaxLength: number
}) {
  const [state, formAction, pending] = useActionState<SignoffActionState, FormData>(voidAction, undefined)
  const dialog = useDialog()
  useCloseOnSuccess(state, dialog.close)
  return (
    <div className="space-y-2">
      <button type="button" className={DANGER} onClick={dialog.open}>
        作廢
      </button>
      <Feedback state={state?.ok ? state : undefined} />
      <dialog ref={dialog.ref} aria-label="作廢這一版？" className={DIALOG}>
        <form action={formAction} className="space-y-4 p-5">
          <input type="hidden" name="versionId" value={versionId} />
          <input type="hidden" name="requestId" value={requestId} />
          <h2 className="text-lg font-extrabold text-foreground">作廢這一版？</h2>
          <Facts facts={facts} />
          <div>
            <label htmlFor={`void-reason-${versionId}`} className={LABEL}>
              理由（必填）
            </label>
            <textarea id={`void-reason-${versionId}`} name="reason" rows={3} maxLength={reasonMaxLength} className={INPUT} />
          </div>
          <Feedback state={state?.ok ? undefined : state} />
          <div className="flex justify-end gap-2 border-t border-border pt-4">
            <button type="button" className={SECONDARY} onClick={dialog.close}>
              先不要
            </button>
            <button type="submit" disabled={pending} className={DANGER}>
              {pending ? '處理中…' : '確定作廢'}
            </button>
          </div>
        </form>
      </dialog>
    </div>
  )
}
