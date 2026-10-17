'use server'
import { refresh } from 'next/cache'
import { currentActor } from '@/app/_ui/guard'
import type { CohortActionState } from '@/app/dashboard/admin/cohorts/cohort-forms'
import { cohortLabel, describeActivateReceipt, describeFlagReceipt, getCohortCommand } from '@/composition/cohorts'

/**
 * 屆別頁的動作（票 5：新增、設旗標；票 11：轉進行中；AD-B4：封存與解封；契約 02 §7）。
 *
 * 這裡只做「表單 → 用例 → 畫面回饋」的翻譯；誰能做、代碼怎麼驗、旗標怎麼切換，
 * 全部在用例裡判（直接打這個 Server Action 的人一樣會被用例擋下）。
 * 請求編號由頁面在伺服器端產生、放在隱藏欄位：同一張表單按兩次只會做一次。
 */

export async function createCohortAction(
  _state: CohortActionState,
  formData: FormData,
): Promise<CohortActionState> {
  const values = { code: String(formData.get('code') ?? ''), name: String(formData.get('name') ?? '') }
  const result = await getCohortCommand().create(
    await currentActor(),
    values,
    String(formData.get('requestId') ?? ''),
  )
  // 失敗時把剛填的字帶回去（React 送出後會重設表單），不用整份重打。
  if (!result.ok) return { ok: false, message: result.message, values }

  refresh()
  return { ok: true, message: `已新增屆別 ${cohortLabel(result.receipt)}，目前是「尚未開始（設定中）」。` }
}

export async function setCohortFlagAction(
  _state: CohortActionState,
  formData: FormData,
): Promise<CohortActionState> {
  const flag = String(formData.get('flag') ?? '')
  const cohortId = String(formData.get('cohortId') ?? '')
  const requestId = String(formData.get('requestId') ?? '')
  const actor = await currentActor()
  const command = getCohortCommand()

  const result =
    flag === 'defaultWorking'
      ? await command.setDefaultWorking(actor, cohortId, requestId)
      : flag === 'registrationOpen'
        ? await command.setRegistrationOpen(actor, cohortId, requestId)
        : null
  if (!result) return { ok: false, message: '不認得這個設定，請重新整理頁面。' }
  if (!result.ok) return { ok: false, message: result.message }

  refresh()
  return { ok: true, message: describeFlagReceipt(result.receipt) }
}

export async function activateCohortAction(
  _state: CohortActionState,
  formData: FormData,
): Promise<CohortActionState> {
  const result = await getCohortCommand().activate(
    await currentActor(),
    String(formData.get('cohortId') ?? ''),
    String(formData.get('requestId') ?? ''),
  )
  if (!result.ok) return { ok: false, message: result.message }

  refresh()
  return { ok: true, message: describeActivateReceipt(result.receipt) }
}

/** 封存與解封共用一個動作（AD-B4）：隱藏欄位 `mode` 分方向，理由兩邊都必填（用例會再驗一次）。 */
export async function setCohortStatusAction(
  _state: CohortActionState,
  formData: FormData,
): Promise<CohortActionState> {
  const mode = String(formData.get('mode') ?? '')
  const input = { cohortId: String(formData.get('cohortId') ?? ''), reason: String(formData.get('reason') ?? '') }
  const requestId = String(formData.get('requestId') ?? '')
  const label = String(formData.get('label') ?? '')
  const actor = await currentActor()
  const command = getCohortCommand()

  const result =
    mode === 'archive'
      ? await command.archive(actor, input, requestId)
      : mode === 'unarchive'
        ? await command.unarchive(actor, input, requestId)
        : null
  if (!result) return { ok: false, message: '不認得這個動作，請重新整理頁面。' }
  if (!result.ok) return { ok: false, message: result.message }

  refresh()
  return {
    ok: true,
    message:
      result.receipt.status === 'archived'
        ? `已封存${label}：老師與學生只能查看，不能再改。`
        : `已解除封存${label}，狀態回到進行中。`,
  }
}
