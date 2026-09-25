'use client'
import { startTransition, useActionState, useState, type FormEvent } from 'react'
import { changeGroupTypeAdminAction } from './actions'
import { DIALOG, Feedback, INPUT, LABEL, PRIMARY, SECONDARY, useCloseOnSuccess, useDialog } from './admin-group-forms'
import { Pill } from '@/app/_ui/dashboard/primitives'
import { BTN_ROW_GHOST as ROW_GHOST } from '@/app/_ui/dashboard/look'

/**
 * 分組總覽每一組的「類型」格（票 20；產品 5.3「任一條件不成立，只能由管理員修改」、GRP-14）。
 *
 * 對話框先列出這組目前的指導老師與合作案連結：系辦改類型**保留**這些關聯（不靜默刪除），
 * 要調整請另外用「指派／解除指導老師」或合作案頁的「解除」。理由必填、帶組別版本。
 */
export function GroupTypeCell({
  group,
  typeLabels,
  requestId,
  reasonMaxLength,
}: {
  group: {
    id: string
    code: string
    revision: number
    groupType: 'general' | 'industry'
    advisorName: string | null
    opportunityName: string | null
  }
  typeLabels: Record<'general' | 'industry', string>
  requestId: string
  reasonMaxLength: number
}) {
  const [state, action, pending] = useActionState(changeGroupTypeAdminAction, undefined)
  const dialog = useDialog()
  const [reason, setReason] = useState('')
  useCloseOnSuccess(state, dialog.close)
  const to = group.groupType === 'general' ? 'industry' : 'general'
  const kept = [
    group.advisorName ? `指導老師：${group.advisorName}` : null,
    group.opportunityName ? `合作案：${group.opportunityName}` : null,
  ].filter((x): x is string => x !== null)

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const formData = new FormData(event.currentTarget)
    startTransition(() => action(formData))
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {group.groupType === 'industry' ? (
          <Pill tone="brand">{typeLabels[group.groupType]}</Pill>
        ) : (
          <Pill className="bg-transparent">{typeLabels[group.groupType]}</Pill>
        )}
        <button type="button" className={ROW_GHOST} aria-label={`改組別類型：${group.code}`} onClick={dialog.open}>
          改類型
        </button>
      </div>
      <Feedback state={state?.ok ? state : undefined} />
      <dialog ref={dialog.ref} aria-label={`改 ${group.code} 的組別類型`} className={DIALOG}>
        <form key={group.revision} onSubmit={submit} className="space-y-4 p-5">
          <div>
            <h2 className="text-lg font-extrabold text-foreground">
              {group.code}：{typeLabels[group.groupType]} → {typeLabels[to]}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              組長在成組期內、沒有指導老師與合作案時可以自己改；其他情況由系辦在這裡處理。全組看得到這筆紀錄。
            </p>
          </div>
          <section aria-label="改類型的影響" className="rounded-lg border border-border px-3 py-2 text-sm">
            <h3 className="font-semibold text-foreground">既有關聯（會保留，不會自動刪除）</h3>
            {kept.length > 0 ? (
              <ul className="mt-1 list-disc pl-5 text-foreground">
                {kept.map((k) => (
                  <li key={k}>{k}</li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-muted-foreground">這組目前沒有指導老師，也沒有連結合作案。</p>
            )}
            {kept.length > 0 ? (
              <p className="mt-1 text-xs text-muted-foreground">要換指導老師請用「重派／解除」；要解除合作案請到「合作案」頁。</p>
            ) : null}
          </section>
          <input type="hidden" name="groupId" value={group.id} />
          <input type="hidden" name="revision" value={group.revision} />
          <input type="hidden" name="groupType" value={to} />
          <input type="hidden" name="requestId" value={requestId} />
          <div>
            <label htmlFor={`type-reason-${group.id}`} className={LABEL}>
              理由（必填）
            </label>
            <textarea
              id={`type-reason-${group.id}`}
              name="reason"
              rows={3}
              maxLength={reasonMaxLength}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="例：組長申請、成組期已過"
              className={INPUT}
            />
          </div>
          <Feedback state={state?.ok ? undefined : state} />
          <div className="flex justify-end gap-2 border-t border-border pt-4">
            <button type="button" className={SECONDARY} onClick={dialog.close}>
              先不要
            </button>
            <button type="submit" disabled={pending} className={PRIMARY}>
              {pending ? '處理中…' : `確認改成${typeLabels[to]}`}
            </button>
          </div>
        </form>
      </dialog>
    </div>
  )
}
