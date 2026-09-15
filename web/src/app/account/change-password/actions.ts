'use server'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { getSelfAccountCommand } from '@/composition/accounts'

/** 改密碼（契約 02 §7）。成功後回首頁——目的地自己的守衛會把人送到對的後台。 */
export async function changePasswordAction(
  _state: { error?: string } | undefined,
  formData: FormData,
) {
  const currentPassword = String(formData.get('currentPassword') ?? '')
  const newPassword = String(formData.get('newPassword') ?? '')
  const confirmPassword = String(formData.get('confirmPassword') ?? '')

  if (!currentPassword || !newPassword) return { error: '請填寫目前的密碼與新密碼。' }
  if (newPassword !== confirmPassword) return { error: '兩次輸入的新密碼不一樣。' }

  const result = await getSelfAccountCommand().changePassword(await headers(), {
    currentPassword,
    newPassword,
  })
  if (!result.ok) return { error: result.message }

  redirect('/')
}
