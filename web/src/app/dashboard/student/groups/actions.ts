'use server'
import { refresh } from 'next/cache'
import { currentActor } from '@/app/_ui/guard'
import type { GroupActionState } from '@/app/dashboard/student/groups/group-forms'
import { describeConfirmReceipt, describeTerminateReceipt, getGroupCommand } from '@/composition/groups'

/**
 * 「我的組別」頁的動作（票 13；契約 02 §7）：公開找組員開關、發起提案、確認、拒絕、撤回同意、撤回提案。
 *
 * 這裡只做「表單 → 用例 → 畫面回饋」的翻譯；誰能做、人數對不對、提案還開不開著，全部在用例裡判
 * （直接打這個 Server Action 的人一樣會被擋）。請求編號由頁面在伺服器端產生、放在隱藏欄位。
 */

const text = (formData: FormData, name: string) => String(formData.get(name) ?? '')

export async function setOpenToJoinAction(_state: GroupActionState, formData: FormData): Promise<GroupActionState> {
  const open = text(formData, 'open') === 'true'
  const result = await getGroupCommand().setOpenToJoin(await currentActor(), open, text(formData, 'requestId'))
  if (!result.ok) return { ok: false, message: result.message }
  refresh()
  return {
    ok: true,
    message: result.receipt.openToJoin
      ? '已公開找組員：同屆同學、老師與系辦看得到你的姓名、學號與聯絡 Email（電話不公開）。'
      : '已關閉公開找組員，名單上不再出現你。',
  }
}

export async function proposeAction(_state: GroupActionState, formData: FormData): Promise<GroupActionState> {
  const result = await getGroupCommand().propose(
    await currentActor(),
    { groupType: text(formData, 'groupType'), memberStudentNos: formData.getAll('studentNo').map(String) },
    text(formData, 'requestId'),
  )
  if (!result.ok) return { ok: false, message: result.message }
  refresh()
  return { ok: true, message: `已發起提案，${result.receipt.memberCount} 位成員（含你）都要各自按確認。` }
}

export async function confirmAction(_state: GroupActionState, formData: FormData): Promise<GroupActionState> {
  const result = await getGroupCommand().confirm(await currentActor(), text(formData, 'proposalId'), text(formData, 'requestId'))
  if (!result.ok) return { ok: false, message: result.message }
  refresh()
  return { ok: true, message: describeConfirmReceipt(result.receipt) }
}

const TERMINATE = {
  decline: 'decline',
  withdrawConfirmation: 'withdrawConfirmation',
  withdrawProposal: 'withdrawProposal',
} as const

export async function terminateAction(_state: GroupActionState, formData: FormData): Promise<GroupActionState> {
  const kind = text(formData, 'kind')
  if (!Object.hasOwn(TERMINATE, kind)) return { ok: false, message: '不認得這個動作，請重新整理頁面。' }
  const command = getGroupCommand()
  const actor = await currentActor()
  const proposalId = text(formData, 'proposalId')
  const requestId = text(formData, 'requestId')
  const result =
    kind === 'decline'
      ? await command.decline(actor, proposalId, requestId)
      : kind === 'withdrawConfirmation'
        ? await command.withdrawConfirmation(actor, proposalId, requestId)
        : await command.withdrawProposal(actor, proposalId, requestId)
  if (!result.ok) return { ok: false, message: result.message }
  refresh()
  return { ok: true, message: describeTerminateReceipt(result.receipt) }
}
