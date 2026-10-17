'use server'
import { refresh } from 'next/cache'
import { currentActor } from '@/app/_ui/guard'
import type { ExemptActionState } from '@/app/dashboard/admin/affairs/[id]/exempt-dialog'
import type { ReopenActionState } from '@/app/dashboard/admin/affairs/[id]/reopen-panel'
import type { VisibilityActionState } from '@/app/dashboard/admin/affairs/[id]/visibility-panel'
import { getSubmissionCommand } from '@/composition/submissions'
import { formatTaipeiMinute } from '@/shared/time'

/**
 * 收件名單頁的動作：主指導閱覽的開關（票 22；產品模組 05 SUB-24）、讓單一學生或單一組補交（第三波 W10）、
 * 設免繳／恢復（B 階段 A-08）。
 *
 * 規則全在用例：只有系辦管理員、只對個人一份、已經有人作答就不能開、只插不改。
 * 這裡只翻譯結果；成功與失敗都刷新頁面，面板換成伺服器上的最新狀態，結果句子留在對話框裡。
 */

export async function setAdvisorVisibilityAction(_state: VisibilityActionState, formData: FormData): Promise<VisibilityActionState> {
  const result = await getSubmissionCommand().setAdvisorVisibility(
    await currentActor(),
    String(formData.get('itemId') ?? '').slice(0, 100),
    formData.get('enabled') === 'true',
    String(formData.get('requestId') ?? '').slice(0, 100),
  )
  refresh()
  if (!result.ok) return { ok: false, message: result.message }
  return {
    ok: true,
    message: result.receipt.enabled
      ? `已開放：從表單第 ${result.receipt.effectiveFromVersionNo} 版起正式送出的回答，學生目前組別的指導老師看得到；學生填寫頁會出現告知。`
      : '已關閉：老師馬上看不到這份作業的個人回答，附件也下載不到。',
  }
}

/** 讓單一學生或單一組補交（W10）：規則在用例（已截止、名單上不是免填、期限晚於現在、理由 1–200 字）。 */
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

/** 設免繳／恢復（A-08）：規則在用例（系辦、目前名單上、理由 1–200 字、屆別沒封存、狀態不同）。成功與失敗都刷新，名單換成最新。 */
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
