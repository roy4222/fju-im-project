'use server'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { getTeacherSetupCommand, resolveActor } from '@/composition/accounts'

/** 老師補資料（票 8）。授權與欄位規則都在用例裡；這裡只收表單、翻訊息、成功後進老師首頁。 */
export async function completeTeacherSetupAction(
  _state: { error?: string } | undefined,
  formData: FormData,
) {
  const field = (name: string) => {
    const value = formData.get(name)
    return typeof value === 'string' && value.length <= 500 ? value : ''
  }

  const actor = await resolveActor(await headers())
  const result = await getTeacherSetupCommand().complete(actor, {
    displayName: field('displayName'),
    phone: field('phone'),
    contactEmail: field('contactEmail'),
  })
  if (!result.ok) {
    // 另一個分頁已經補過了：直接進首頁就好。
    if (result.code === 'CONFLICT') redirect('/dashboard/teacher')
    return { error: result.message }
  }
  redirect('/dashboard/teacher')
}
