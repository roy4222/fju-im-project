'use server'
import { refresh } from 'next/cache'
import { currentActor } from '@/app/_ui/guard'
import type { AdminGroupActionState } from '@/app/dashboard/admin/groups/admin-group-forms'
import { getGroupCommand } from '@/composition/groups'
import { describeUnassignedVoid } from '@/composition/unassigned'

/**
 * 「未分組學生」分頁的「終止建立」（C3-15）：呼叫既有 `voidProposal`（理由可空，C3-05）；規則全在用例裡判。
 * 回饋句寫發起人名字：名字是畫面帶來的，只用在回給這位系辦的句子，不寫進任何紀錄。
 * 「加入組別」直接用分組頁既有的 `addMemberAction`。
 */
const text = (formData: FormData, name: string) => String(formData.get(name) ?? '')

export async function voidUnassignedProposalAction(
  _state: AdminGroupActionState,
  formData: FormData,
): Promise<AdminGroupActionState> {
  const result = await getGroupCommand().voidProposal(
    await currentActor(),
    text(formData, 'proposalId'),
    text(formData, 'reason'),
    text(formData, 'requestId'),
  )
  if (!result.ok) return { ok: false, message: result.message }
  refresh()
  return { ok: true, message: describeUnassignedVoid(text(formData, 'proposerName').trim() || '發起人') }
}
