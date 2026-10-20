'use client'
import { useActionState, useState } from 'react'
import { dissolveGroupAction } from './actions'
import { DIALOG, Feedback, INPUT, LABEL, PRIMARY, SECONDARY, useDialog } from './admin-group-forms'
import { IconUsersMinus } from '@tabler/icons-react'
import { BTN_ROW_GHOST } from '@/app/_ui/dashboard/look'
import { cn } from '@/shared/cn'

/**
 * 系辦從卡片「更多」或小組詳情刪除組別（C3-12）。
 *
 * 兩步：先填理由，再看一次後果、按「確定刪除」才送出（二次確認）。帶組別版本，別人先改過就被擋。
 * 成功後切到「已刪除」篩選顯示回執，原組只留下紀錄入口。
 */
export function DissolveGroupButton({
  group,
  cohortId,
  requestId,
  reasonMaxLength,
  disabled = false,
}: {
  group: { id: string; code: string; revision: number; memberNames: readonly string[] }
  cohortId: string
  requestId: string
  reasonMaxLength: number
  disabled?: boolean
}) {
  const [state, formAction, pending] = useActionState(dissolveGroupAction, undefined)
  const dialog = useDialog()
  const [reason, setReason] = useState('')
  const [confirming, setConfirming] = useState(false)
  const fieldId = `dissolve-${group.id}-reason`
  const names = group.memberNames.join('、')
  const close = () => {
    setConfirming(false)
    dialog.close()
  }

  return (
    <div>
      <button type="button" disabled={disabled} className={cn(BTN_ROW_GHOST, 'px-2 pointer-coarse:min-h-11 pointer-coarse:min-w-11')} title="刪除組別" aria-label={`刪除 ${group.code}`} onClick={dialog.open}>
        <IconUsersMinus className="size-3.5" aria-hidden />刪除
      </button>
      {disabled ? <p className="text-xs text-muted-foreground">這組已有繳交紀錄，不能刪除</p> : null}
      <dialog ref={dialog.ref} aria-label={`刪除 ${group.code}？`} className={DIALOG} onClose={() => setConfirming(false)}>
        <form key={group.revision} action={formAction} className="space-y-4 p-5">
          <h2 className="text-lg font-extrabold text-foreground">{confirming ? `確定刪除 ${group.code}？` : `刪除 ${group.code}`}</h2>
          <input type="hidden" name="groupId" value={group.id} />
          <input type="hidden" name="revision" value={group.revision} />
          <input type="hidden" name="cohortId" value={cohortId} />
          <input type="hidden" name="requestId" value={requestId} />
          {confirming ? (
            <>
              <input type="hidden" name="reason" value={reason} />
              <ul className="list-disc space-y-1 pl-5 text-sm text-foreground">
                <li>{names ? `${names} 回到未分組，之後可以另組新組。` : '這組已經沒有有效成員。'}</li>
                <li>進行中的評分指派結束、老師的暫存失效；已送出的分數保留、凍結。</li>
                <li>目前的簽核版本作廢。</li>
                <li>組員、主指導與評分老師各收到一則通知（不含理由）。</li>
              </ul>
              <p className="rounded-lg bg-danger-subtle px-3 py-2 text-sm text-danger-on-subtle">刪除後不能復原，原組資料只能查看與匯出。</p>
              {reason ? <p className="text-sm text-muted-foreground">理由：{reason}</p> : null}
              <Feedback state={state?.ok ? undefined : state} />
              <div className="flex justify-end gap-2 pt-1">
                <button type="button" className={SECONDARY} onClick={() => setConfirming(false)}>
                  返回修改
                </button>
                <button type="submit" disabled={pending} className={PRIMARY}>
                  {pending ? '處理中…' : '確定刪除'}
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                目前 {group.memberNames.length} 人{names ? `：${names}` : ''}。理由只留在系辦紀錄，通知不會帶出。
              </p>
              <div>
                <label htmlFor={fieldId} className={LABEL}>
                  理由（可不填）
                </label>
                <textarea
                  id={fieldId}
                  rows={3}
                  maxLength={reasonMaxLength}
                  placeholder="例：全組僅剩一人，無法繼續"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  className={INPUT}
                />
              </div>
              <div className="flex justify-end gap-2 pt-1">
                <button type="button" className={SECONDARY} onClick={close}>
                  先不要
                </button>
                <button type="button" className={PRIMARY} onClick={() => setConfirming(true)}>
                  下一步
                </button>
              </div>
            </>
          )}
        </form>
      </dialog>
    </div>
  )
}
