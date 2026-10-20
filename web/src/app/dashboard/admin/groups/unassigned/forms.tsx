'use client'
import { createContext, useActionState, useContext, useState, type ReactNode } from 'react'
import { IconUserPlus, IconX } from '@tabler/icons-react'
import { addMemberAction } from '../actions'
import {
  DIALOG,
  Feedback,
  INPUT,
  LABEL,
  PRIMARY,
  SECONDARY,
  useCloseOnSuccess,
  useDialog,
  type AdminGroupActionState,
} from '../admin-group-forms'
import { voidUnassignedProposalAction } from './actions'
import { BTN_ROW } from '@/app/_ui/dashboard/look'

/**
 * 「未分組學生」分頁會動的部分（C3-15；設計方案③ §6.3）：「加入組別」與「終止建立」兩個對話框，理由都可不填。
 *
 * 列表本身是 server 的 `unassigned-list.tsx`，每列只放兩顆小按鈕；對話框與成功回饋各**一份**放在表格外面
 * （同 `member-forms.tsx` 的 `UngroupedStudents`）：加入成功後那一列會消失、終止後那一列的按鈕會換掉，
 * 回饋不能跟著那一列一起不見。「加入組別」用既有的 `addMemberAction`；「終止建立」走本資料夾的 action（既有 `voidProposal`）。
 */

type Size = { min: number; max: number }
export type UnassignedGroupOption = { id: string; code: string; revision: number; memberCount: number }
type JoinTarget = { kind: 'join'; name: string; studentNo: string; openToJoin: boolean }
type VoidTarget = { kind: 'void'; proposalId: string; proposerName: string }

/** 人數和設定不符的提醒句（和 application 的 `groupSizeWarning` 同一句；client 不能引 application）。 */
function sizeHint(count: number, size: Size): string | null {
  if (count < size.min) return `人數與設定不符：${count} 人，少於本屆每組最少 ${size.min} 人`
  if (count > size.max) return `人數與設定不符：${count} 人，超過本屆每組最多 ${size.max} 人`
  return null
}

const OpenContext = createContext<((target: JoinTarget | VoidTarget) => void) | null>(null)

function useOpen() {
  const open = useContext(OpenContext)
  if (!open) throw new Error('UnassignedForms 外面不能用這顆按鈕')
  return open
}

/** 兩個動作共用一份回饋：先後做了加入與終止，頂端只留最後一次的句子。 */
async function dispatch(state: AdminGroupActionState, formData: FormData): Promise<AdminGroupActionState> {
  return formData.get('kind') === 'void' ? voidUnassignedProposalAction(state, formData) : addMemberAction(state, formData)
}

export function UnassignedForms({
  groups,
  size,
  requestIds,
  reasonMaxLength,
  children,
}: {
  groups: UnassignedGroupOption[]
  size: Size
  requestIds: { join: string; void: string }
  reasonMaxLength: number
  children: ReactNode
}) {
  const [state, formAction, pending] = useActionState(dispatch, undefined)
  const dialog = useDialog()
  const [target, setTarget] = useState<JoinTarget | VoidTarget | null>(null)
  const [groupId, setGroupId] = useState('')
  const [reason, setReason] = useState('')
  useCloseOnSuccess(state, dialog.close)
  const group = groups.find((g) => g.id === groupId) ?? groups[0]

  const open = (next: JoinTarget | VoidTarget) => {
    setTarget(next)
    setReason('')
    dialog.open()
  }

  const reasonField = (id: string, placeholder: string) => (
    <div>
      <label htmlFor={id} className={LABEL}>
        理由（可不填）
      </label>
      {/* 受控：被伺服器拒絕時 React 會重設非受控欄位，打好的理由不能跟著不見。 */}
      <textarea
        id={id}
        name="reason"
        rows={3}
        maxLength={reasonMaxLength}
        placeholder={placeholder}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        className={INPUT}
      />
    </div>
  )

  const actions = (submit: string, disabled = false) => (
    <div className="flex justify-end gap-2 pt-1">
      <button type="button" className={SECONDARY} onClick={dialog.close}>
        先不要
      </button>
      <button type="submit" disabled={pending || disabled} className={PRIMARY}>
        {pending ? '處理中…' : submit}
      </button>
    </div>
  )

  return (
    <OpenContext.Provider value={open}>
      {state?.ok ? (
        <div className="px-5 pb-3">
          <Feedback state={state} />
        </div>
      ) : null}
      {children}
      <dialog
        ref={dialog.ref}
        aria-label={
          target?.kind === 'void' ? `終止 ${target.proposerName} 建立中的組別？` : target ? `把 ${target.name} 加入組別` : '加入組別'
        }
        className={DIALOG}
      >
        {target?.kind === 'join' ? (
          <form key={`join-${target.studentNo}-${requestIds.join}`} action={formAction} className="space-y-4 p-5">
            <h2 className="text-lg font-extrabold text-foreground">把 {target.name} 加入組別</h2>
            <p className="text-sm text-muted-foreground">
              {target.studentNo}・{target.openToJoin ? '本人有公開找隊員' : '本人沒有公開找隊員，加入前請先聯絡'}。
              加入後全組會收到通知；成員改變，之後的站內同意書要重新同意。
            </p>
            <input type="hidden" name="kind" value="join" />
            <input type="hidden" name="studentNo" value={target.studentNo} />
            <input type="hidden" name="requestId" value={requestIds.join} />
            <input type="hidden" name="groupId" value={group?.id ?? ''} />
            <input type="hidden" name="revision" value={group?.revision ?? ''} />
            {groups.length > 0 ? (
              <div>
                <label htmlFor="unassigned-join-group" className={LABEL}>
                  組別
                </label>
                <select id="unassigned-join-group" value={group?.id} onChange={(e) => setGroupId(e.target.value)} className={INPUT}>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.code}・目前 {g.memberCount} 人
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <p className="text-sm text-danger">本屆還沒有成立的組別，沒有組可以加入。</p>
            )}
            {group && sizeHint(group.memberCount + 1, size) ? (
              <p className="rounded-lg bg-danger-subtle px-3 py-2 text-sm text-danger-on-subtle">
                {sizeHint(group.memberCount + 1, size)}；系辦調整允許，但請確認這是特殊情況。
              </p>
            ) : null}
            {reasonField('unassigned-join-reason', '例：轉學生，系上安排加入')}
            <Feedback state={state?.ok ? undefined : state} />
            {actions('確認加入', groups.length === 0)}
          </form>
        ) : target?.kind === 'void' ? (
          <form key={`void-${target.proposalId}-${requestIds.void}`} action={formAction} className="space-y-4 p-5">
            <h2 className="text-lg font-extrabold text-foreground">終止 {target.proposerName} 建立中的組別？</h2>
            <p className="text-sm text-muted-foreground">
              終止後這次建立組別不會成立，裡面的同學都回到可加入、可以重新組隊。理由只留在系辦紀錄，學生的紀錄只會寫「系辦終止」。
            </p>
            <input type="hidden" name="kind" value="void" />
            <input type="hidden" name="proposalId" value={target.proposalId} />
            <input type="hidden" name="proposerName" value={target.proposerName} />
            <input type="hidden" name="requestId" value={requestIds.void} />
            {reasonField('unassigned-void-reason', '例：成員之間已另外安排')}
            <Feedback state={state?.ok ? undefined : state} />
            {actions('確定終止')}
          </form>
        ) : null}
      </dialog>
    </OpenContext.Provider>
  )
}

export function JoinGroupButton({ name, studentNo, openToJoin }: { name: string; studentNo: string; openToJoin: boolean }) {
  const open = useOpen()
  return (
    <button
      type="button"
      className={BTN_ROW}
      aria-label={`加入組別：${name}`}
      onClick={() => open({ kind: 'join', name, studentNo, openToJoin })}
    >
      <IconUserPlus aria-hidden />
      加入組別
    </button>
  )
}

export function VoidProposalButton({ proposalId, proposerName }: { proposalId: string; proposerName: string }) {
  const open = useOpen()
  return (
    <button
      type="button"
      className={BTN_ROW}
      aria-label={`終止建立：${proposerName}`}
      onClick={() => open({ kind: 'void', proposalId, proposerName })}
    >
      <IconX aria-hidden />
      終止建立
    </button>
  )
}
