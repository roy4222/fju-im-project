'use server'
import { refresh } from 'next/cache'
import { currentActor } from '@/app/_ui/guard'
import type { ProfileCardActionState } from '@/app/_ui/profile-card/profile-card-dialog'
import { getProfileCardCommand } from '@/composition/accounts'

/**
 * 「編輯我的名片」的儲存（C3-07；C3 設計方案 §4.3）。
 *
 * 只做「表單 → 用例 → 畫面回饋」的翻譯；誰能改（只有學生本人）、字數與技能上限、已成組不能公開，全部在用例裡判，
 * 直接打這個 Server Action 一樣會被擋（老師、系辦回「只有學生本人可以編輯名片」）。
 */
export async function saveProfileCardAction(_state: ProfileCardActionState, formData: FormData): Promise<ProfileCardActionState> {
  const text = (name: string) => String(formData.get(name) ?? '')
  const result = await getProfileCardCommand().save(
    await currentActor(),
    {
      bio: text('bio'),
      skills: formData.getAll('skill').map(String),
      contactEmail: text('contactEmail'),
      openToJoin: text('openToJoin') === 'true',
      revision: Number(text('revision')),
    },
    text('requestId'),
  )
  if (!result.ok) return { ok: false, message: result.message }
  refresh()
  return { ok: true, message: '名片已更新' }
}
