'use server'
import { refresh } from 'next/cache'
import { currentActor } from '@/app/_ui/guard'
import type { ClaimActionState } from '@/app/dashboard/teacher/groups/claim-button'
import { describeAdvisorChangeReceipt, getAdvisorCommand } from '@/composition/groups'

/**
 * 老師「分組」頁的動作：認領尚未指派的產學組（票 19）。
 * 規則（只有產學組、先按先得、已經有主指導就衝突）全在用例裡判；這裡只翻譯表單與回饋。
 */
export async function claimGroupAction(_state: ClaimActionState, formData: FormData): Promise<ClaimActionState> {
  const result = await getAdvisorCommand().claim(
    await currentActor(),
    { groupId: String(formData.get('groupId') ?? '') },
    String(formData.get('requestId') ?? ''),
  )
  refresh()
  if (!result.ok) return { ok: false, conflict: result.code === 'ALREADY_CLAIMED', message: result.message }
  return { ok: true, conflict: false, message: describeAdvisorChangeReceipt(result.receipt) }
}
