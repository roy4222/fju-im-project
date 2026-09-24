'use server'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { clientIpFrom, getRegistrationCommand, resolveActor } from '@/composition/accounts'
import type { ApplicationFormState, ApplicationFormValues } from './application-form'

/**
 * 學生註冊與「修改資料」（契約 02 §7：寫用 Server Action）。
 *
 * 這裡只做兩件事：把表單欄位取成字串（超長的直接當空值，不把巨大字串往下傳），
 * 以及把結果翻成畫面要的樣子。**驗證、授權、限速都在用例與 Better Auth 的 hook**，
 * 直接呼叫這些 action 的人繞不過去。
 */

/** 表單欄位一律當字串讀；不是字串或長得離譜就當沒填（用例會回「請填…」）。 */
function field(formData: FormData, name: string, max = 300): string {
  const value = formData.get(name)
  return typeof value === 'string' && value.length <= max ? value : ''
}

function valuesOf(formData: FormData): ApplicationFormValues {
  return {
    appliedName: field(formData, 'appliedName'),
    studentNo: field(formData, 'studentNo'),
    departmentClass: field(formData, 'departmentClass'),
    phone: field(formData, 'phone'),
    loginEmail: field(formData, 'loginEmail'),
    contactEmail: field(formData, 'contactEmail'),
  }
}

function failed(
  state: ApplicationFormState,
  message: string,
  values: ApplicationFormValues,
  details?: Record<string, unknown>,
): ApplicationFormState {
  const fieldName = typeof details?.field === 'string' ? details.field : undefined
  return { error: message, field: fieldName, values, attempt: (state?.attempt ?? 0) + 1 }
}

/** 註冊：成功就已經登入（受限 session），直接到等待審核頁。 */
export async function registerAction(state: ApplicationFormState, formData: FormData): Promise<ApplicationFormState> {
  const values = valuesOf(formData)
  const incoming = await headers()
  // 來源 IP 的取法與登入、Better Auth hook 同一個函式（Caddy 覆寫 X-Real-IP，偽造不了）。
  const ip = clientIpFrom(incoming)
  const actor = await resolveActor(incoming)

  const result = await getRegistrationCommand().apply(
    actor,
    {
      appliedName: values.appliedName,
      studentNo: values.studentNo,
      departmentClass: values.departmentClass,
      phone: values.phone,
      loginEmail: values.loginEmail ?? '',
      password: field(formData, 'password', 200),
      passwordConfirm: field(formData, 'passwordConfirm', 200),
    },
    ip,
  )
  if (!result.ok) return failed(state, result.message, values, 'details' in result ? result.details : undefined)
  redirect('/register/pending')
}

/**
 * 待審期間修改申請（或第一次補送、被退回後重送）。
 *
 * 成功後導回等待審核頁並帶 `?updated=版本`，頁面顯示「已更新，狀態仍是待審核」。
 */
export async function reviseApplicationAction(
  state: ApplicationFormState,
  formData: FormData,
): Promise<ApplicationFormState> {
  const values = valuesOf(formData)
  const rawRevision = field(formData, 'expectedRevision', 10)
  const expectedRevision = rawRevision === '' ? null : /^\d+$/.test(rawRevision) ? Number(rawRevision) : NaN

  const actor = await resolveActor(await headers())
  const result = await getRegistrationCommand().reviseMine(
    actor,
    {
      appliedName: values.appliedName,
      studentNo: values.studentNo,
      departmentClass: values.departmentClass,
      phone: values.phone,
      contactEmail: values.contactEmail ?? '',
    },
    expectedRevision,
  )
  if (!result.ok) return failed(state, result.message, values, 'details' in result ? result.details : undefined)
  redirect(`/register/pending?updated=${result.receipt.revision}`)
}
