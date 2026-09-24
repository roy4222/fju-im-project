'use server'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { getSelfAccountCommand, homeForUser, resolveActor } from '@/composition/accounts'

/**
 * 改密碼（契約 02 §7）。
 *
 * 成功後回這個人自己的首頁（票 8：老師第一次登入改完臨時密碼，要接著去補資料頁）。
 * 「是誰」要在改密**之前**先讀：改密會把這個人全部的 session 換新（`revokeOtherSessions`），
 * 改完之後這個請求帶的舊 cookie 已經對不到任何 session 了。
 */
export async function changePasswordAction(
  _state: { error?: string } | undefined,
  formData: FormData,
) {
  const currentPassword = String(formData.get('currentPassword') ?? '')
  const newPassword = String(formData.get('newPassword') ?? '')
  const confirmPassword = String(formData.get('confirmPassword') ?? '')

  if (!currentPassword || !newPassword) return { error: '請填寫目前的密碼與新密碼。' }
  if (newPassword !== confirmPassword) return { error: '兩次輸入的新密碼不一樣。' }

  const incoming = await headers()
  const actor = await resolveActor(incoming)
  const result = await getSelfAccountCommand().changePassword(incoming, {
    currentPassword,
    newPassword,
  })
  if (!result.ok) return { error: result.message }

  redirect(actor.kind === 'authenticated' ? await homeForUser(actor.userId) : '/')
}
