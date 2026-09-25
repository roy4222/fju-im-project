'use client'
import { useActionState, useCallback, useEffect, useRef, useState } from 'react'
import { confirmAction, proposeAction, setOpenToJoinAction, terminateAction } from './actions'
import { cn } from '@/shared/cn'

/**
 * 「我的組別」頁會動的部分（票 13）。回饋一律是伺服器回的句子；瀏覽器端不判斷任何規則。
 *
 * 提案的動作列（確認、拒絕、撤回）一直掛在同一個位置：組別成立或提案終止之後那一列的按鈕會消失，
 * 但剛剛那句回饋還留著，使用者看得到「發生了什麼事」。
 */

export type GroupActionState = { ok: boolean; message: string } | undefined

// 外觀照原型（票 38）：主要動作系網橘實心、次要白底細框、輸入框 44px 高與橘色焦點環。
const PRIMARY = 'btn-fju h-11 rounded-lg px-5 text-sm disabled:opacity-60'
const SECONDARY =
  'press inline-flex h-11 items-center justify-center whitespace-nowrap rounded-lg border border-border bg-background px-4 ' +
  'text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-60'
const INPUT =
  'mt-1.5 h-11 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none transition-[border-color,box-shadow] ' +
  'focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25'
const LABEL = 'block text-sm font-semibold'

export function Feedback({ state }: { state: GroupActionState }) {
  if (!state) return null
  return (
    <p
      role={state.ok ? 'status' : 'alert'}
      className={cn(
        'rounded-lg px-4 py-2.5 text-sm',
        state.ok ? 'bg-success-subtle text-success-on-subtle' : 'bg-destructive-subtle text-destructive-on-subtle',
      )}
    >
      {state.message}
    </p>
  )
}

// ── 公開找組員 ──────────────────────────────────────────────────────────────

export function OpenToJoinToggle({ open, requestId }: { open: boolean; requestId: string }) {
  const [state, formAction, pending] = useActionState(setOpenToJoinAction, undefined)
  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="requestId" value={requestId} />
      <input type="hidden" name="open" value={open ? 'false' : 'true'} />
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm">
          公開找組員：<strong>{open ? '已公開' : '未公開'}</strong>
        </span>
        <button type="submit" disabled={pending} className={open ? SECONDARY : PRIMARY}>
          {pending ? '處理中…' : open ? '關閉公開' : '公開找組員'}
        </button>
      </div>
      <Feedback state={state} />
    </form>
  )
}

// ── 發起提案 ────────────────────────────────────────────────────────────────

export function ProposeForm({
  requestId,
  otherSlots,
  requiredOthers,
  groupTypes,
  studentNoMaxLength,
}: {
  requestId: string
  /** 最多可以填幾位同學（每組最多人數 − 1）。 */
  otherSlots: number
  /** 至少要填幾位（每組最少人數 − 1）。 */
  requiredOthers: number
  groupTypes: { value: string; label: string }[]
  studentNoMaxLength: number
}) {
  const [state, formAction, pending] = useActionState(proposeAction, undefined)
  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="requestId" value={requestId} />
      <fieldset>
        <legend className={LABEL}>組別類型</legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {groupTypes.map((type, index) => (
            <label
              key={type.value}
              className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm transition-colors has-checked:border-brand has-checked:bg-brand-subtle/50"
            >
              <input type="radio" name="groupType" value={type.value} defaultChecked={index === 0} className="accent-[var(--primary)]" />
              {type.label}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-2">
        {Array.from({ length: otherSlots }, (_, i) => (
          <div key={i}>
            <label htmlFor={`member-${i + 1}`} className={LABEL}>
              同學 {i + 1} 的學號{i < requiredOthers ? '' : '（可不填）'}
            </label>
            <input
              id={`member-${i + 1}`}
              name="studentNo"
              inputMode="numeric"
              autoComplete="off"
              maxLength={studentNoMaxLength}
              required={i < requiredOthers}
              className={INPUT}
            />
          </div>
        ))}
      </div>
      <Feedback state={state} />
      <button type="submit" disabled={pending} className={PRIMARY}>
        {pending ? '處理中…' : '發起提案'}
      </button>
    </form>
  )
}

// ── 提案的動作列 ────────────────────────────────────────────────────────────

export type MyProposalRole = {
  proposalId: string
  /** 我是提案人。 */
  isProposer: boolean
  /** 我那一列目前的狀態。 */
  myState: 'pending' | 'confirmed' | 'other'
  overdue: boolean
}

function useDialog() {
  const ref = useRef<HTMLDialogElement>(null)
  const open = useCallback(() => ref.current?.showModal(), [])
  const close = useCallback(() => ref.current?.close(), [])
  return { ref, open, close }
}

const TERMINATE_COPY = {
  decline: { button: '拒絕', title: '拒絕這份提案？', body: '拒絕後整份提案會終止，所有人都被釋放；要再組要重新發起。' },
  withdrawConfirmation: {
    button: '撤回同意',
    title: '撤回你的同意？',
    body: '組別成立前撤回同意，整份提案會終止，所有人都被釋放；要再組要重新發起。',
  },
  withdrawProposal: { button: '撤回提案', title: '撤回整份提案？', body: '撤回後提案終止，所有人都被釋放。' },
} as const

type TerminateKind = keyof typeof TERMINATE_COPY

/**
 * 一直掛著的動作列：`proposal` 是 null（沒有進行中的提案）時只剩上一次的回饋。
 * 兩種動作各自一份 `useActionState`，最近的那一句顯示在下面。
 */
export function ProposalActions({
  proposal,
  requestIds,
}: {
  proposal: MyProposalRole | null
  requestIds: { confirm: string; terminate: string }
}) {
  const [confirmState, confirmFormAction, confirming] = useActionState(confirmAction, undefined)
  const [terminateState, terminateFormAction, terminating] = useActionState(terminateAction, undefined)
  const [last, setLast] = useState<'confirm' | 'terminate' | null>(null)
  const [kind, setKind] = useState<TerminateKind>('decline')
  const dialog = useDialog()
  const close = dialog.close

  useEffect(() => {
    if (terminateState) close()
  }, [terminateState, close])

  const feedback = last === 'confirm' ? confirmState : last === 'terminate' ? terminateState : undefined
  const pending = confirming || terminating
  const openDialog = (next: TerminateKind) => {
    setKind(next)
    dialog.open()
  }

  const buttons: TerminateKind[] = []
  if (proposal && !proposal.overdue) {
    if (proposal.isProposer) buttons.push('withdrawProposal')
    else if (proposal.myState === 'pending') buttons.push('decline')
    else if (proposal.myState === 'confirmed') buttons.push('withdrawConfirmation')
  }
  const copy = TERMINATE_COPY[kind]

  return (
    <div className="space-y-3">
      {proposal && !proposal.overdue ? (
        <div className="flex flex-wrap items-center gap-3">
          {proposal.myState === 'pending' ? (
            <form action={confirmFormAction} onSubmit={() => setLast('confirm')}>
              <input type="hidden" name="proposalId" value={proposal.proposalId} />
              <input type="hidden" name="requestId" value={requestIds.confirm} />
              <button type="submit" disabled={pending} className={PRIMARY}>
                {confirming ? '處理中…' : '確認加入'}
              </button>
            </form>
          ) : null}
          {buttons.map((b) => (
            <button key={b} type="button" disabled={pending} className={SECONDARY} onClick={() => openDialog(b)}>
              {TERMINATE_COPY[b].button}
            </button>
          ))}
        </div>
      ) : null}
      <Feedback state={feedback} />
      {proposal ? (
        <dialog
          ref={dialog.ref}
          aria-label={copy.title}
          className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-xl border border-border bg-popover p-0 shadow-xl backdrop:bg-ink/40"
        >
          <form action={terminateFormAction} onSubmit={() => setLast('terminate')} className="p-6">
            <h2 className="text-lg font-extrabold">{copy.title}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{copy.body}</p>
            <input type="hidden" name="proposalId" value={proposal.proposalId} />
            <input type="hidden" name="requestId" value={requestIds.terminate} />
            <input type="hidden" name="kind" value={kind} />
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" className={SECONDARY} onClick={dialog.close}>
                先不要
              </button>
              <button type="submit" disabled={pending} className={PRIMARY}>
                {terminating ? '處理中…' : `確定${copy.button}`}
              </button>
            </div>
          </form>
        </dialog>
      ) : null}
    </div>
  )
}
