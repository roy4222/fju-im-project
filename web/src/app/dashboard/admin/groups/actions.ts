'use server'
import { refresh } from 'next/cache'
import { redirect } from 'next/navigation'
import { currentActor } from '@/app/_ui/guard'
import type { AdminGroupActionState } from '@/app/dashboard/admin/groups/admin-group-forms'
import type { BatchActionOutcome } from '@/app/dashboard/admin/groups/advisor-forms'
import type { GroupHistoryOutcome } from '@/app/dashboard/admin/groups/member-forms'
import type { LinkOptionsOutcome } from '@/app/dashboard/admin/groups/link-opportunity-dialog'
import type { AdvisorBatchPreview, AdvisorBatchReceipt, AdvisorUploadTicket } from '@/application/groups'
import { actorHasRole, checkStatus } from '@/composition/accounts'
import { describeGroupingSettingsReceipt, getCohortCommand } from '@/composition/cohorts'
import {
  describeAdvisorBatchReceipt,
  describeAdvisorChangeReceipt,
  describeDissolveReceipt,
  describeGroupTypeReceipt,
  describeLeaderChangeReceipt,
  describeLinkReceipt,
  describeMemberChangeReceipt,
  describeGroupHistory,
  describeTerminateReceipt,
  getAdvisorCommand,
  getGroupCommand,
  getGroupQuery,
  getOpportunityCommand,
  getOpportunityQuery,
} from '@/composition/groups'
import type { Result } from '@/shared/result'
import { formatTaipeiMinute } from '@/shared/time'

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
  // 刪除後切到「已刪除」篩選顯示回執，仍可從紀錄入口查看原組。
  const cohortId = text(formData, 'cohortId')
  if (UUID.test(cohortId)) redirect(`/dashboard/admin/groups?cohort=${cohortId}&status=deleted&dissolved=${result.receipt.groupId}`)
  refresh()
  return { ok: true, message: describeDissolveReceipt(result.receipt) }
}

export async function unlinkGroupOpportunityAction(_state: AdminGroupActionState, formData: FormData): Promise<AdminGroupActionState> {
  const result = await getOpportunityCommand().unlink(
    await currentActor(),
    { linkId: text(formData, 'linkId'), reason: text(formData, 'reason') },
    text(formData, 'requestId'),
  )
  if (!result.ok) return { ok: false, message: result.message }
  refresh()
  return { ok: true, message: describeLinkReceipt(result.receipt) }
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

// ── 把組別連到合作案（AD-06，設計方案 §3.3.1）──────────────────────────────────
// 這兩個動作只給系辦：守衛寫在 action 本身，不靠 `linkOptions` 的角色規則（它對老師也回資料），
// 也不讓組長拿系辦頁的動作去連（組長走學生頁自己的動作）。組別屆別是否還能寫（封存、唯讀）、
// 只限產學組、版本過期、首次理由選填／換案理由必填，全部照用例 `link()` 判，失敗訊息照原字回。

const LINK_FORBIDDEN = '只有系辦可以在這裡連結合作案。'
/** 對話框一頁幾筆；頁面初始選項也用同一個數（page.tsx）。 */
const LINK_OPTIONS_PAGE = 50

function isAdmin(actor: Awaited<ReturnType<typeof currentActor>>): boolean {
  return actorHasRole(actor, 'admin') && checkStatus(actor, 'business') === null
}

export async function linkOpportunityAction(_state: AdminGroupActionState, formData: FormData): Promise<AdminGroupActionState> {
  const actor = await currentActor()
  if (!isAdmin(actor)) return { ok: false, message: LINK_FORBIDDEN }
  const result = await getOpportunityCommand().link(
    actor,
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

/** 對話框的搜尋與下一頁：每次一頁 50 筆（回傳剛好 50 筆時對話框才顯示「下一頁」）。 */
export async function searchLinkOptionsAction(input: { q: string; offset: number }): Promise<LinkOptionsOutcome> {
  const actor = await currentActor()
  if (!isAdmin(actor)) return { ok: false, code: 'FORBIDDEN', message: LINK_FORBIDDEN }
  const q = typeof input?.q === 'string' ? input.q.slice(0, 100) : ''
  const offset = typeof input?.offset === 'number' && Number.isInteger(input.offset) && input.offset > 0 ? input.offset : 0
  return { ok: true, options: await getOpportunityQuery().linkOptions(actor, { q, limit: LINK_OPTIONS_PAGE, offset }) }
}

/** 組別詳情打開時才取異動歷程（SH-B4）；系辦分組頁本身不載歷程。 */
export async function loadGroupHistoryAction(groupId: string): Promise<GroupHistoryOutcome> {
  const actor = await currentActor()
  if (!isAdmin(actor)) return { ok: false, message: '只有系辦可以查看組別異動歷程。' }
  if (typeof groupId !== 'string' || !UUID.test(groupId)) return { ok: false, message: '找不到這個組別。' }
  const entries = await getGroupQuery().groupHistory(groupId)
  return {
    ok: true,
    history: entries.map((h, index) => ({
      key: `${index}`,
      atLabel: formatTaipeiMinute(h.at),
      text: describeGroupHistory(h),
      reason: h.reason,
    })),
  }
}
