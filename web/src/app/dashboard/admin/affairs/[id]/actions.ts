'use server'
import { refresh } from 'next/cache'
import { currentActor } from '@/app/_ui/guard'
import type { ExemptActionState } from '@/app/dashboard/admin/affairs/[id]/exempt-dialog'
import type { RemindActionState } from '@/app/dashboard/admin/affairs/[id]/remind-button'
import type { ReopenActionState } from '@/app/dashboard/admin/affairs/[id]/reopen-panel'
import { describeItemReminder, getReminderCommand } from '@/composition/reminders'
import { getSubmissionCommand } from '@/composition/submissions'
import { formatTaipeiMinute } from '@/shared/time'

/**
 * 收件名單頁的動作：讓單一學生或單一組補交（第三波 W10）、
 * 設免繳／恢復（B 階段 A-08）、催繳（C 階段規格① §8，C1-07）。
 *
 * （指導老師閱覽的開關在 C 收尾 CL-13 移進表單進階設定，跟表單一起存，這裡不再有。）
 * 規則全在用例；這裡只翻譯結果。
 */

/** 讓單一學生或單一組補交（W10）：規則在用例（已截止、名單上不是免填、期限晚於現在、理由選填且 200 字內）。 */
export async function reopenAction(_state: ReopenActionState, formData: FormData): Promise<ReopenActionState> {
  const result = await getSubmissionCommand().reopen(
    await currentActor(),
    String(formData.get('itemId') ?? '').slice(0, 100),
    String(formData.get('receiverId') ?? '').slice(0, 100),
    { dueAt: String(formData.get('dueAt') ?? '').slice(0, 40), reason: String(formData.get('reason') ?? '').slice(0, 1000) },
    String(formData.get('requestId') ?? '').slice(0, 100),
  )
  if (!result.ok) return { ok: false, message: result.message }
  refresh()
  const who = result.receipt.receiverKind === 'group' ? `這一組的 ${result.receipt.notified} 位組員` : '這位學生'
  return {
    ok: true,
    message: `已開放補交到 ${formatTaipeiMinute(new Date(result.receipt.dueAt))}（臺灣時間），已通知${who}；其他人仍是已截止。`,
  }
}

/** 設免繳／恢復（A-08）：規則在用例（系辦、目前名單上、理由選填且 200 字內、屆別沒封存、狀態不同）。成功與失敗都刷新，名單換成最新。 */
export async function setExemptAction(_state: ExemptActionState, formData: FormData): Promise<ExemptActionState> {
  const exempt = formData.get('exempt') === 'true'
  const result = await getSubmissionCommand().setExempt(
    await currentActor(),
    {
      itemId: String(formData.get('itemId') ?? '').slice(0, 100),
      receiverId: String(formData.get('receiverId') ?? '').slice(0, 100),
      exempt,
      reason: exempt ? String(formData.get('reason') ?? '').slice(0, 1000) : undefined,
    },
    String(formData.get('requestId') ?? '').slice(0, 100),
  )
  refresh()
  if (!result.ok) return { ok: false, message: result.message }
  return { ok: true, message: result.receipt.exempt ? '已設為免繳。' : '已恢復需繳交。' }
}

/**
 * 催繳一份作業（C 階段規格① §8、AC-12）：名單上還沒完成的人各收一則站內通知＋一封信（整組展開組員）；24 小時一次，規則在用例。
 * 成功與失敗都刷新：按鈕換成冷卻中（「上次催繳剛剛，… 後可再催」），結果句子由按鈕顯示。
 */
export async function remindItemAction(itemId: string, requestId: string): Promise<RemindActionState> {
  const result = await getReminderCommand().remindItem(
    await currentActor(),
    { itemId: String(itemId ?? '').slice(0, 100) },
    String(requestId ?? '').slice(0, 100),
  )
  refresh()
  if (!result.ok) return { ok: false, message: result.message }
  return { ok: true, message: describeItemReminder(result.receipt) }
}
