'use client'
import { useActionState, useCallback, useEffect, useRef, useState } from 'react'
import { IconPlus } from '@tabler/icons-react'
import { AvatarImg } from '@/app/_ui/avatar/avatar-img'
import type { AvatarUser } from '@/application/accounts'
import { confirmAction, lookupStudentAction, proposeAction, requestOpportunityAction, setOpenToJoinAction, terminateAction } from './actions'
import { cn } from '@/shared/cn'

/**
 * 「我的組」頁會動的部分（票 13；C3-11 規格③ §5.2、§7.3）。回饋一律是伺服器回的句子；瀏覽器端不判斷任何規則。
 *
 * 建立中組別的動作列（確認、拒絕、撤回）一直掛在同一個位置：組別成立或終止之後那一列的按鈕會消失，
 * 但剛剛那句回饋還留著，使用者看得到「發生了什麼事」。
 */

export type GroupActionState = { ok: boolean; message: string } | undefined

/** 建立組別表單即時查學號的結果：找得到就給頭像與姓名，找不到只有一句話（不說是哪一種原因）。 */
export type StudentLookupState =
  | { readonly found: true; readonly name: string; readonly studentNo: string; readonly avatar: AvatarUser }
  | { readonly found: false; readonly message: string }

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

// ── 公開找隊員 ──────────────────────────────────────────────────────────────

export function OpenToJoinToggle({ open, requestId }: { open: boolean; requestId: string }) {
  const [state, formAction, pending] = useActionState(setOpenToJoinAction, undefined)
  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="requestId" value={requestId} />
      <input type="hidden" name="open" value={open ? 'false' : 'true'} />
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm">
          公開找隊員：<strong>{open ? '已公開' : '未公開'}</strong>
        </span>
        <button type="submit" disabled={pending} className={open ? SECONDARY : PRIMARY}>
          {pending ? '處理中…' : open ? '關閉公開' : '公開找隊員'}
        </button>
      </div>
      <Feedback state={state} />
    </form>
  )
}

// ── 建立組別（送出邀請） ────────────────────────────────────────────────────

export type GroupTypeOption = { value: string; label: string; hint: string }
export type OpportunityOption = { value: string; label: string }

/** 第一格：自己（頭像、姓名、學號、「你」膠囊），不是輸入欄。 */
export type ProposerSeat = { name: string; studentNo: string; avatar: AvatarUser }

/**
 * 建立組別表單（模擬圖「我的組-建立組別」）：類型卡（產學合作才多一欄「合作案」）、第一格是自己、
 * 其餘每格輸入學號後失焦即時查詢（頭像＋姓名，查不到寫一句）、「＋再加一位（可不填）」到人數上限、「送出邀請」。
 * `invite` 是「找隊員」按「邀請加入」帶過來的學號（`?invite=`），只是初值；頁面用 `key` 在清單變動時重掛。
 */
export function ProposeForm({
  requestId,
  otherSlots,
  requiredOthers,
  groupTypes,
  opportunities,
  studentNoMaxLength,
  me,
  invite,
}: {
  requestId: string
  /** 最多可以填幾位同學（每組最多人數 − 1）。 */
  otherSlots: number
  /** 至少要填幾位（每組最少人數 − 1）。 */
  requiredOthers: number
  groupTypes: GroupTypeOption[]
  /** 已發布的合作案（公司・案名・負責老師）；選「產學合作」才出現。 */
  opportunities: OpportunityOption[]
  studentNoMaxLength: number
  me: ProposerSeat
  invite: string[]
}) {
  const [state, formAction, pending] = useActionState(proposeAction, undefined)
  const [groupType, setGroupType] = useState(groupTypes[0]?.value ?? 'general')
  // 一開始顯示的格數：至少要填的人數，或預填進來的人數（較多者），都不超過上限。
  const [slots, setSlots] = useState(Math.min(otherSlots, Math.max(requiredOthers, invite.length)))
  // 停在舊頁面時才會撞到分組截止；伺服器的句子尾巴叫人聯絡系辦，學生頁不寫（Q69），只留「分組期已經結束…」。
  const shown = state && !state.ok ? { ...state, message: state.message.replace(/；需要分組請聯絡系辦。$/, '。') } : state
  return (
    <form action={formAction} className="space-y-5">
      <input type="hidden" name="requestId" value={requestId} />
      <fieldset>
        <legend className={LABEL}>組別類型</legend>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {groupTypes.map((type) => (
            <label
              key={type.value}
              className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-border px-3 py-2.5 text-sm transition-colors has-checked:border-brand has-checked:bg-brand-subtle/50"
            >
              <input
                type="radio"
                name="groupType"
                value={type.value}
                checked={groupType === type.value}
                onChange={() => setGroupType(type.value)}
                className="mt-0.5 accent-[var(--primary)]"
              />
              <span className="min-w-0">
                <span className="block font-semibold">{type.label}</span>
                <span className="block text-xs text-muted-foreground">{type.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      {groupType === 'industry' ? (
        <div>
          <label htmlFor="opportunityId" className={LABEL}>
            合作案
          </label>
          {opportunities.length === 0 ? (
            <p className="mt-1.5 text-sm text-muted-foreground">目前沒有已發布的合作案，請先選一般專題，之後再請組長選案。</p>
          ) : (
            <select id="opportunityId" name="opportunityId" defaultValue="" className={INPUT}>
              <option value="">請選合作案</option>
              {opportunities.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          )}
          <p className="mt-1 text-xs text-muted-foreground">成立後會通知負責老師確認是否指導；被婉拒可以在「我的組」重選。</p>
        </div>
      ) : null}
      <fieldset>
        <legend className={LABEL}>組員</legend>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          <div className="flex min-h-11 items-center gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
            <AvatarImg user={me.avatar} size={32} decorative />
            <span className="min-w-0">
              <span className="block truncate font-semibold">
                {me.name}
                <span className="ml-2 inline-flex items-center rounded-full bg-brand px-2 py-0.5 text-[11px] font-bold text-brand-foreground">你</span>
              </span>
              <span className="tabular block text-xs text-muted-foreground">{me.studentNo}</span>
            </span>
          </div>
          {Array.from({ length: slots }, (_, i) => (
            <MemberSlot key={i} index={i} required={i < requiredOthers} defaultValue={invite[i] ?? ''} maxLength={studentNoMaxLength} />
          ))}
        </div>
        {slots < otherSlots ? (
          <button type="button" onClick={() => setSlots((n) => Math.min(otherSlots, n + 1))} className={cn(SECONDARY, 'mt-3 h-10 gap-1 px-3')}>
            <IconPlus className="size-4" aria-hidden />
            ＋再加一位（可不填）
          </button>
        ) : null}
      </fieldset>
      <Feedback state={shown} />
      <button type="submit" disabled={pending} className={PRIMARY}>
        {pending ? '處理中…' : '送出邀請'}
      </button>
    </form>
  )
}

/** 一格同學學號：失焦（或預填）就查一次，底下顯示頭像＋姓名或「找不到這個學號，或他已經有組別」。 */
function MemberSlot({ index, required, defaultValue, maxLength }: { index: number; required: boolean; defaultValue: string; maxLength: number }) {
  const [result, setResult] = useState<StudentLookupState | null>(null)
  const lookedUp = useRef<string>('')
  const lookup = useCallback(async (raw: string) => {
    const no = raw.trim()
    if (no === lookedUp.current) return
    lookedUp.current = no
    if (!no) {
      setResult(null)
      return
    }
    const found = await lookupStudentAction(no)
    // 查詢期間欄位又被改過：這一筆結果已經過時，不顯示。
    if (lookedUp.current === no) setResult(found)
  }, [])
  useEffect(() => {
    if (defaultValue) void lookup(defaultValue)
  }, [defaultValue, lookup])
  const id = `member-${index + 1}`
  return (
    <div>
      <label htmlFor={id} className={LABEL}>
        同學 {index + 1} 的學號{required ? '' : '（可不填）'}
      </label>
      <input
        id={id}
        name="studentNo"
        inputMode="numeric"
        autoComplete="off"
        maxLength={maxLength}
        required={required}
        defaultValue={defaultValue}
        onBlur={(event) => void lookup(event.currentTarget.value)}
        className={INPUT}
      />
      <p aria-live="polite" className="mt-1.5 flex min-h-6 items-center gap-2 text-xs">
        {result?.found ? (
          <>
            <AvatarImg user={result.avatar} size={24} decorative />
            <span className="font-semibold text-foreground">{result.name}</span>
          </>
        ) : result ? (
          <span className="text-destructive">{result.message}</span>
        ) : null}
      </p>
    </div>
  )
}

// ── 已成組的產學組：組長選合作案 ───────────────────────────────────────────

/** 「還沒有合作案」時組長選案（C3-11；規格③ §7.3）：走 C3-09 的 `request`，成 `pending` 等負責老師確認。 */
export function RequestOpportunityForm({
  groupId,
  revision,
  requestId,
  opportunities,
}: {
  groupId: string
  revision: number
  requestId: string
  opportunities: OpportunityOption[]
}) {
  const [state, formAction, pending] = useActionState(requestOpportunityAction, undefined)
  return (
    <form action={formAction} className="flex w-full flex-col gap-2 sm:max-w-xl">
      <input type="hidden" name="requestId" value={requestId} />
      <input type="hidden" name="groupId" value={groupId} />
      <input type="hidden" name="revision" value={revision} />
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1">
          <label htmlFor="request-opportunity" className={LABEL}>
            選合作案
          </label>
          <select id="request-opportunity" name="opportunityId" defaultValue="" className={INPUT}>
            <option value="">請選合作案</option>
            {opportunities.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" disabled={pending || opportunities.length === 0} className={PRIMARY}>
          {pending ? '處理中…' : '送出'}
        </button>
      </div>
      {opportunities.length === 0 ? <p className="text-xs text-muted-foreground">目前沒有已發布的合作案。</p> : null}
      <Feedback state={state} />
    </form>
  )
}

// ── 建立中組別的動作列 ───────────────────────────────────────────────────────

export type MyProposalRole = {
  proposalId: string
  /** 我是發起人。 */
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
  decline: { button: '拒絕', title: '拒絕這份邀請？', body: '拒絕後這次建立組別就不會成立，大家都可以重新組隊；要再組要重新建立組別。' },
  withdrawConfirmation: {
    button: '撤回同意',
    title: '撤回你的同意？',
    body: '組別成立前撤回同意，這次建立組別就不會成立，大家都可以重新組隊；要再組要重新建立組別。',
  },
  withdrawProposal: { button: '撤回', title: '撤回這次建立組別？', body: '撤回後這次建立組別不會成立，大家都可以重新組隊。' },
} as const

type TerminateKind = keyof typeof TERMINATE_COPY

/**
 * 一直掛著的動作列：`proposal` 是 null（沒有建立中的組別）時只剩上一次的回饋。
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
