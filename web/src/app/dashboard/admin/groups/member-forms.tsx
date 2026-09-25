'use client'
import { useActionState, useEffect, useState } from 'react'
import { addMemberAction, changeLeaderAction, removeMemberAction } from './actions'
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
} from './admin-group-forms'
import { IconUserPlus } from '@tabler/icons-react'
import { PANEL_TABLE_HEAD, PANEL_TABLE_ROW, PanelEmpty, Pill } from '@/app/_ui/dashboard/primitives'
import { BTN_ROW } from '@/app/_ui/dashboard/look'

/** 組別詳情：原型是從右邊滑出的側板（Sheet）；這裡用同一個原生對話框，只把它放到右側、滿高。 */
const SHEET =
  'm-0 ml-auto h-dvh max-h-dvh w-[min(30rem,100vw)] overflow-y-auto border-0 border-l border-border bg-popover p-0 text-sm text-popover-foreground shadow-xl backdrop:bg-black/10 backdrop:backdrop-blur-xs'

/**
 * 票 14：管理員加入組員、組別詳情（移出、換組長、異動歷程）。原型 `JoinGroupDialog`、`group-detail-sheet`。
 *
 * 人數和設定不符只提醒不擋（2026-09-24 定案）；畫面上的提醒是預覽，最後以伺服器回執為準。
 * 回饋一律是伺服器回的句子。
 */

type Size = { min: number; max: number }

/** 人數和設定不符的提醒句（和 application 的 `groupSizeWarning` 同一句；client 不能引 application）。 */
function sizeHint(count: number, size: Size): string | null {
  if (count < size.min) return `人數與設定不符：${count} 人，少於本屆每組最少 ${size.min} 人`
  if (count > size.max) return `人數與設定不符：${count} 人，超過本屆每組最多 ${size.max} 人`
  return null
}

function SizeReminder({ text }: { text: string | null }) {
  if (!text) return null
  return (
    <p className="rounded-lg bg-danger-subtle px-3 py-2 text-sm text-danger-on-subtle">
      {text}；系辦調整允許，但請確認這是特殊情況。
    </p>
  )
}

/**
 * 理由欄。受控：React 在 action 回來後會重設表單裡**非受控**的欄位，被伺服器拒絕（例如忘了選接任）時
 * 已經打好的理由不能跟著不見。
 */
function ReasonField({ id, maxLength, placeholder }: { id: string; maxLength: number; placeholder: string }) {
  const [value, setValue] = useState('')
  return (
    <div>
      <label htmlFor={id} className={LABEL}>
        理由（必填）
      </label>
      <textarea
        id={id}
        name="reason"
        rows={3}
        maxLength={maxLength}
        placeholder={placeholder}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className={INPUT}
      />
    </div>
  )
}

/** 受控的下拉選單（理由同）：第一個選項是「請選…」的空值。 */
function MemberSelect({
  id,
  name,
  label,
  placeholder,
  options,
}: {
  id: string
  name: string
  label: string
  placeholder: string
  options: GroupDetailMember[]
}) {
  const [value, setValue] = useState('')
  return (
    <div>
      <label htmlFor={id} className={LABEL}>
        {label}
      </label>
      <select id={id} name={name} value={value} onChange={(e) => setValue(e.target.value)} className={INPUT}>
        <option value="" disabled>
          {placeholder}
        </option>
        {options.map((m) => (
          <option key={m.userId} value={m.userId}>
            {m.name}
          </option>
        ))}
      </select>
    </div>
  )
}

function Actions({
  pending,
  disabled = false,
  cancel,
  submit,
  onCancel,
}: {
  pending: boolean
  disabled?: boolean
  cancel: string
  submit: string
  onCancel: () => void
}) {
  return (
    <div className="flex justify-end gap-2 pt-1">
      <button type="button" className={SECONDARY} onClick={onCancel}>
        {cancel}
      </button>
      <button type="submit" disabled={pending || disabled} className={PRIMARY}>
        {pending ? '處理中…' : submit}
      </button>
    </div>
  )
}

/** 加入對話框可選的組別。 */
export type JoinableGroup = { id: string; code: string; revision: number; memberCount: number }
export type UngroupedRow = { name: string; studentNo: string; openToJoin: boolean; inProposal: boolean }

/**
 * 「未分組學生」整段（原型 `JoinGroupDialog`）：表格＋每列「加入某組」＋**一個**共用的加入對話框。
 * 對話框與回饋放在表格外面：加入成功後那一列會從表格消失，回饋不能跟著那一列一起不見。
 */
export function UngroupedStudents({
  students,
  groups,
  size,
  requestId,
  reasonMaxLength,
}: {
  students: UngroupedRow[]
  groups: JoinableGroup[]
  size: Size
  requestId: string
  reasonMaxLength: number
}) {
  const [state, formAction, pending] = useActionState(addMemberAction, undefined)
  const dialog = useDialog()
  const [student, setStudent] = useState<UngroupedRow | null>(null)
  const [groupId, setGroupId] = useState('')
  useCloseOnSuccess(state, dialog.close)
  const target = groups.find((g) => g.id === groupId) ?? groups[0]

  const pick = (row: UngroupedRow) => {
    setStudent(row)
    dialog.open()
  }

  return (
    <div>
      {state?.ok ? (
        <div className="px-5 pb-3">
          <Feedback state={state} />
        </div>
      ) : null}
      {students.length === 0 ? (
        <PanelEmpty title="本屆學生都分好組了" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[36rem] text-sm">
            <thead>
              <tr className={PANEL_TABLE_HEAD}>
                <th scope="col" className="px-5 py-2.5 font-semibold">姓名</th>
                <th scope="col" className="px-4 py-2.5 font-semibold">學號</th>
                <th scope="col" className="px-4 py-2.5 font-semibold">找組員</th>
                <th scope="col" className="px-4 py-2.5 font-semibold">提案</th>
                <th scope="col" className="px-5 py-2.5">
                  <span className="sr-only">動作</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {students.map((u) => (
                <tr key={u.studentNo} className={PANEL_TABLE_ROW}>
                  <td className="px-5 py-2.5 font-semibold">{u.name}</td>
                  <td className="tabular px-4 py-2.5">{u.studentNo}</td>
                  <td className="px-4 py-2.5">{u.openToJoin ? <Pill tone="brand">公開找組員</Pill> : <Pill>未公開</Pill>}</td>
                  <td className="px-4 py-2.5 text-xs text-muted-foreground">{u.inProposal ? '提案等待確認中' : '—'}</td>
                  <td className="px-5 py-2.5 text-right">
                    <button type="button" className={BTN_ROW} aria-label={`加入某組：${u.name}`} onClick={() => pick(u)}>
                      <IconUserPlus aria-hidden />
                      加入某組
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <dialog ref={dialog.ref} aria-label={student ? `把 ${student.name} 加入組別` : '加入組別'} className={DIALOG}>
        {student ? (
          <form key={`${student.studentNo}-${requestId}`} action={formAction} className="space-y-4 p-5">
            <h2 className="text-lg font-extrabold text-foreground">把 {student.name} 加入組別</h2>
            <p className="text-sm text-muted-foreground">
              {student.studentNo}・{student.openToJoin ? '本人有公開找組員' : '本人沒有公開找組員，加入前請先聯絡'}。
              加入後全組會收到通知；成員改變，之後的簽核要重簽。
            </p>
            {student.inProposal ? (
              <p className="rounded-lg bg-danger-subtle px-3 py-2 text-sm text-danger-on-subtle">
                這位同學正在某份提案裡等確認：要加入請先在「進行中的提案」作廢那份提案（理由另填），或等它結束。
              </p>
            ) : null}
            <input type="hidden" name="studentNo" value={student.studentNo} />
            <input type="hidden" name="requestId" value={requestId} />
            <input type="hidden" name="groupId" value={target?.id ?? ''} />
            <input type="hidden" name="revision" value={target?.revision ?? ''} />
            {groups.length > 0 ? (
              <div>
                <label htmlFor="add-member-group" className={LABEL}>
                  組別
                </label>
                <select
                  id="add-member-group"
                  value={target?.id}
                  onChange={(e) => setGroupId(e.target.value)}
                  className={INPUT}
                >
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
            {target ? <SizeReminder text={sizeHint(target.memberCount + 1, size)} /> : null}
            <ReasonField id="add-member-reason" maxLength={reasonMaxLength} placeholder="例：轉學生，系上安排加入" />
            <Feedback state={state?.ok ? undefined : state} />
            <Actions pending={pending} disabled={groups.length === 0} cancel="先不要" submit="確認加入" onCancel={dialog.close} />
          </form>
        ) : null}
      </dialog>
    </div>
  )
}

export type GroupDetailMember = { userId: string; name: string; studentNo: string | null; isLeader: boolean }
export type GroupDetailHistory = { key: string; atLabel: string; text: string; reason: string | null }
type DetailGroup = { id: string; code: string; revision: number; members: GroupDetailMember[] }

/**
 * 組別詳情：成員與組長、移出、換組長、成立後的異動歷程。
 * 移出與換組長各自一個小對話框；成功後頁面重新整理，詳情維持打開、看得到新名單與新歷程。
 */
export function GroupDetailButton({
  group,
  size,
  requestIds,
  reasonMaxLength,
}: {
  group: DetailGroup & { typeLabel: string; history: GroupDetailHistory[] }
  size: Size
  requestIds: { remove: string; leader: string }
  reasonMaxLength: number
}) {
  const dialog = useDialog()
  const removeDialog = useDialog()
  const [message, setMessage] = useState<AdminGroupActionState>(undefined)
  const [removing, setRemoving] = useState<GroupDetailMember | null>(null)
  const leader = group.members.find((m) => m.isLeader) ?? null
  const single = group.members.length <= 1

  return (
    <div>
      {/* 原型：點組別代碼打開詳情（成員、老師、異動與例外處理）。 */}
      <button
        type="button"
        className="tabular rounded-md text-sm font-bold text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-brand"
        aria-label={`${group.code} 詳情`}
        onClick={dialog.open}
      >
        {group.code}
      </button>
      <dialog ref={dialog.ref} aria-label={`${group.code} 詳情`} className={SHEET}>
        <div className="space-y-4 p-5">
          <div>
            <p className="text-xs font-semibold text-primary">{group.typeLabel}</p>
            <h2 className="text-lg font-extrabold text-foreground tabular-nums">
              {group.code}・{group.members.length} 人
            </h2>
          </div>
          <SizeReminder text={sizeHint(group.members.length, size)} />
          <Feedback state={message} />

          <section aria-label="成員" className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-foreground">成員</h3>
              {single ? null : (
                <ChangeLeaderDialog
                  group={group}
                  leader={leader}
                  requestId={requestIds.leader}
                  reasonMaxLength={reasonMaxLength}
                  onDone={setMessage}
                />
              )}
            </div>
            <ul aria-label="成員名單" className="divide-y divide-border rounded-lg border border-border">
              {group.members.map((m) => (
                <li key={m.userId} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                  <span className="text-foreground">
                    {m.name}
                    <span className="ml-1 text-xs text-muted-foreground tabular-nums">{m.studentNo}</span>
                    {m.isLeader ? (
                      <Pill tone="brand" className="ml-2">
                        組長
                      </Pill>
                    ) : null}
                  </span>
                  {single ? null : (
                    <button
                      type="button"
                      className={BTN_ROW}
                      aria-label={`移出：${m.name}`}
                      onClick={() => {
                        setRemoving(m)
                        removeDialog.open()
                      }}
                    >
                      移出
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {single ? (
              <p className="text-xs text-muted-foreground">只剩一人：移出最後一人要走「解散」，解散功能之後才會開放。</p>
            ) : null}
            {/* 只有一個移出對話框：移出成功後那一列會消失，對話框與回饋不能跟著那一列一起不見。 */}
            <RemoveMemberDialog
              handle={removeDialog}
              group={group}
              member={removing}
              size={size}
              requestId={requestIds.remove}
              reasonMaxLength={reasonMaxLength}
              onDone={setMessage}
            />
          </section>

          <section aria-label="異動歷程" className="space-y-2">
            <h3 className="text-sm font-semibold text-foreground">異動歷程</h3>
            {group.history.length > 0 ? (
              <ol className="space-y-2 text-sm">
                {group.history.map((h) => (
                  <li key={h.key} className="rounded-lg border border-border px-3 py-2">
                    <p className="text-foreground">
                      <span className="mr-2 text-xs text-muted-foreground tabular-nums">{h.atLabel}</span>
                      {h.text}
                    </p>
                    {h.reason ? <p className="mt-0.5 text-xs text-muted-foreground">理由：{h.reason}</p> : null}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-sm text-muted-foreground">成立後沒有調整過成員或組長。</p>
            )}
          </section>

          <div className="flex justify-end pt-1">
            <button type="button" className={SECONDARY} onClick={dialog.close}>
              關閉
            </button>
          </div>
        </div>
      </dialog>
    </div>
  )
}

/** 成功就關掉小對話框、把回饋交給詳情顯示。 */
function useDoneOnSuccess(state: AdminGroupActionState, close: () => void, onDone: (state: AdminGroupActionState) => void) {
  useEffect(() => {
    if (state?.ok) {
      close()
      onDone(state)
    }
  }, [state, close, onDone])
}

function RemoveMemberDialog({
  handle,
  group,
  member,
  size,
  requestId,
  reasonMaxLength,
  onDone,
}: {
  handle: ReturnType<typeof useDialog>
  group: DetailGroup
  member: GroupDetailMember | null
  size: Size
  requestId: string
  reasonMaxLength: number
  onDone: (state: AdminGroupActionState) => void
}) {
  const [state, formAction, pending] = useActionState(removeMemberAction, undefined)
  useDoneOnSuccess(state, handle.close, onDone)
  const others = member ? group.members.filter((m) => m.userId !== member.userId) : []
  const fieldId = `remove-${group.id}`

  return (
    <dialog ref={handle.ref} aria-label={member ? `把 ${member.name} 移出 ${group.code}？` : '移出組員'} className={DIALOG}>
      {member ? (
        <form key={`${member.userId}-${group.revision}`} action={formAction} className="space-y-4 p-5">
          <h2 className="text-lg font-extrabold text-foreground">
            把 {member.name} 移出 {group.code}？
          </h2>
          <p className="text-sm text-muted-foreground">
            移出後他回到未分組、不能再看這組的資料；全組會收到通知，他只收到本人的異動說明（不含理由）。成員改變，之後的簽核要重簽。
          </p>
          <input type="hidden" name="groupId" value={group.id} />
          <input type="hidden" name="revision" value={group.revision} />
          <input type="hidden" name="userId" value={member.userId} />
          <input type="hidden" name="requestId" value={requestId} />
          {member.isLeader ? (
            <MemberSelect
              id={`${fieldId}-successor`}
              name="successorLeaderUserId"
              label={`接任組長（${member.name} 是組長，必填）`}
              placeholder="請選一位留在組裡的成員"
              options={others}
            />
          ) : null}
          <SizeReminder text={sizeHint(others.length, size)} />
          <ReasonField id={`${fieldId}-reason`} maxLength={reasonMaxLength} placeholder="例：休學" />
          <Feedback state={state?.ok ? undefined : state} />
          <Actions pending={pending} cancel="先不要" submit="確定移出" onCancel={handle.close} />
        </form>
      ) : null}
    </dialog>
  )
}

function ChangeLeaderDialog({
  group,
  leader,
  requestId,
  reasonMaxLength,
  onDone,
}: {
  group: DetailGroup
  leader: GroupDetailMember | null
  requestId: string
  reasonMaxLength: number
  onDone: (state: AdminGroupActionState) => void
}) {
  const [state, formAction, pending] = useActionState(changeLeaderAction, undefined)
  const dialog = useDialog()
  useDoneOnSuccess(state, dialog.close, onDone)
  const candidates = group.members.filter((m) => !m.isLeader)
  const fieldId = `leader-${group.id}`

  return (
    <div>
      <button type="button" className={BTN_ROW} onClick={dialog.open}>
        換組長
      </button>
      <dialog ref={dialog.ref} aria-label={`換 ${group.code} 的組長`} className={DIALOG}>
        <form key={group.revision} action={formAction} className="space-y-4 p-5">
          <h2 className="text-lg font-extrabold text-foreground">換 {group.code} 的組長</h2>
          <p className="text-sm text-muted-foreground">
            目前組長：{leader?.name ?? '（沒有）'}。成員沒變，不需要重簽；全組會收到通知，歷程會記下這次更換。
          </p>
          <input type="hidden" name="groupId" value={group.id} />
          <input type="hidden" name="revision" value={group.revision} />
          <input type="hidden" name="requestId" value={requestId} />
          <MemberSelect id={`${fieldId}-new`} name="newLeaderUserId" label="新組長" placeholder="請選一位成員" options={candidates} />
          <ReasonField id={`${fieldId}-reason`} maxLength={reasonMaxLength} placeholder="例：原組長請辭，全組同意" />
          <Feedback state={state?.ok ? undefined : state} />
          <Actions pending={pending} cancel="先不換" submit="確定更換" onCancel={dialog.close} />
        </form>
      </dialog>
    </div>
  )
}
