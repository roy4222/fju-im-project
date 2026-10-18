'use server'
import { headers } from 'next/headers'
import { EMAIL_VERIFY_PATH, getRegistrationCommand, homeForUser, resolveActor } from '@/composition/accounts'
import type { ApplicationFormState } from '../application-form'
import { EMAIL_UNVERIFIED_MESSAGE, failed, valuesOf } from '../_components/form-data'

/**
 * 註冊第 3 步「填學生資料」送出（VB-3）：第一次送申請，成功後畫面送 GA `done` 再到等待審核頁；
 * Q42 自動開通的人改到「帳號已開通」（VB-6，`/register/apply/done`）。
 *
 * 用密碼註冊、還沒驗證 Email 的人一律擋下（AC-VI-50）：這裡先用 `homeForUser` 擋，用例層 `reviseMine`
 * 開頭的 `applyDenial` 再擋一次（VB-6）。
 */
export async function applyStepAction(state: ApplicationFormState, formData: FormData): Promise<ApplicationFormState> {
  const values = valuesOf(formData)
  const actor = await resolveActor(await headers())
  if (actor.kind === 'authenticated' && (await homeForUser(actor.userId)) === EMAIL_VERIFY_PATH) {
    return failed(state, EMAIL_UNVERIFIED_MESSAGE, values)
  }
  const result = await getRegistrationCommand().reviseMine(
    actor,
    {
      appliedName: values.appliedName,
      studentNo: values.studentNo,
      departmentClass: values.departmentClass,
      phone: values.phone,
      contactEmail: values.contactEmail ?? '',
    },
    // 還沒有申請：第一次送出（沒有版本可比）。
    null,
  )
  if (!result.ok) return failed(state, result.message, values, 'details' in result ? result.details : undefined)
  return { done: result.receipt.autoApproved ? '/register/apply/done' : '/register/pending' }
}
