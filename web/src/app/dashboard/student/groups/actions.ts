'use server'
import { refresh } from 'next/cache'
import { currentActor } from '@/app/_ui/guard'
import type { GroupActionState } from '@/app/dashboard/student/groups/group-forms'
import {
  describeConfirmReceipt,
  describeGroupTypeReceipt,
  describeLinkReceipt,
  describeTerminateReceipt,
  getGroupCommand,
  getOpportunityCommand,
} from '@/composition/groups'

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

// ── 組長：連結合作案、改組別類型（票 20） ─────────────────────────────────────────

const whole = (formData: FormData, name: string) => {
  const raw = text(formData, name).trim()
  return raw === '' ? Number.NaN : Number(raw)
}

/** 組長把組別連結到合作案；已經連著別的就是換案（理由必填）。組長、類型、合作案狀態全部在用例裡判。 */
export async function linkOpportunityAction(_state: GroupActionState, formData: FormData): Promise<GroupActionState> {
  const result = await getOpportunityCommand().link(
    await currentActor(),
    {
      groupId: text(formData, 'groupId'),
      revision: whole(formData, 'revision'),
      opportunityId: text(formData, 'opportunityId'),
      reason: text(formData, 'reason'),
    },
    text(formData, 'requestId'),
  )
  if (!result.ok) return { ok: false, message: result.message }
  refresh()
  return { ok: true, message: describeLinkReceipt(result.receipt) }
}

/** 組長改組別類型：成組期內、沒有主指導、沒有合作案三個條件都成立才可以（用例判；不符合時回原因）。 */
export async function changeGroupTypeAction(_state: GroupActionState, formData: FormData): Promise<GroupActionState> {
  const result = await getOpportunityCommand().changeGroupType(
    await currentActor(),
    {
      groupId: text(formData, 'groupId'),
      revision: whole(formData, 'revision'),
      groupType: text(formData, 'groupType'),
      reason: text(formData, 'reason'),
    },
    text(formData, 'requestId'),
  )
  if (!result.ok) return { ok: false, message: result.message }
  refresh()
  return { ok: true, message: describeGroupTypeReceipt(result.receipt) }
}
