import type { AccountStatus, ResolvedActor, Role } from '@/application/accounts/actor'
import { hasControlChars } from '@/application/accounts/registration'
import { STUDENT_NO_PATTERN } from '@/application/accounts/roster'
import { TEACHER_NAME_MAX_LENGTH } from '@/application/accounts/teachers'
import { err, type Err, type Result } from '@/shared/result'

/**
 * 帳號列「編輯」（C 階段規格② §3.2 X10、§3.8 調屆、§3.9 學生↔老師互轉；票 C2-08）。
 *
 * 純邏輯：欄位怎麼驗、前置條件怎麼判、不能存時寫哪一句。寫入、交易、撤 session 在 infrastructure
 * （`pg-profile-edit.ts`）。管理員勾不在這裡：沿用既有的 `grantRole`／`revokeRole`。
 *
 * 前置條件只讀四張表的「有效列」計數（§3.9）：`group_memberships`、`submission_versions`、
 * `advisor_assignments`、`evaluator_assignments`；這支用例不寫它們。
 */

/** 主角色：學生／老師二選一（管理員是另外勾的）；沒有主角色的職員是 null。 */
export type MainRole = 'student' | 'teacher'

/** 他目前所在的組（`group_memberships.valid_to is null`）。 */
export type ActiveMembership = {
  readonly groupId: string
  readonly groupCode: string
  readonly cohortCode: string
}

/** 角色互轉要看的事實（四張前置表的計數；設計方案 §3.9）。 */
export type RoleChangeFacts = {
  readonly memberships: readonly ActiveMembership[]
  /** `submission_versions.submitted_by_user_id = 他` 的列數（草稿不算）。 */
  readonly submissions: number
  /** 指導中的組（`advisor_assignments.valid_to is null`）。 */
  readonly advising: number
  /** 有效的評分指派（`evaluator_assignments.valid_to is null`）。 */
  readonly evaluating: number
}

/** 開視窗時就算好的樣子（不符合時「儲存」不可按，原因同一句）。 */
export type ProfileEditView = {
  readonly userId: string
  readonly name: string
  readonly loginEmail: string
  readonly roles: readonly Role[]
  readonly role: MainRole | null
  readonly studentNo: string | null
  readonly cohortId: string | null
  /** 屆別下拉：未封存的屆。 */
  readonly cohorts: readonly { readonly id: string; readonly code: string; readonly name: string }[]
  /** 不能改屆別時那一句與要連去的組（null＝可以改）。 */
  readonly cohortLock: { readonly reason: string; readonly groupId: string } | null
  /** 改成老師／學生不成立時那一句（null＝可以改；角色本來就是那個也是 null）。 */
  readonly toTeacherBlocked: string | null
  /** 改老師的原因裡「他在 X 屆第 N 組」那半句與它要連去的組（§3.9：組別那半句連到該組）；沒有組別是 null。 */
  readonly toTeacherGroupLink: { readonly text: string; readonly groupId: string } | null
  readonly toStudentBlocked: string | null
}

export type ProfileEditInput = {
  readonly userId: string
  readonly name: string
  readonly role: string | null
  readonly studentNo: string
  readonly cohortId: string
  readonly requestId: string
  /** 管理員勾（跟個資同一個交易）；沒給＝不動。 */
  readonly admin?: boolean
}

export type NormalizedProfileEdit = {
  readonly userId: string
  readonly name: string
  readonly role: MainRole | null
  readonly studentNo: string | null
  readonly cohortId: string | null
  readonly requestId: string
  /** null＝不動管理員角色。 */
  readonly admin: boolean | null
}

export type ProfileEditReceipt = {
  readonly userId: string
  readonly name: string
  readonly role: MainRole | null
  readonly cohortCode: string | null
  /** 主角色換了：對方的登入已撤掉，重登才拿到新身分。 */
  readonly roleChanged: boolean
  /** 存完之後是不是管理員。 */
  readonly admin: boolean
  readonly changedAt: string
}

/** 自己的 port（不改 `teachers.ts` 的 `AccountCommand`；設計方案 §3.8）。 */
export interface ProfileEditCommand {
  /** 開視窗時讀：目前的欄位、屆別選項、各種前置條件的原因句。 */
  view(actor: ResolvedActor, userId: string): Promise<Result<ProfileEditView>>
  /** 存：同一個交易改個人資料、學號占用、角色（含管理員勾）、收件名單、稽核；主角色換了同一個交易登出他當下的登入。 */
  edit(actor: ResolvedActor, input: ProfileEditInput): Promise<Result<ProfileEditReceipt>>
}

// ── 原因句（四句不能存的原因＋學號占用） ───────────────────────────────────────

export const STUDENT_FIELDS_REQUIRED = '學生要有學號和屆別'

const NO_MAIN_ROLE = '這個帳號沒有學生或老師身分，請用「補上身分」'

function whereIs(m: ActiveMembership): string {
  return `${m.cohortCode} 屆${m.groupCode}`
}

/** 「他在 115 屆第 3 組」：改老師的原因裡要連到該組的那半句（`canChangeRole` 用同一句開頭）。 */
export function membershipPhrase(m: ActiveMembership): string {
  return `他在 ${whereIs(m)}`
}

/** 有組別不能調屆。 */
export function cohortLockedMessage(m: ActiveMembership): string {
  return `他在 ${whereIs(m)}，先到分組把他移出才能改屆別`
}

/** 學號在新屆已有人占用（`student_identities` 主鍵撞到）。 */
export function studentNoTakenMessage(cohortCode: string): string {
  return `這個學號在 ${cohortCode} 屆已經有人`
}

// ── 規則 ────────────────────────────────────────────────────────────────────

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function invalid(field: string, message: string): Err {
  return err('VALIDATION_FAILED', message, { details: { field } })
}

export function mainRoleOf(roles: readonly Role[]): MainRole | null {
  if (roles.includes('student')) return 'student'
  if (roles.includes('teacher')) return 'teacher'
  return null
}

export function normalizeProfileEdit(input: ProfileEditInput): { ok: true; value: NormalizedProfileEdit } | Err {
  if (!UUID_PATTERN.test(input.userId)) return invalid('userId', '找不到這個帳號，請重新整理頁面。')
  if (!UUID_PATTERN.test(input.requestId)) return invalid('requestId', '這次送出缺少請求編號，請重新打開視窗再試。')
  const role = input.role === null ? null : input.role === 'student' || input.role === 'teacher' ? input.role : undefined
  if (role === undefined) return invalid('role', '請選學生或老師。')

  const name = input.name.trim().replace(/\s+/g, ' ')
  if (!name) return invalid('name', '請填姓名。')
  if (name.length > TEACHER_NAME_MAX_LENGTH || hasControlChars(name)) return invalid('name', `姓名最多 ${TEACHER_NAME_MAX_LENGTH} 個字。`)

  const admin = typeof input.admin === 'boolean' ? input.admin : null
  if (role === 'student' && admin === true) return invalid('admin', '學生帳號不能設為管理員；請用老師或職員的帳號。')
  if (role !== 'student') return { ok: true, value: { userId: input.userId, name, role, studentNo: null, cohortId: null, requestId: input.requestId, admin } }

  const studentNo = input.studentNo.trim()
  const cohortId = input.cohortId.trim()
  if (!studentNo || !cohortId) return err('VALIDATION_FAILED', STUDENT_FIELDS_REQUIRED, { details: { field: studentNo ? 'cohortId' : 'studentNo' } })
  if (!STUDENT_NO_PATTERN.test(studentNo)) return invalid('studentNo', '學號只能有英文字母和數字。')
  if (!UUID_PATTERN.test(cohortId)) return invalid('cohortId', '請重新選屆別。')
  return { ok: true, value: { userId: input.userId, name, role, studentNo, cohortId, requestId: input.requestId, admin } }
}

/** 調屆：目前有有效組別就不能改（設計方案 §3.8）。 */
export function canChangeCohort(
  memberships: readonly ActiveMembership[],
): { ok: true } | { ok: false; reason: string; groupId: string } {
  const first = memberships[0]
  if (!first) return { ok: true }
  return { ok: false, reason: cohortLockedMessage(first), groupId: first.groupId }
}

/** 學生↔老師互轉的前置條件（設計方案 §3.9）；成立回 null，不成立回「儲存」旁那一句（只寫不成立的那半句）。 */
export function canChangeRole(from: MainRole | null, to: MainRole | null, facts: RoleChangeFacts): string | null {
  if (from === to) return null
  if (from === null || to === null) return NO_MAIN_ROLE
  const parts: string[] = []
  if (to === 'teacher') {
    const first = facts.memberships[0]
    if (first) parts.push(membershipPhrase(first))
    if (facts.submissions > 0) parts.push(`有 ${facts.submissions} 筆繳交紀錄`)
    return parts.length === 0 ? null : `${parts.join('、')}，不能改成老師`
  }
  if (facts.advising > 0) parts.push(`他指導中 ${facts.advising} 組`)
  if (facts.evaluating > 0) parts.push(`有 ${facts.evaluating} 筆評分指派`)
  return parts.length === 0 ? null : `${parts.join('、')}，不能改成學生`
}

/** 列上「編輯」什麼時候不能按（設計方案 §3.2；不能按時 `title` 與按鈕同一句）。 */
export function profileEditRowBlocker(
  row: { readonly userId: string; readonly status: AccountStatus; readonly roles: readonly Role[]; readonly orphan: boolean },
  currentUserId: string,
): string | null {
  if (row.userId === currentUserId) return '自己的資料請到我的帳號改'
  if (row.status === 'deidentified') return '已刪除個人資料，不能再改'
  if (row.status === 'disabled') return '已停用，先恢復才能編輯'
  if (row.status === 'pending') return '還在待審核，請到待審核分頁處理'
  if (row.orphan || row.roles.length === 0) return '還沒設定身分，請先用「補上身分」'
  return null
}
