'use client'
import { createContext, useActionState, useContext, useState, type ReactNode } from 'react'
import { addMemberAction, changeLeaderAction, removeMemberAction } from './actions'
import { DIALOG, Feedback, INPUT, LABEL, PRIMARY, SECONDARY, useCloseOnSuccess, useDialog, type AdminGroupActionState } from './admin-group-forms'

const MemberMessage = createContext<((state: AdminGroupActionState) => void) | null>(null)

/** 列移除或換組長後按鈕會卸載，回執留在頁面層。 */
export function MemberFeedback({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AdminGroupActionState>()
  return <MemberMessage.Provider value={setState}><Feedback state={state} />{children}</MemberMessage.Provider>
}

function useMemberAction(command: typeof removeMemberAction) {
  const publish = useContext(MemberMessage)
  const result = useActionState(async (previous: AdminGroupActionState, data: FormData) => {
    publish?.(undefined)
    const next = await command(previous, data)
    if (next?.ok) publish?.(next)
    return next
  }, undefined)
  return { result, shared: publish !== null }
}

type Size = { min: number; max: number }
export type GroupDetailMember = { userId: string; name: string; studentNo: string | null; isLeader: boolean }
export type GroupDetailHistory = { key: string; atLabel: string; text: string; reason: string | null }
export type GroupHistoryOutcome = { ok: true; history: GroupDetailHistory[] } | { ok: false; message: string }
type DetailGroup = { id: string; code: string; revision: number; members: readonly GroupDetailMember[] }
const ROW = 'rounded-lg border border-border px-3 py-2 text-sm font-semibold hover:bg-muted disabled:opacity-50 pointer-coarse:min-h-11 pointer-coarse:min-w-11'

function Reason({ id, maxLength }: { id: string; maxLength: number }) {
  const [value, setValue] = useState('')
  return <div>
    <label htmlFor={id} className={LABEL}>理由（可不填）</label>
    <textarea id={id} name="reason" rows={3} value={value} onChange={(e) => setValue(e.target.value)} maxLength={maxLength} className={INPUT} />
  </div>
}

function Hidden({ group, requestId }: { group: { id: string; revision: number }; requestId: string }) {
  return <>
    <input type="hidden" name="groupId" value={group.id} />
    <input type="hidden" name="revision" value={group.revision} />
    <input type="hidden" name="requestId" value={requestId} />
  </>
}

function SizeReminder({ count, size }: { count: number; size: Size }) {
  const bound = count < size.min ? `少於本屆每組最少 ${size.min} 人` : count > size.max ? `超過本屆每組最多 ${size.max} 人` : null
  return bound ? <p className="rounded-lg bg-warning-subtle p-3 text-sm text-warning-on-subtle">人數與設定不符：{count} 人，{bound}；系辦調整允許，但請確認這是特殊情況。</p> : null
}

function Submit({ pending, disabled = false, label, close }: { pending: boolean; disabled?: boolean; label: string; close: () => void }) {
  return <div className="flex justify-end gap-2">
    <button type="button" className={SECONDARY} onClick={close}>先不要</button>
    <button type="submit" className={PRIMARY} disabled={pending || disabled}>{pending ? '處理中…' : label}</button>
  </div>
}

/** 卡片加入入口：同屆可加入的學生由總覽一次帶入。 */
export function AddMemberButton({ group, students, size, requestId, reasonMaxLength }: {
  group: DetailGroup
  students: readonly { name: string; studentNo: string; inProposal: boolean }[]
  size: Size
  requestId: string
  reasonMaxLength: number
}) {
  const [state, action, pending] = useActionState(addMemberAction, undefined)
  const dialog = useDialog()
  useCloseOnSuccess(state, dialog.close)
  const available = students.filter((s) => !s.inProposal)
  return <div>
    <button type="button" className={ROW} onClick={dialog.open} aria-label={`加人：${group.code}`}>＋加人</button>
    <Feedback state={state?.ok ? state : undefined} />
    <dialog ref={dialog.ref} className={DIALOG} aria-label={`把學生加入 ${group.code}`}>
      <form key={`${group.revision}-${requestId}`} action={action} className="space-y-4 p-5">
        <h2 className="text-lg font-bold">把學生加入 {group.code}</h2>
        <Hidden group={group} requestId={requestId} />
        <label className={LABEL} htmlFor={`add-${group.id}-student`}>未分組學生</label>
        <select id={`add-${group.id}-student`} name="studentNo" className={INPUT} defaultValue="">
          <option value="" disabled>請選一位學生</option>
          {available.map((s) => <option key={s.studentNo} value={s.studentNo}>{s.name}（{s.studentNo}）</option>)}
        </select>
        {available.length === 0 ? <p>目前沒有可加入的學生。</p> : null}
        <SizeReminder count={group.members.length + 1} size={size} />
        <Reason id={`add-${group.id}-reason`} maxLength={reasonMaxLength} />
        <Feedback state={state?.ok ? undefined : state} />
        <Submit pending={pending} disabled={available.length === 0} label="確認加入" close={dialog.close} />
      </form>
    </dialog>
  </div>
}

/** 卡片可以選成員；詳情列直接指定成員。 */
export function RemoveMemberButton({ group, member, size, requestId, reasonMaxLength }: {
  group: DetailGroup
  member?: GroupDetailMember
  size: Size
  requestId: string
  reasonMaxLength: number
}) {
  const { result: [state, action, pending], shared } = useMemberAction(removeMemberAction)
  const dialog = useDialog()
  const [selected, setSelected] = useState(member?.userId ?? '')
  useCloseOnSuccess(state, dialog.close)
  const target = group.members.find((m) => m.userId === (member?.userId ?? selected))
  const single = group.members.length <= 1
  return <div>
    <button type="button" className={ROW} disabled={single} onClick={dialog.open} aria-label={member ? `移除：${member.name}` : `移除組員：${group.code}`}>移除</button>
    {single ? <p className="text-xs text-muted-foreground">只剩一人時不能再移出。</p> : null}
    <Feedback state={!shared && state?.ok ? state : undefined} />
    <dialog ref={dialog.ref} className={DIALOG} aria-label={`移除 ${group.code} 的組員`}>
      <form key={`${group.revision}-${target?.userId ?? ''}`} action={action} className="space-y-4 p-5">
        <h2 className="text-lg font-bold">移除 {group.code} 的組員</h2>
        <Hidden group={group} requestId={requestId} />
        {member ? <><input type="hidden" name="userId" value={member.userId} /><p>移除 {member.name}</p></> : <>
          <label htmlFor={`remove-${group.id}-member`} className={LABEL}>要移除的組員</label>
          <select id={`remove-${group.id}-member`} name="userId" className={INPUT} value={selected} onChange={(e) => setSelected(e.target.value)}>
            <option value="" disabled>請選一位組員</option>
            {group.members.map((m) => <option key={m.userId} value={m.userId}>{m.name}{m.isLeader ? '（組長）' : ''}</option>)}
          </select>
        </>}
        {target?.isLeader ? <>
          <label htmlFor={`remove-${group.id}-successor`} className={LABEL}>接任組長（{target.name} 是組長，必填）</label>
          <select id={`remove-${group.id}-successor`} name="successorLeaderUserId" className={INPUT} defaultValue="">
            <option value="" disabled>請選一位留在組裡的成員</option>
            {group.members.filter((m) => m.userId !== target.userId).map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}
          </select>
        </> : null}
        <p className="text-sm text-muted-foreground">移除後回到未分組；成員變更後，站內同意書需要重新同意。</p>
        <SizeReminder count={group.members.length - 1} size={size} />
        <Reason id={`remove-${group.id}-${member?.userId ?? 'pick'}-reason`} maxLength={reasonMaxLength} />
        <Feedback state={state?.ok ? undefined : state} />
        <Submit pending={pending} label="確定移除" close={dialog.close} />
      </form>
    </dialog>
  </div>
}

export function SetLeaderButton({ group, member, requestId, reasonMaxLength }: {
  group: DetailGroup
  member: GroupDetailMember
  requestId: string
  reasonMaxLength: number
}) {
  const { result: [state, action, pending], shared } = useMemberAction(changeLeaderAction)
  const dialog = useDialog()
  useCloseOnSuccess(state, dialog.close)
  return <div>
    <button type="button" className={ROW} onClick={dialog.open} aria-label={`設為組長：${member.name}`}>設為組長</button>
    <Feedback state={!shared && state?.ok ? state : undefined} />
    <dialog ref={dialog.ref} className={DIALOG} aria-label={`把 ${group.code} 的組長換成 ${member.name}？`}>
      <form key={`${group.revision}-${member.userId}`} action={action} className="space-y-4 p-5">
        <h2 className="text-lg font-bold">把 {group.code} 的組長換成 {member.name}？</h2>
        <Hidden group={group} requestId={requestId} />
        <input type="hidden" name="newLeaderUserId" value={member.userId} />
        <p>成員沒有改變，不需要重簽；全組會收到通知。</p>
        <Reason id={`leader-${group.id}-${member.userId}-reason`} maxLength={reasonMaxLength} />
        <Feedback state={state?.ok ? undefined : state} />
        <Submit pending={pending} label="確定更換" close={dialog.close} />
      </form>
    </dialog>
  </div>
}
