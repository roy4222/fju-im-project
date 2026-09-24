'use server'
import { refresh } from 'next/cache'
import { currentActor } from '@/app/_ui/guard'
import type { VisibilityActionState } from '@/app/dashboard/admin/affairs/[id]/visibility-panel'
import { getSubmissionCommand } from '@/composition/submissions'

/**
 * 收件名單頁的動作：主指導閱覽的開關（票 22；產品模組 05 SUB-24）。
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
      ? `已開放：從欄位第 ${result.receipt.effectiveFromVersionNo} 版起正式送出的回答，學生目前組別的主指導看得到；學生填寫頁會出現告知。`
      : '已關閉：老師馬上看不到這份收件的個人回答，附件也下載不到。',
  }
}
