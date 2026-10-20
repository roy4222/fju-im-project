'use server'
import { refresh } from 'next/cache'
import { currentActor } from '@/app/_ui/guard'
import type { IndustryActionState } from '@/app/dashboard/_industry/opportunity-forms'
import { describeLinkReceipt, getOpportunityCommand } from '@/composition/groups'

/**
 * 案主老師「連結組別」（TE-B3）：把一組連到自己負責的已發布合作案。
 * 只做首次連結（換案仍只有組長與系辦）；誰能連、組別能不能連全在用例裡判，直接打這支 Server Action 一樣被擋。
 * C3-09：用例寫入的連結是 `state='active'`（學生選案等確認的 `pending` 走 `request`）；那一組若還沒有指導老師，
 * 會出現在產學組分頁「待確認要帶的組」等「確認指導」。
 */
export async function linkGroupAction(_state: IndustryActionState, formData: FormData): Promise<IndustryActionState> {
  const text = (name: string) => String(formData.get(name) ?? '')
  const rawRevision = text('revision').trim()
  const result = await getOpportunityCommand().link(
    await currentActor(),
    {
      groupId: text('groupId'),
      revision: rawRevision === '' ? Number.NaN : Number(rawRevision),
      opportunityId: text('opportunityId'),
      reason: '',
    },
    text('requestId'),
  )
  if (!result.ok) return { ok: false, message: result.message }
  refresh()
  return { ok: true, message: describeLinkReceipt(result.receipt) }
}
