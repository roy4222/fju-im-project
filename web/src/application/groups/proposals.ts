import type { ResolvedActor } from '@/application/accounts'
import { CHANGE_REASON_MAX_LENGTH, normalizeReason } from '@/application/groups/members'
import { err, type Err } from '@/shared/result'

/**
 * 找組員、提案與成組的型別與純規則（產品模組 03 §5.1、§5.2、「提案終止」「組長」；票 13）。
 *
 * 這個檔沒有資料庫：學號名單怎麼整理、人數合不合設定、到期時間怎麼算、終止種類叫什麼，
 * 都在這裡單獨測。交易、鎖與唯一約束在 infrastructure。
 *
 * 2026-09-24 Roy 定案：沒有「例外組」；每組人數由管理員設定（預設 5 人，可設最少／最多），
 * 學生提案的人數（含自己）要落在設定範圍內。特殊情況由管理員直接調整組員（票 14）。
 */

export type GroupType = 'general' | 'industry'
export const GROUP_TYPES: readonly GroupType[] = ['general', 'industry']
export const GROUP_TYPE_LABEL: Record<GroupType, string> = { general: '一般專題', industry: '產學合作' }

export type ProposalState = 'open' | 'established' | 'terminated'
export const PROPOSAL_STATE_LABEL: Record<ProposalState, string> = {
  open: '等待確認',
  established: '已成立',
  terminated: '已終止',
}

export type InvitationState = 'pending' | 'confirmed' | 'declined' | 'withdrawn' | 'released'
export const INVITATION_STATE_LABEL: Record<InvitationState, string> = {
  pending: '待確認',
  confirmed: '已確認',
  declined: '已拒絕',
  withdrawn: '已撤回',
  released: '已釋放',
}

/**
 * 提案終止的種類（Q-GRP01 的五種＋成立瞬間撞到別組的 `conflict`）。
 * 標籤就是產品文件寫的紀錄名稱。
 */
export type TerminationKind =
  | 'declined'
  | 'member_withdrew'
  | 'proposer_withdrew'
  | 'expired'
  | 'admin_voided'
  | 'conflict'
export const TERMINATION_KIND_LABEL: Record<TerminationKind, string> = {
  declined: '被拒絕',
  member_withdrew: '成員撤回同意',
  proposer_withdrew: '提案人撤回',
  expired: '逾期',
  admin_voided: '管理員作廢',
  conflict: '成員已在其他組',
}

export const VOID_REASON_MAX_LENGTH = CHANGE_REASON_MAX_LENGTH
export const STUDENT_NO_MAX_LENGTH = 20

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value)
}

/** 學號只收英數（保留前導零，大小寫不動）。 */
const STUDENT_NO_PATTERN = /^[A-Za-z0-9]+$/

export type ProposeInput = {
  readonly groupType: string
  /** 其他組員的學號（不含自己；含了也會自動去掉）。空白欄會被略過。 */
  readonly memberStudentNos: readonly string[]
}

export type NormalizedProposal = {
  readonly groupType: GroupType
  /** 去空白、去重複、去掉自己之後的其他組員學號，依輸入順序。 */
  readonly memberStudentNos: readonly string[]
}

/**
 * 整理提案輸入並檢查人數。人數＝其他組員＋自己，要落在屆別的 [最少, 最多]。
 * `proposerStudentNo` 是提案人自己的學號（有的話），名單裡出現就當作沒填。
 */
export function normalizeProposeInput(
  input: ProposeInput,
  size: { readonly min: number; readonly max: number },
  proposerStudentNo: string | null,
): { ok: true; value: NormalizedProposal } | Err {
  if (!(GROUP_TYPES as readonly string[]).includes(input.groupType)) {
    return err('VALIDATION_FAILED', '請選組別類型（一般專題或產學合作）。', { details: { field: 'groupType' } })
  }

  const seen = new Set<string>()
  const members: string[] = []
  for (const raw of input.memberStudentNos) {
    const no = raw.trim()
    if (!no) continue
    if (no.length > STUDENT_NO_MAX_LENGTH || !STUDENT_NO_PATTERN.test(no)) {
      return err('VALIDATION_FAILED', `學號「${no}」格式不對：只能是英文字母與數字。`, {
        details: { field: 'memberStudentNos' },
      })
    }
    if (no === proposerStudentNo || seen.has(no)) continue
    seen.add(no)
    members.push(no)
  }

  const total = members.length + 1
  if (total < size.min || total > size.max) {
    const range = size.min === size.max ? `${size.min} 人` : `${size.min}–${size.max} 人`
    const others = size.min === size.max ? `${size.min - 1} 位` : `${size.min - 1}–${size.max - 1} 位`
    return err(
      'VALIDATION_FAILED',
      `本屆每組 ${range}（含你自己），請填 ${others}同學的學號；現在是 ${total} 人。`,
      { details: { field: 'memberStudentNos' } },
    )
  }

  return { ok: true, value: { groupType: input.groupType as GroupType, memberStudentNos: members } }
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 提案到期時間＝min(發起的業務時間＋預設天數, 成組截止)（模組實作設計 03 §3；產品「最晚不超過成組截止」）。
 */
export function proposalExpiry(businessNow: Date, defaultDays: number, groupingDeadline: Date): Date {
  const byDays = new Date(businessNow.getTime() + defaultDays * DAY_MS)
  return byDays.getTime() <= groupingDeadline.getTime() ? byDays : new Date(groupingDeadline.getTime())
}

/** 管理員作廢的理由：必填、去前後空白、有長度上限（和其他管理員動作同一條規則）。 */
export function normalizeVoidReason(reason: string): { ok: true; value: string } | Err {
  return normalizeReason(reason, '作廢')
}

/** 學生的屆別（模組 01：學生的屆別在個人資料；老師與管理員沒有）。 */
export function studentCohortOf(actor: ResolvedActor): string | null {
  if (actor.kind !== 'authenticated' || !actor.roles.includes('student')) return null
  return actor.cohortMemberships.find((m) => m.role === 'student')?.cohortId ?? null
}

export function isAdmin(actor: ResolvedActor): boolean {
  return actor.kind === 'authenticated' && actor.roles.includes('admin')
}

/** 可以看某一屆找組員名單的人：同屆學生、老師、管理員（產品模組 03 §5.1）。 */
export function canViewTeammates(actor: ResolvedActor, cohortId: string): boolean {
  if (actor.kind !== 'authenticated') return false
  if (actor.roles.includes('admin') || actor.roles.includes('teacher')) return true
  return studentCohortOf(actor) === cohortId
}

/** 找組員名單的一列：只有這三欄（電話不公開，契約 03 §4 最小揭露）。 */
export type TeammateListing = {
  readonly name: string
  readonly studentNo: string
  readonly contactEmail: string
}

/** 組別成立的號碼：屆別內遞增，G01、G02…（S03-06 暫定規則）。 */
export function nextGroupCode(existing: readonly string[]): string {
  let max = 0
  for (const code of existing) {
    const match = /^G(\d+)$/.exec(code)
    if (match) max = Math.max(max, Number(match[1]))
  }
  return `G${String(max + 1).padStart(2, '0')}`
}

// ── 回執 ────────────────────────────────────────────────────────────────────

export type SetOpenToJoinReceipt = { readonly openToJoin: boolean }

export type ProposeReceipt = {
  readonly proposalId: string
  readonly memberCount: number
  readonly expiresBusinessAt: string
}

/**
 * 確認的結果：
 * - `confirmed`：還在等別人；
 * - `established`：你是最後一位，組別成立了；
 * - `already_confirmed`：你之前就確認過（按兩次不會變成錯誤）；
 * - `conflict`：成立那一刻發現有人已經在別組，提案整份終止、所有人釋放。
 */
export type ConfirmReceipt = {
  readonly proposalId: string
  readonly outcome: 'confirmed' | 'established' | 'already_confirmed' | 'conflict'
  readonly confirmedCount: number
  readonly memberCount: number
  readonly groupCode: string | null
}

export type TerminateReceipt = {
  readonly proposalId: string
  readonly terminationKind: TerminationKind
}

export function describeConfirmReceipt(receipt: ConfirmReceipt): string {
  switch (receipt.outcome) {
    case 'established':
      return `全員確認，組別 ${receipt.groupCode} 成立了。`
    case 'conflict':
      return '有成員剛剛已經加入別的組，這份提案已終止，所有人都已釋放。'
    case 'already_confirmed':
      return `你之前已經確認過了（${receipt.confirmedCount}／${receipt.memberCount} 已確認）。`
    case 'confirmed':
      return `已確認（${receipt.confirmedCount}／${receipt.memberCount} 已確認），等其他人確認。`
  }
}

export function describeTerminateReceipt(receipt: TerminateReceipt): string {
  return `提案已終止（${TERMINATION_KIND_LABEL[receipt.terminationKind]}），所有人都已釋放，可以重新發起或被邀請。`
}

/** 到期處理器（背景工作呼叫）的結果；不是給使用者看的回執。 */
export type ExpireOutcome =
  /** 真的終止了。 */
  | 'expired'
  /** 已經成立或終止：什麼都不做（例如成立後遲到的到期工作）。 */
  | 'not_open'
  /** 期限版本不是目前的（期限改過）：舊版本的工作不做事。 */
  | 'stale_version'
  /** 業務時間還沒到（例如模擬鐘被往回撥）：不做事，留給下一次。 */
  | 'not_due'
  | 'not_found'
