'use server'
import { refresh } from 'next/cache'
import { currentActor } from '@/app/_ui/guard'
import type { CohortActionState } from '@/app/dashboard/admin/cohorts/cohort-forms'
import { describeFlagReceipt, getCohortCommand } from '@/composition/cohorts'

/**
 * 屆別頁的兩個動作（票 5；契約 02 §7）。
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
  return { ok: true, message: `已新增屆別 ${result.receipt.code}，目前是籌備中。` }
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
