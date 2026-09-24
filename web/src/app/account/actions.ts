'use server'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { getSelfAccountCommand, signOut } from '@/composition/accounts'
import type { AccountFormState } from './account-forms'

/**
 * 本人帳號頁的動作（契約 02 §7：寫用 Server Action）。
 *
 * 這裡只把表單欄位取成字串、把結果翻成畫面要的樣子。授權（已開通、fresh session）、
 * 驗證與寫入都在 `SelfAccountCommand`，直接呼叫這些 action 的人繞不過去。
 */


function field(formData: FormData, name: string, max = 300): string {
  const value = formData.get(name)
  return typeof value === 'string' && value.length <= max ? value : ''
}

function failed(
  state: AccountFormState,
  result: { message: string; code?: string; field?: string },
  values?: Record<string, string>,
): AccountFormState {
  return {
    error: result.message,
    ...(result.code ? { code: result.code } : {}),
    ...(result.field ? { field: result.field } : {}),
    ...(values ? { values } : {}),
    attempt: (state?.attempt ?? 0) + 1,
  }
}

/** 登出。 */
export async function signOutAction() {
  await signOut(await headers())
  redirect('/login')
}

/**
 * 重新確認身分：登出這一台，回登入頁重新登入後回到帳號頁（fresh session，契約 03 §2）。
 * 用密碼或 Google 重新登入都可以。
 */
export async function reconfirmAction() {
  await signOut(await headers())
  redirect(`/login?next=${encodeURIComponent('/account')}`)
}

/** 改手機與聯絡 Email。 */
export async function updateContactAction(state: AccountFormState, formData: FormData): Promise<AccountFormState> {
  const values = { phone: field(formData, 'phone', 30), contactEmail: field(formData, 'contactEmail', 300) }
  const raw = field(formData, 'expectedRevision', 10)
  const expectedRevision = /^\d+$/.test(raw) ? Number(raw) : NaN
  const result = await getSelfAccountCommand().updateContact(await headers(), { ...values, expectedRevision })
  if (!result.ok) return failed(state, result, values)
  redirect(`/account?saved=${result.revision}`)
}

/** 開始連結 Google：成功就導去 Google，回來落在 `/account?linked=google`（或 `?error=…`）。 */
export async function linkGoogleAction(state: AccountFormState): Promise<AccountFormState> {
  const result = await getSelfAccountCommand().startGoogleLink(await headers())
  if (!result.ok) return failed(state, result)
  redirect(result.url)
}

/** 替只有 Google 的帳號設一組密碼。 */
export async function setPasswordAction(state: AccountFormState, formData: FormData): Promise<AccountFormState> {
  const result = await getSelfAccountCommand().setPassword(await headers(), {
    newPassword: field(formData, 'newPassword', 200),
    passwordConfirm: field(formData, 'passwordConfirm', 200),
  })
  if (!result.ok) return failed(state, result)
  redirect('/account?password=set')
}
