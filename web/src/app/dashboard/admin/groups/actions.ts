'use server'
import { refresh } from 'next/cache'
import { redirect } from 'next/navigation'
import { currentActor } from '@/app/_ui/guard'
import type { AdminGroupActionState } from '@/app/dashboard/admin/groups/admin-group-forms'
import type { BatchActionOutcome } from '@/app/dashboard/admin/groups/advisor-forms'
import type { AdvisorBatchPreview, AdvisorBatchReceipt, AdvisorUploadTicket } from '@/application/groups'
import { describeGroupingSettingsReceipt, getCohortCommand } from '@/composition/cohorts'
import {
  describeAdvisorBatchReceipt,
  describeAdvisorChangeReceipt,
  describeDissolveReceipt,
  describeGroupTypeReceipt,
  describeLeaderChangeReceipt,
  describeMemberChangeReceipt,
  describeTerminateReceipt,
  getAdvisorCommand,
  getGroupCommand,
  getOpportunityCommand,
} from '@/composition/groups'
import type { Result } from '@/shared/result'

/**
 * 管理員「分組總覽」的動作：分組設定（每組人數、提案預設天數）、作廢提案（票 13）；
 * 加入組員、移出組員、換組長（票 14）；解散組別（開站後）；指派、重派、解除指導老師與批次指派 CSV（票 19）。
 * 規則全在用例裡判；這裡只翻譯表單與回饋。
 */

const text = (formData: FormData, name: string) => String(formData.get(name) ?? '')
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const whole = (formData: FormData, name: string) => {
  const raw = text(formData, name).trim()
  return raw === '' ? Number.NaN : Number(raw)
}

export async function saveGroupingSettingsAction(
  _state: AdminGroupActionState,
  formData: FormData,
): Promise<AdminGroupActionState> {
  const result = await getCohortCommand().setGroupingSettings(
    await currentActor(),
    text(formData, 'cohortId'),
    {
      groupSizeMin: whole(formData, 'groupSizeMin'),
      groupSizeMax: whole(formData, 'groupSizeMax'),
      proposalDefaultDays: whole(formData, 'proposalDefaultDays'),
    },
    Number(text(formData, 'revision')),
    text(formData, 'requestId'),
  )
  if (!result.ok) return { ok: false, message: result.message }
  refresh()
  return { ok: true, message: describeGroupingSettingsReceipt(result.receipt) }
}

export async function voidProposalAction(
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
  return { ok: true, message: describeTerminateReceipt(result.receipt) }
}

export async function addMemberAction(_state: AdminGroupActionState, formData: FormData): Promise<AdminGroupActionState> {
  const result = await getGroupCommand().addMember(
    await currentActor(),
    {
      groupId: text(formData, 'groupId'),
      revision: whole(formData, 'revision'),
      studentNo: text(formData, 'studentNo'),
      reason: text(formData, 'reason'),
    },
    text(formData, 'requestId'),
  )
  if (!result.ok) return { ok: false, message: result.message }
  refresh()
  return { ok: true, message: describeMemberChangeReceipt(result.receipt) }
}

export async function removeMemberAction(_state: AdminGroupActionState, formData: FormData): Promise<AdminGroupActionState> {
  const result = await getGroupCommand().removeMember(
    await currentActor(),
    {
      groupId: text(formData, 'groupId'),
      revision: whole(formData, 'revision'),
      userId: text(formData, 'userId'),
      reason: text(formData, 'reason'),
      successorLeaderUserId: text(formData, 'successorLeaderUserId') || null,
    },
    text(formData, 'requestId'),
  )
  if (!result.ok) return { ok: false, message: result.message }
  refresh()
  return { ok: true, message: describeMemberChangeReceipt(result.receipt) }
}

export async function changeLeaderAction(_state: AdminGroupActionState, formData: FormData): Promise<AdminGroupActionState> {
  const result = await getGroupCommand().changeLeader(
    await currentActor(),
    {
      groupId: text(formData, 'groupId'),
      revision: whole(formData, 'revision'),
      newLeaderUserId: text(formData, 'newLeaderUserId'),
      reason: text(formData, 'reason'),
    },
    text(formData, 'requestId'),
  )
  if (!result.ok) return { ok: false, message: result.message }
  refresh()
  return { ok: true, message: describeLeaderChangeReceipt(result.receipt) }
}

/** 開站後：系辦解散組別。理由必填；畫面先要二次確認才送出。 */
export async function dissolveGroupAction(_state: AdminGroupActionState, formData: FormData): Promise<AdminGroupActionState> {
  const result = await getGroupCommand().dissolveGroup(
    await currentActor(),
    { groupId: text(formData, 'groupId'), revision: whole(formData, 'revision'), reason: text(formData, 'reason') },
    text(formData, 'requestId'),
  )
  if (!result.ok) return { ok: false, message: result.message }
  // 解散後這組不在「全部組別」裡了（詳情跟著消失），回執改在「已解散的組別」那一塊顯示。
  const cohortId = text(formData, 'cohortId')
  if (UUID.test(cohortId)) redirect(`/dashboard/admin/groups?cohort=${cohortId}&dissolved=${result.receipt.groupId}`)
  refresh()
  return { ok: true, message: describeDissolveReceipt(result.receipt) }
}

// ── 指導老師（票 19）─────────────────────────────────────────────────────────

export async function assignAdvisorAction(_state: AdminGroupActionState, formData: FormData): Promise<AdminGroupActionState> {
  const result = await getAdvisorCommand().assign(
    await currentActor(),
    {
      groupId: text(formData, 'groupId'),
      revision: whole(formData, 'revision'),
      teacherUserId: text(formData, 'teacherUserId'),
      reason: text(formData, 'reason'),
      gradingSelections: formData.getAll('gradingSelections').map(String),
    },
    text(formData, 'requestId'),
  )
  if (!result.ok) return { ok: false, message: result.message }
  refresh()
  return { ok: true, message: describeAdvisorChangeReceipt(result.receipt) }
}

export async function unassignAdvisorAction(_state: AdminGroupActionState, formData: FormData): Promise<AdminGroupActionState> {
  const result = await getAdvisorCommand().unassign(
    await currentActor(),
    { groupId: text(formData, 'groupId'), revision: whole(formData, 'revision'), reason: text(formData, 'reason') },
    text(formData, 'requestId'),
  )
  if (!result.ok) return { ok: false, message: result.message }
  refresh()
  return { ok: true, message: describeAdvisorChangeReceipt(result.receipt) }
}

// 批次指派：檔案本身不走 Server Action（位元組由瀏覽器直接 POST 到 `/api/files/upload`，同名單匯入）；
// 這裡只發 ticket、要預覽、確認執行。授權與所有規則都在用例裡。

function field(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length <= max ? value : null
}

function outcome<T>(result: Result<T>): BatchActionOutcome<T> {
  return result.ok ? { ok: true, data: result.receipt } : { ok: false, message: result.message }
}

export async function startAdvisorUploadAction(input: {
  fileName: string
  declaredMime: string
  declaredSize: number
}): Promise<BatchActionOutcome<AdvisorUploadTicket>> {
  const fileName = field(input?.fileName, 500)
  const declaredMime = field(input?.declaredMime ?? '', 200)
  const declaredSize = typeof input?.declaredSize === 'number' ? input.declaredSize : Number.NaN
  if (fileName === null || declaredMime === null) return { ok: false, message: '檔案資訊不正確。' }
  return outcome(await getAdvisorCommand().startBatchUpload(await currentActor(), { fileName, declaredMime, declaredSize }))
}

export async function previewAdvisorBatchAction(input: {
  fileId: string
  cohortId: string
}): Promise<BatchActionOutcome<AdvisorBatchPreview>> {
  const fileId = field(input?.fileId, 100)
  const cohortId = field(input?.cohortId, 100)
  if (!fileId || !cohortId) return { ok: false, message: '請重新選擇檔案。' }
  return outcome(await getAdvisorCommand().previewBatch(await currentActor(), { fileId, cohortId }))
}

export async function executeAdvisorBatchAction(input: {
  fileId: string
  cohortId: string
  reason: string
  confirmReassign: boolean
  revisions: Record<string, number>
  requestId: string
}): Promise<BatchActionOutcome<{ receipt: AdvisorBatchReceipt; message: string }>> {
  const fileId = field(input?.fileId, 100)
  const cohortId = field(input?.cohortId, 100)
  const requestId = field(input?.requestId, 100)
  const reason = field(input?.reason ?? '', 1000)
  if (!fileId || !cohortId || !requestId || reason === null) return { ok: false, message: '請重新上傳檔案。' }
  const revisions: Record<string, number> = {}
  for (const [groupId, revision] of Object.entries(input?.revisions ?? {}).slice(0, 2000)) {
    if (typeof revision === 'number' && Number.isInteger(revision)) revisions[groupId] = revision
  }
  const result = await getAdvisorCommand().executeBatch(
    await currentActor(),
    { fileId, cohortId, reason, confirmReassign: input?.confirmReassign === true, revisions },
    requestId,
  )
  if (!result.ok) return { ok: false, message: result.message }
  refresh()
  return { ok: true, data: { receipt: result.receipt, message: describeAdvisorBatchReceipt(result.receipt) } }
}

// ── 改組別類型（票 20）：系辦處理組長自己改不了的情況，理由必填，既有主指導與合作案連結保留 ──

export async function changeGroupTypeAdminAction(
  _state: AdminGroupActionState,
  formData: FormData,
): Promise<AdminGroupActionState> {
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
