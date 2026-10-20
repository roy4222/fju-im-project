'use server'
import { refresh } from 'next/cache'
import { currentActor } from '@/app/_ui/guard'
import type { ClaimActionState, DeclineActionState } from '@/app/dashboard/teacher/groups/claim-button'
import { describeAdvisorChangeReceipt, describeLinkReceipt, getAdvisorCommand, getOpportunityCommand } from '@/composition/groups'

/**
 * 老師「分組總覽」產學組分頁的動作（票 19；C3-09 規格③ §7.2）：負責老師對「待確認要帶的組」按「確認指導」或「婉拒」。
 * 規則（只有產學組、只有這組選的合作案的負責老師、已經有主指導就衝突、婉拒理由選填）全在用例裡判；這裡只翻譯表單與回饋。
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

export async function declineGroupAction(_state: DeclineActionState, formData: FormData): Promise<DeclineActionState> {
  const result = await getOpportunityCommand().decline(
    await currentActor(),
    { groupId: String(formData.get('groupId') ?? ''), reason: String(formData.get('reason') ?? '') },
    String(formData.get('requestId') ?? ''),
  )
  refresh()
  if (!result.ok) return { ok: false, message: result.message }
  return { ok: true, message: describeLinkReceipt(result.receipt) }
}
