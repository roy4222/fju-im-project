'use server'
import { refresh } from 'next/cache'
import { currentActor } from '@/app/_ui/guard'
import type { GroupActionState, StudentLookupState } from '@/app/dashboard/student/groups/group-forms'
import {
  describeConfirmReceipt,
  describeLinkReceipt,
  describeTerminateReceipt,
  getGroupCommand,
  getGroupQuery,
  getOpportunityCommand,
  studentCohortOf,
} from '@/composition/groups'
import { sharedRateLimiter } from '@/shared/rate-limit'

/**
 * 「我的組」頁的動作（票 13；契約 02 §7；C3-11 規格③ §5.2、§7.3）：公開找隊員開關、建立組別（送出邀請）、確認、拒絕、
 * 撤回同意、撤回建立、即時查學號、組長選合作案。
 *
 * 這裡只做「表單 → 用例 → 畫面回饋」的翻譯；誰能做、人數對不對、建立中的組別還開不開著，全部在用例裡判
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
      ? '已公開找隊員：同屆同學、老師與系辦看得到你的名片（姓名、學號、自介、技能與聯絡 Email；電話不公開）。'
      : '已關閉公開找隊員，名單上不再出現你；自介與技能會留著，下次打開就回來。',
  }
}

export async function proposeAction(_state: GroupActionState, formData: FormData): Promise<GroupActionState> {
  const result = await getGroupCommand().propose(
    await currentActor(),
    {
      groupType: text(formData, 'groupType'),
      memberStudentNos: formData.getAll('studentNo').map(String),
      opportunityId: text(formData, 'opportunityId'),
    },
    text(formData, 'requestId'),
  )
  if (!result.ok) return { ok: false, message: result.message }
  refresh()
  return { ok: true, message: `已送出邀請，${result.receipt.memberCount} 位成員（含你）都要各自按確認。` }
}

const LOOKUP_MISS = '找不到這個學號，或他已經有組別'
const LOOKUP_RATE = { max: 30, windowMs: 60 * 1000 }

/**
 * 即時查學號（C3-11；規格③ §5.2）：只回同屆、還沒有組別的學生的姓名與頭像；誰能查、查什麼都在 `GroupQuery.lookupStudent`。
 * 不是表單動作，由表單欄位失焦時直接呼叫。
 */
export async function lookupStudentAction(studentNo: string): Promise<StudentLookupState> {
  const actor = await currentActor()
  const cohortId = studentCohortOf(actor)
  if (!cohortId || actor.kind !== 'authenticated') return { found: false, message: LOOKUP_MISS }
  // CL-3（#819）：每人每分鐘 30 次（組表單一次最多填幾格，正常用不到）；超過先擋，不進查詢，免得被拿來掃同屆名單。
  if (!sharedRateLimiter('student-lookup', LOOKUP_RATE).hit(actor.userId).allowed) return { found: false, message: '查得太頻繁，請稍後再試。' }
  const found = await getGroupQuery().lookupStudent(actor, cohortId, String(studentNo ?? ''))
  if (!found) return { found: false, message: LOOKUP_MISS }
  return {
    found: true,
    name: found.name,
    studentNo: found.studentNo,
    avatar: { id: found.userId, name: found.name, avatarPreset: found.avatarPreset, avatarFileId: found.avatarFileId },
  }
}

/** 組長在「我的組」選合作案（C3-11；規格③ §7.3）：走 C3-09 的 `request`（`pending`，帶組別版本），不是 `link`。 */
export async function requestOpportunityAction(_state: GroupActionState, formData: FormData): Promise<GroupActionState> {
  const revision = Number(text(formData, 'revision'))
  const result = await getOpportunityCommand().request(
    await currentActor(),
    { groupId: text(formData, 'groupId'), revision, opportunityId: text(formData, 'opportunityId') },
    text(formData, 'requestId'),
  )
  if (!result.ok) return { ok: false, message: result.message }
  refresh()
  return { ok: true, message: describeLinkReceipt(result.receipt) }
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
