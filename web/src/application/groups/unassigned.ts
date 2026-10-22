import { taipeiParts } from '@/shared/time'

/**
 * 系辦「未分組學生」分頁（設計方案③ §6.3；C3-15、AC-C3-19）的型別與純規則。
 *
 * 每列的狀態由兩個事實合成：這位同學是不是在某個建立中的組別裡（`proposal`），以及本人有沒有公開找隊員
 * （`openToJoin`）。在建立中的組別裡優先：那時系辦能做的只有「終止建立」，不能直接加入組別。
 * 資料庫查詢在 infrastructure 的 `pg-unassigned.ts`（一句 SQL）。
 */

/** 這位同學正在的建立中組別（發起人與到期時間；到期是業務時間）。 */
export type UnassignedProposal = {
  readonly id: string
  readonly proposerName: string
  readonly expiresBusinessAt: Date
}

/** 未分組的一列：同屆、有效學生、沒有有效組別。 */
export type UnassignedStudent = {
  readonly userId: string
  readonly name: string
  readonly studentNo: string
  readonly departmentClass: string | null
  readonly avatarPreset: number | null
  readonly avatarFileId: string | null
  /** 名片的技能（本人關掉公開找隊員時仍留著，系辦照樣看得到）。 */
  readonly skills: readonly string[]
  readonly openToJoin: boolean
  readonly proposal: UnassignedProposal | null
}

/** 「加入組別」可選的組別（本屆有效組別）。 */
export type UnassignedJoinableGroup = {
  readonly id: string
  readonly code: string
  readonly revision: number
  readonly memberCount: number
}

export type UnassignedRoster = {
  readonly students: readonly UnassignedStudent[]
  readonly groups: readonly UnassignedJoinableGroup[]
}

export interface UnassignedQuery {
  /** 一屆的未分組學生（依學號）與可加入的組別（依代碼）。`cohortId` 不是 uuid 時回空的。 */
  roster(cohortId: string): Promise<UnassignedRoster>
}

export type UnassignedStatus = 'in_proposal' | 'open_to_join' | 'available'

export function unassignedStatus(student: Pick<UnassignedStudent, 'openToJoin' | 'proposal'>): UnassignedStatus {
  if (student.proposal) return 'in_proposal'
  return student.openToJoin ? 'open_to_join' : 'available'
}

/** 臺灣時間的「M/D」。 */
function monthDay(instant: Date): string {
  const p = taipeiParts(instant)
  return `${p.month}/${p.day}`
}

/** 列上的狀態字：「可加入」「公開找隊員」「建立中（發起人 X，到期 M/D）」。 */
export function describeUnassignedStatus(student: Pick<UnassignedStudent, 'openToJoin' | 'proposal'>): string {
  const status = unassignedStatus(student)
  if (status === 'in_proposal' && student.proposal) {
    return `建立中（發起人 ${student.proposal.proposerName}，到期 ${monthDay(student.proposal.expiresBusinessAt)}）`
  }
  return status === 'open_to_join' ? '公開找隊員' : '可加入'
}

/** 列上方的一行數字：「N 人未分組・M 人公開找隊員・K 份建立中」（建立中以組別計，不以人計）。 */
export function summarizeUnassigned(students: readonly Pick<UnassignedStudent, 'openToJoin' | 'proposal'>[]): string {
  const open = students.filter((s) => s.openToJoin).length
  const proposals = new Set(students.flatMap((s) => (s.proposal ? [s.proposal.id] : []))).size
  return `${students.length} 人未分組・${open} 人公開找隊員・${proposals} 份建立中`
}

/** 技能膠囊：最多顯示 `max` 個，其餘收成「+N」（N 為 0 時不顯示）。 */
export function skillChips(skills: readonly string[], max = 3): { readonly shown: readonly string[]; readonly more: number } {
  return { shown: skills.slice(0, max), more: Math.max(0, skills.length - max) }
}

/** 「終止建立」成功的回饋句。 */
export function describeUnassignedVoid(proposerName: string): string {
  return `已終止 ${proposerName} 建立中的組別`
}
