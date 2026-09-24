import { hasRole, statusGate, type ResolvedActor } from '@/application/accounts/actor'
import {
  APPLIED_NAME_MAX_LENGTH,
  hasControlChars,
  isValidEmail,
  isValidPhone,
  normalizeApproval,
  type ApprovalDecision,
  type VerificationMethod,
} from '@/application/accounts/registration'
import type {
  OrphanRepairInput,
  OrphanRepairReceipt,
  RoleChangeInput,
  RoleChangeReceipt,
} from '@/application/accounts/roles'
import type { ErrorCode } from '@/shared/errors'
import { err, type Err, type Result, type SecretOnce } from '@/shared/result'

/**
 * 老師帳號與臨時密碼的規則（產品模組 01 §2.4「老師帳號」、§2.5「管理員帳號能力」；
 * 工程模組 01 §3「臨時密碼」「老師建立／預授權」兩列、§5 `AccountCommand`；契約 03 §3；票 8）。
 *
 * 這個檔是純邏輯：欄位怎麼驗、誰能做。寫入、交易、Better Auth 在 infrastructure
 * （`account-command.ts`）。
 *
 * 貫穿全檔的三條規則：
 * 1. **沒有任何地方能看到既有密碼**：系統只存雜湊（Better Auth），臨時密碼是新產生的，
 *    只出現在核發那一次的回應本體（`SecretOnce`）；帳本、稽核、log 都不含它。
 * 2. **核發臨時密碼前必須記錄核實方式**：選項與規則和註冊核准同一套（`normalizeApproval`），
 *    班代協助聯絡不能單獨作為依據，所以沒有那個選項。
 * 3. **預授權的 Email 先占住**：帳號在系辦按下去的那一刻就建好（`users.email` 唯一），
 *    別人拿同一個 Email 註冊會被拒；帳號沒有密碼，也沒人登得進去，直到本人用 Google
 *    （票 10）或系辦核發的臨時密碼登入。
 */

export const TEACHER_NAME_MAX_LENGTH = APPLIED_NAME_MAX_LENGTH

/**
 * 新增老師的兩種方式。
 *
 * - `direct`：系辦當場建好並核發臨時密碼（只顯示一次），老師用 Email＋密碼登入、先改密碼。
 * - `preauthorize`：只用 Email 建預授權，不發密碼；老師之後用這個 Email 的 Google 帳號登入
 *   （票 10），或需要時系辦再按「發臨時密碼」。
 */
export type TeacherCreationMode = 'direct' | 'preauthorize'

export type TeacherAccountInput = {
  readonly mode: TeacherCreationMode
  readonly email: string
  /** 直接新增必填；預授權選填（老師第一次登入時會自己補）。 */
  readonly name: string
  /** 直接新增會核發臨時密碼，所以跟「發臨時密碼」一樣要記核實方式；預授權不需要。 */
  readonly verificationMethod: string
  readonly verificationNote: string
}

export type NormalizedTeacherAccount = {
  readonly mode: TeacherCreationMode
  readonly email: string
  readonly name: string | null
  readonly verification: ApprovalDecision | null
}

function invalid(field: string, message: string): Err {
  return err('VALIDATION_FAILED', message, { details: { field } })
}

function checkName(name: string, required: boolean, field = 'name'): Err | null {
  if (!name) return required ? invalid(field, '請填姓名。') : null
  if (name.length > TEACHER_NAME_MAX_LENGTH || hasControlChars(name)) {
    return invalid(field, `姓名最多 ${TEACHER_NAME_MAX_LENGTH} 個字。`)
  }
  return null
}

export function normalizeTeacherAccountInput(
  input: TeacherAccountInput,
): { ok: true; value: NormalizedTeacherAccount } | Err {
  if (input.mode !== 'direct' && input.mode !== 'preauthorize') {
    return invalid('mode', '請選擇新增方式。')
  }
  const email = input.email.trim().toLowerCase()
  if (!email) return invalid('email', '請填老師的登入 Email。')
  if (!isValidEmail(email)) return invalid('email', '登入 Email 的格式不對。')

  const name = input.name.trim().replace(/\s+/g, ' ')
  const nameProblem = checkName(name, input.mode === 'direct')
  if (nameProblem) return nameProblem

  if (input.mode === 'preauthorize') {
    return { ok: true, value: { mode: 'preauthorize', email, name: name || null, verification: null } }
  }
  const verification = normalizeApproval({
    verificationMethod: input.verificationMethod,
    verificationNote: input.verificationNote,
    reason: '',
  })
  if (!verification.ok) return verification
  return { ok: true, value: { mode: 'direct', email, name, verification: verification.value } }
}

/** 核發臨時密碼的欄位：核實方式必選、校方管道與其他方式要寫說明、理由選填（契約 03 §3）。 */
export function normalizeTemporaryPasswordRequest(input: {
  verificationMethod: string
  verificationNote: string
  reason: string
}): { ok: true; value: ApprovalDecision } | Err {
  return normalizeApproval(input)
}

/** 老師第一次登入補的資料：姓名與聯絡資料，不需要學號（§2.4「老師帳號」）。 */
export type TeacherProfileInput = {
  readonly displayName: string
  /** 選填：老師不一定要留手機。 */
  readonly phone: string
  readonly contactEmail: string
}

export function normalizeTeacherProfile(
  input: TeacherProfileInput,
): { ok: true; value: { displayName: string; phone: string | null; contactEmail: string } } | Err {
  const displayName = input.displayName.trim().replace(/\s+/g, ' ')
  const nameProblem = checkName(displayName, true, 'displayName')
  if (nameProblem) return nameProblem

  const phone = input.phone.trim()
  if (phone && !isValidPhone(phone)) return invalid('phone', '手機號碼的格式不對。')

  const contactEmail = input.contactEmail.trim().toLowerCase()
  if (!contactEmail) return invalid('contactEmail', '請填聯絡 Email。')
  if (!isValidEmail(contactEmail)) return invalid('contactEmail', '聯絡 Email 的格式不對。')

  return { ok: true, value: { displayName, phone: phone || null, contactEmail } }
}

// ── 授權 ────────────────────────────────────────────────────────────────────

/** 新增老師、發臨時密碼、查帳號：只有狀態正常的管理員（契約 03 §1「帳號」列）。 */
export function accountAdminDenied(actor: ResolvedActor): ErrorCode | null {
  const blocked = statusGate(actor, 'business')
  if (blocked) return blocked
  return hasRole(actor, 'admin') ? null : 'FORBIDDEN'
}

/**
 * 老師補資料：狀態正常（已改過臨時密碼）的老師本人。
 *
 * must-change 的人先被 `statusGate` 擋成 `PASSWORD_CHANGE_REQUIRED`——先改密碼，再補資料。
 */
export function teacherSetupDenied(actor: ResolvedActor): ErrorCode | null {
  const blocked = statusGate(actor, 'business')
  if (blocked) return blocked
  return hasRole(actor, 'teacher') ? null : 'FORBIDDEN'
}

// ── port ────────────────────────────────────────────────────────────────────

/**
 * 新增老師的回執（**不含秘密**；帳本存的就是這個，重播也回這個）。
 *
 * 直接新增時，第一次回應是 `SecretOnce & { account }`——臨時密碼只在那一次的回應本體裡
 * （契約 02 §1、契約 03 §3）；同一個請求重送拿到的是這個回執，`temporaryPasswordIssued=true`
 * 告訴畫面「已核發但無法取回，請重新核發」。
 */
export type TeacherAccountReceipt = {
  readonly userId: string
  readonly email: string
  readonly name: string | null
  readonly mode: TeacherCreationMode
  readonly createdAt: string
  readonly temporaryPasswordIssued: boolean
}

export type TeacherCreatedWithSecret = SecretOnce & { readonly account: TeacherAccountReceipt }

/** 系辦用 Email 找到要發臨時密碼的帳號（帳號列表由票 9 做；這裡只給對話框用）。 */
export type AccountLookup = {
  readonly userId: string
  readonly name: string
  readonly email: string
  readonly roles: readonly ('student' | 'teacher' | 'admin')[]
  readonly status: 'pending' | 'active' | 'disabled' | 'deidentified'
}

/**
 * 核發臨時密碼的回執（**不含秘密**）。第一次回應是 `SecretOnce`；這個只在重播時出現，
 * 意思是「已經核發過了、密碼無法取回，要的話請重新核發（舊的那組會失效）」。
 */
export type TemporaryPasswordReceipt = {
  readonly userId: string
  readonly verificationMethod: VerificationMethod
  readonly issuedAt: string
}

export interface AccountCommand {
  /**
   * 新增老師（直接新增或預授權）。
   *
   * `authHeaders` 是**發動這個動作的管理員**這次請求的 headers：Better Auth admin plugin
   * 自己要驗呼叫端是管理員（契約 03 §2 的 2026-09-15 補充）。
   */
  createTeacher(
    actor: ResolvedActor,
    authHeaders: Headers,
    input: TeacherAccountInput & { requestId: string },
  ): Promise<Result<TeacherAccountReceipt> | TeacherCreatedWithSecret>
  /** 用登入 Email 找帳號（發臨時密碼之前先確認是誰）。 */
  lookupByEmail(actor: ResolvedActor, email: string): Promise<Result<AccountLookup>>
  /** 替任一帳號核發一次性臨時密碼：舊密碼立刻失效、舊登入撤銷、本人下次登入必須改密碼。 */
  issueTemporaryPassword(
    actor: ResolvedActor,
    authHeaders: Headers,
    input: { userId: string; verificationMethod: string; verificationNote: string; reason: string; requestId: string },
  ): Promise<Result<TemporaryPasswordReceipt> | SecretOnce>
  /**
   * 把老師或職員設為管理員（票 10b）：同一個交易寫 `role_assignments` 與套件的 `users.role='admin'`、
   * 稽核與帳本；理由必填；不能對自己做。
   */
  grantRole(actor: ResolvedActor, input: RoleChangeInput): Promise<Result<RoleChangeReceipt>>
  /**
   * 取消管理員（票 10b）：結束 `role_assignments` 那一列、`users.role` 改回 `'user'`；
   * 不能取消自己、不能取消最後一位有效管理員。
   */
  revokeRole(actor: ResolvedActor, input: RoleChangeInput): Promise<Result<RoleChangeReceipt>>
  /**
   * 孤兒帳號補建角色（票 10b）：補老師或管理員角色，待審的一併開通；帳號仍須是孤兒（見 `isOrphan`）。
   */
  repairOrphan(actor: ResolvedActor, input: OrphanRepairInput): Promise<Result<OrphanRepairReceipt>>
}

/** 老師補資料頁要顯示的內容。 */
export type TeacherProfileView = {
  readonly loginEmail: string
  /** 系辦建帳號時填的姓名（預授權沒填就是空字串）。 */
  readonly displayName: string
  readonly phone: string
  readonly contactEmail: string
  readonly completed: boolean
}

export interface TeacherSetupCommand {
  view(actor: ResolvedActor): Promise<Result<TeacherProfileView>>
  complete(actor: ResolvedActor, input: TeacherProfileInput): Promise<Result<{ readonly completedAt: string }>>
  /** 這個人是不是「有老師角色、還沒補資料」（登入後的目的地與老師首頁用）。 */
  needsSetup(userId: string): Promise<boolean>
}
