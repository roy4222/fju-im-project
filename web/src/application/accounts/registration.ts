import { hasRole, statusGate, type ResolvedActor } from '@/application/accounts/actor'
import { normalizeName, STUDENT_NO_PATTERN } from '@/application/accounts/roster'
import type { ErrorCode } from '@/shared/errors'
import { err, type Err, type Result } from '@/shared/result'

/**
 * 學生註冊、名單比對與審核的規則（產品模組 01 §2.4「註冊、名單比對與審核」；
 * 工程模組 01 §3 狀態表、§5 `RegistrationCommand`、§6 核准交易；票 7）。
 *
 * 這個檔是純邏輯：欄位怎麼驗、名單怎麼比、核准要帶什麼、誰能做哪一步。
 * 寫入、交易、Better Auth 都在 infrastructure（`registration-command.ts`），
 * 那邊每個方法一開頭就先呼叫這裡的授權與驗證。
 *
 * 三條貫穿全檔的規則：
 * 1. **沒有自動核准**（Q-ACC01）：名單比對只產生「比對結果」給系辦看，不改任何狀態。
 * 2. **比對結果只給系辦看**：申請人自己的頁面不顯示命中與否——不然任何人拿別人的學號註冊
 *    再改幾次，就能問出「某學號在不在名單上」（契約 03 §4 最小揭露）。
 * 3. **核准依當時的申請資料版本**：學生改過資料，舊畫面上的核准一律 `CONFLICT`。
 */

// ── 欄位 ────────────────────────────────────────────────────────────────────

/** 密碼長度下限；改密碼（`change-password-rules`）與註冊共用這一個數字。 */
export const PASSWORD_MIN_LENGTH = 12
/** 上限只是擋離譜的輸入（雜湊成本）；Better Auth 自己的上限是 128。 */
export const PASSWORD_MAX_LENGTH = 128

export const APPLIED_NAME_MAX_LENGTH = 50
export const DEPARTMENT_CLASS_MAX_LENGTH = 20
export const REASON_MAX_LENGTH = 500

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const EMAIL_MAX_LENGTH = 254
/** 手機：數字、空白、`+`、`-`、括號；數字要 8～15 碼。不猜格式，只擋明顯不是電話的東西。 */
const PHONE_PATTERN = /^[0-9+\-() ]{8,25}$/

/** Email 的格式檢查（註冊與老師帳號共用；模組內部用，不從 index 對外）。 */
export function isValidEmail(value: string): boolean {
  return value.length <= EMAIL_MAX_LENGTH && EMAIL_PATTERN.test(value) && !hasControlChars(value)
}

/** 手機的格式檢查（註冊與老師補資料共用）。 */
export function isValidPhone(value: string): boolean {
  const digits = value.replace(/\D/g, '').length
  return PHONE_PATTERN.test(value) && digits >= 8 && digits <= 15
}

/**
 * 有沒有控制字元（含換行）。這些欄位會出現在名單、匯出與稽核裡，一律不收。
 * `allowLineBreaks` 給理由這種多行文字用：只放行換行與 tab。
 */
export function hasControlChars(value: string, allowLineBreaks = false): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (allowLineBreaks && (code === 0x0a || code === 0x0d || code === 0x09)) continue
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/** 申請人可以填、也可以在待審期間修改的欄位（登入 Email 不在內：本人不能改）。 */
export type ApplicationFields = {
  readonly appliedName: string
  readonly studentNo: string
  readonly departmentClass: string
  readonly phone: string
  readonly contactEmail: string
}

export type RegistrationInput = {
  readonly appliedName: string
  readonly studentNo: string
  readonly departmentClass: string
  readonly phone: string
  readonly loginEmail: string
  readonly password: string
  readonly passwordConfirm: string
}

type Field = 'appliedName' | 'studentNo' | 'departmentClass' | 'phone' | 'loginEmail' | 'contactEmail' | 'password' | 'passwordConfirm'

function invalid(field: Field, message: string): Err {
  return err('VALIDATION_FAILED', message, { details: { field } })
}

function checkEmail(value: string, field: 'loginEmail' | 'contactEmail', label: string): Err | null {
  if (!value) return invalid(field, `請填${label}。`)
  if (!isValidEmail(value)) return invalid(field, `${label}的格式不對。`)
  return null
}

/**
 * 整理並驗證申請欄位（註冊與修改共用）。
 *
 * 姓名保留原始填寫內容（只去頭尾空白）；比對用的正規化版本另外算，不覆蓋原文（§2.4）。
 */
export function normalizeApplicationFields(input: ApplicationFields): { ok: true; value: ApplicationFields } | Err {
  const appliedName = input.appliedName.trim()
  const studentNo = input.studentNo.trim()
  const departmentClass = input.departmentClass.trim().replace(/\s+/g, ' ')
  const phone = input.phone.trim()
  const contactEmail = input.contactEmail.trim().toLowerCase()

  if (!appliedName) return invalid('appliedName', '請填姓名。')
  if (appliedName.length > APPLIED_NAME_MAX_LENGTH || hasControlChars(appliedName)) {
    return invalid('appliedName', `姓名最多 ${APPLIED_NAME_MAX_LENGTH} 個字。`)
  }
  if (!studentNo) return invalid('studentNo', '請填學號。')
  if (!STUDENT_NO_PATTERN.test(studentNo)) return invalid('studentNo', '學號只能是英文字母與數字（最多 20 碼）。')
  if (!departmentClass) return invalid('departmentClass', '請填系級，例如「資管二甲」。')
  if (departmentClass.length > DEPARTMENT_CLASS_MAX_LENGTH || hasControlChars(departmentClass)) {
    return invalid('departmentClass', `系級最多 ${DEPARTMENT_CLASS_MAX_LENGTH} 個字。`)
  }
  if (!phone) return invalid('phone', '請填手機。')
  if (!isValidPhone(phone)) return invalid('phone', '手機號碼的格式不對。')
  const emailProblem = checkEmail(contactEmail, 'contactEmail', '聯絡 Email')
  if (emailProblem) return emailProblem

  return { ok: true, value: { appliedName, studentNo, departmentClass, phone, contactEmail } }
}

/**
 * 已開通的人在帳號頁改的兩個欄位：手機與聯絡 Email（票 10；§2.3 登入 Email 不在內）。
 * 規則與註冊、修改申請同一套。
 */
export function normalizeContactFields(input: {
  phone: string
  contactEmail: string
}): { ok: true; value: { phone: string; contactEmail: string } } | Err {
  const phone = input.phone.trim()
  const contactEmail = input.contactEmail.trim().toLowerCase()
  if (!phone) return invalid('phone', '請填手機。')
  const digits = phone.replace(/\D/g, '').length
  if (!PHONE_PATTERN.test(phone) || digits < 8 || digits > 15) return invalid('phone', '手機號碼的格式不對。')
  const emailProblem = checkEmail(contactEmail, 'contactEmail', '聯絡 Email')
  if (emailProblem) return emailProblem
  return { ok: true, value: { phone, contactEmail } }
}

/** 註冊表單：申請欄位＋登入 Email＋密碼。聯絡 Email 預設等於登入 Email，不要求重填（§2.4）。 */
export function normalizeRegistrationInput(
  input: RegistrationInput,
): { ok: true; value: ApplicationFields & { loginEmail: string; password: string } } | Err {
  const loginEmail = input.loginEmail.trim().toLowerCase()
  const emailProblem = checkEmail(loginEmail, 'loginEmail', '登入 Email')
  if (emailProblem) return emailProblem

  const fields = normalizeApplicationFields({ ...input, contactEmail: loginEmail })
  if (!fields.ok) return fields

  if (input.password.length < PASSWORD_MIN_LENGTH) {
    return invalid('password', `密碼至少要 ${PASSWORD_MIN_LENGTH} 個字元。`)
  }
  if (input.password.length > PASSWORD_MAX_LENGTH) return invalid('password', `密碼最多 ${PASSWORD_MAX_LENGTH} 個字元。`)
  if (input.password !== input.passwordConfirm) return invalid('passwordConfirm', '兩次輸入的密碼不一樣。')

  return { ok: true, value: { ...fields.value, loginEmail, password: input.password } }
}

// ── 名單比對 ────────────────────────────────────────────────────────────────

/** 某一屆最新名單版本裡的一列（比對用）。 */
export type RosterCandidate = {
  readonly rosterVersionId: string
  readonly cohortId: string
  readonly cohortCode: string
  readonly cohortName: string
  readonly studentNo: string
  readonly nameRaw: string
  readonly nameNormalized: string
  readonly email: string | null
  readonly departmentClass: string | null
}

export type RosterMatchStatus = 'matched' | 'name_mismatch' | 'not_found'
export type EmailComparison = 'same' | 'different' | 'roster_blank' | 'not_applicable'
export type TextComparison = 'same' | 'different' | 'roster_blank' | 'not_applicable'

export type RosterHit = {
  readonly rosterVersionId: string
  readonly cohortId: string
  readonly cohortCode: string
  readonly cohortName: string
  readonly nameRaw: string
  readonly email: string | null
  readonly departmentClass: string | null
  readonly nameMatches: boolean
}

/**
 * 一次比對的結果（存進 `registration_applications.roster_match`，也存進每一版的快照）。
 *
 * `hit` 是拿來並列的那一列；`hits` 是所有屆別裡同學號的列（跨屆衝突時不只一列）。
 */
export type RosterMatch = {
  readonly status: RosterMatchStatus
  readonly hit: RosterHit | null
  readonly hits: readonly RosterHit[]
  readonly emailComparison: EmailComparison
  readonly departmentClassComparison: TextComparison
}

function sameStudentNo(a: string, b: string): boolean {
  return a.trim().toUpperCase() === b.trim().toUpperCase()
}

/**
 * 依 `student_no + 正規化姓名` 比對名單（§2.4）。
 *
 * - 學號比對不分大小寫（與名單匯入去重同一套）；姓名只用 `normalizeName` 的保守正規化，
 *   不替換異體字、不做模糊比對。
 * - 同學號出現在好幾屆的名單上（跨屆）時，全部列出；並列那一列優先挑姓名相符的，
 *   再來是開放註冊屆別，再來是傳進來的順序（呼叫端給新的在前）。
 * - Email 與系級只標「相同／不同／名單沒填」，**不影響** status——名單 Email 只供參考（Q-ACC03）。
 */
export function matchRoster(
  application: Pick<ApplicationFields, 'appliedName' | 'studentNo' | 'departmentClass'> & { loginEmail: string },
  candidates: readonly RosterCandidate[],
  registrationOpenCohortId: string | null,
): RosterMatch {
  const normalized = normalizeName(application.appliedName)
  const hits: RosterHit[] = candidates
    .filter((c) => sameStudentNo(c.studentNo, application.studentNo))
    .map((c) => ({
      rosterVersionId: c.rosterVersionId,
      cohortId: c.cohortId,
      cohortCode: c.cohortCode,
      cohortName: c.cohortName,
      nameRaw: c.nameRaw,
      email: c.email,
      departmentClass: c.departmentClass,
      nameMatches: c.nameNormalized === normalized,
    }))

  if (hits.length === 0) {
    return {
      status: 'not_found',
      hit: null,
      hits: [],
      emailComparison: 'not_applicable',
      departmentClassComparison: 'not_applicable',
    }
  }

  const rank = (h: RosterHit) => (h.nameMatches ? 0 : 2) + (h.cohortId === registrationOpenCohortId ? 0 : 1)
  const hit = [...hits].sort((a, b) => rank(a) - rank(b))[0]!

  const emailComparison: EmailComparison = !hit.email
    ? 'roster_blank'
    : hit.email.trim().toLowerCase() === application.loginEmail.trim().toLowerCase()
      ? 'same'
      : 'different'
  const departmentClassComparison: TextComparison = !hit.departmentClass
    ? 'roster_blank'
    : hit.departmentClass.replace(/\s+/g, '') === application.departmentClass.replace(/\s+/g, '')
      ? 'same'
      : 'different'

  return {
    status: hit.nameMatches ? 'matched' : 'name_mismatch',
    hit,
    hits,
    emailComparison,
    departmentClassComparison,
  }
}

/** 同學號的其他人（比對當下即時算，不存：別人之後才註冊，存下來的就過期了）。 */
export type DuplicateInfo = {
  /** 已核准、正在占用這個學號的帳號（不論哪一屆）。 */
  readonly activeHolders: readonly { readonly name: string; readonly cohortCode: string }[]
  /** 其他還在待審、填了同一個學號的申請數。 */
  readonly otherPending: number
}

/** 待審清單上的一個標籤（§2.4：名單符合／資料不符／重複學號／Email 相同或不同／未命中）。 */
export type EvidenceFlag =
  | 'roster_matched'
  | 'name_mismatch'
  | 'not_found'
  | 'multiple_cohorts'
  | 'duplicate_student_no'
  | 'email_same'
  | 'email_different'
  | 'email_roster_blank'

export const EVIDENCE_LABEL: Record<EvidenceFlag, string> = {
  roster_matched: '名單符合',
  name_mismatch: '資料不符',
  not_found: '未命中',
  multiple_cohorts: '跨屆重複',
  duplicate_student_no: '重複學號',
  email_same: 'Email 相同',
  email_different: 'Email 不同',
  email_roster_blank: '名單未填 Email',
}

/** 標籤要不要用警示色（需要系辦特別看的）。 */
export const EVIDENCE_NEEDS_ATTENTION: Record<EvidenceFlag, boolean> = {
  roster_matched: false,
  name_mismatch: true,
  not_found: true,
  multiple_cohorts: true,
  duplicate_student_no: true,
  email_same: false,
  email_different: true,
  email_roster_blank: false,
}

export function evidenceFlags(match: RosterMatch, duplicates: DuplicateInfo): EvidenceFlag[] {
  const flags: EvidenceFlag[] = []
  if (match.status === 'matched') flags.push('roster_matched')
  if (match.status === 'name_mismatch') flags.push('name_mismatch')
  if (match.status === 'not_found') flags.push('not_found')
  if (new Set(match.hits.map((h) => h.cohortId)).size > 1) flags.push('multiple_cohorts')
  if (duplicates.activeHolders.length > 0 || duplicates.otherPending > 0) flags.push('duplicate_student_no')
  if (match.emailComparison === 'same') flags.push('email_same')
  if (match.emailComparison === 'different') flags.push('email_different')
  if (match.emailComparison === 'roster_blank') flags.push('email_roster_blank')
  return flags
}

// ── 核准與退回 ──────────────────────────────────────────────────────────────

export type VerificationMethod = 'id_document' | 'school_channel' | 'other'

/** 核實方式（2026-09-12 第二輪定案）。班代協助聯絡不能單獨作為依據，所以沒有這個選項。 */
export const VERIFICATION_METHODS: readonly VerificationMethod[] = ['id_document', 'school_channel', 'other']

export const VERIFICATION_LABEL: Record<VerificationMethod, string> = {
  id_document: '當面核對學生證或其他身分證件',
  school_channel: '經校方授權人員透過既有可信管道確認',
  other: '其他核實方式',
}

/** 核實說明哪幾種必填：校方管道要記「由誰、透過什麼管道」；其他方式要說明是什麼方式。 */
export const VERIFICATION_NOTE_REQUIRED: Record<VerificationMethod, boolean> = {
  id_document: false,
  school_channel: true,
  other: true,
}

export const VERIFICATION_NOTE_HINT: Record<VerificationMethod, string> = {
  id_document: '選填，例如「9/24 系辦櫃台核對學生證」',
  school_channel: '必填：由誰、透過什麼管道確認',
  other: '必填：說明用了什麼方式核實',
}

export type ApprovalDecision = {
  readonly verificationMethod: VerificationMethod
  readonly verificationNote: string | null
  readonly reason: string | null
}

function isVerificationMethod(value: string): value is VerificationMethod {
  return (VERIFICATION_METHODS as readonly string[]).includes(value)
}

/** 核准的欄位檢查：核實方式必選、校方管道與其他方式要寫說明、理由選填。 */
export function normalizeApproval(input: {
  verificationMethod: string
  verificationNote: string
  reason: string
}): { ok: true; value: ApprovalDecision } | Err {
  const method = input.verificationMethod.trim()
  if (!isVerificationMethod(method)) {
    return err('VALIDATION_FAILED', '請選擇核實方式。', { details: { field: 'verificationMethod' } })
  }
  const note = input.verificationNote.trim()
  if (VERIFICATION_NOTE_REQUIRED[method] && !note) {
    return err(
      'VALIDATION_FAILED',
      method === 'school_channel' ? '請寫明由誰、透過什麼管道確認。' : '選「其他核實方式」時要說明用了什麼方式。',
      { details: { field: 'verificationNote' } },
    )
  }
  // 說明與理由會進稽核與匯出：除了換行與 tab，控制字元一律不收（票 7 審查建議）。
  if (note.length > REASON_MAX_LENGTH || hasControlChars(note, true)) {
    return err('VALIDATION_FAILED', `核實說明最多 ${REASON_MAX_LENGTH} 個字，而且不能有控制字元。`, {
      details: { field: 'verificationNote' },
    })
  }
  const reason = input.reason.trim()
  if (reason.length > REASON_MAX_LENGTH || hasControlChars(reason, true)) {
    return err('VALIDATION_FAILED', `理由最多 ${REASON_MAX_LENGTH} 個字，而且不能有控制字元。`, {
      details: { field: 'reason' },
    })
  }
  return { ok: true, value: { verificationMethod: method, verificationNote: note || null, reason: reason || null } }
}

/** 退回：理由必填，申請人會在等待審核頁看到。 */
export function normalizeRejection(input: { reason: string }): { ok: true; value: { reason: string } } | Err {
  const reason = input.reason.trim()
  if (!reason) return err('VALIDATION_FAILED', '退回一定要寫理由，申請人會看到這段。', { details: { field: 'reason' } })
  if (reason.length > REASON_MAX_LENGTH || hasControlChars(reason, true)) {
    return err('VALIDATION_FAILED', `理由最多 ${REASON_MAX_LENGTH} 個字。`, { details: { field: 'reason' } })
  }
  return { ok: true, value: { reason } }
}

export type CohortChoice = { readonly id: string; readonly code: string; readonly name: string }

/**
 * 核准時這個人要進哪一屆（§2.4「屆別不由學生填寫」、Q6）。
 *
 * - 名單上只有一屆有這個學號：**用名單的屆別**，不看畫面送來的值。
 * - 好幾屆都有（跨屆）：系辦必須在那幾屆裡選一屆。
 * - 未命中：系辦必須指定；畫面預設帶開放註冊屆別，但伺服器**不代選**——
 *   沒有送來就是沒有指定（模組 02 §4：沒有開放註冊屆別時要提示管理員，不猜）。
 *
 * `cohorts` 是可以指派的屆別（未封存）。
 */
export function resolveApprovalCohort(
  match: RosterMatch,
  requestedCohortId: string | null,
  cohorts: readonly CohortChoice[],
): { ok: true; cohortId: string } | Err {
  const assignable = new Set(cohorts.map((c) => c.id))
  const hitCohorts = [...new Set(match.hits.map((h) => h.cohortId))]

  if (hitCohorts.length === 1) {
    const cohortId = hitCohorts[0]!
    if (!assignable.has(cohortId)) {
      return err('VALIDATION_FAILED', '名單所屬的屆別已封存，不能核准進這一屆。請先處理屆別。', {
        details: { field: 'cohortId' },
      })
    }
    return { ok: true, cohortId }
  }

  if (!requestedCohortId) {
    return err('VALIDATION_FAILED', '請指定這位學生要進哪一屆。', { details: { field: 'cohortId' } })
  }
  if (hitCohorts.length > 1 && !hitCohorts.includes(requestedCohortId)) {
    return err('VALIDATION_FAILED', '這個學號出現在好幾屆的名單上，只能在那幾屆裡選一屆。', {
      details: { field: 'cohortId' },
    })
  }
  if (!assignable.has(requestedCohortId)) {
    return err('VALIDATION_FAILED', '請選一個既有、未封存的屆別。', { details: { field: 'cohortId' } })
  }
  return { ok: true, cohortId: requestedCohortId }
}

/** 畫面上核准對話框的屆別預設值：名單屆別 → 開放註冊屆別 → 不預選。 */
export function suggestedApprovalCohort(match: RosterMatch, registrationOpenCohortId: string | null): string | null {
  if (match.hit) return match.hit.cohortId
  return registrationOpenCohortId
}

// ── 授權 ────────────────────────────────────────────────────────────────────

/** 審核（看待審清單、核准、退回）：只有狀態正常的管理員（契約 03 §1「帳號」列）。 */
export function reviewAccessDenied(actor: ResolvedActor): ErrorCode | null {
  const blocked = statusGate(actor, 'business')
  if (blocked) return blocked
  return hasRole(actor, 'admin') ? null : 'FORBIDDEN'
}

/**
 * 看自己的申請：待審的本人。
 *
 * 已核准（active）的人沒有「待審申請」可看，回 FORBIDDEN 讓頁面導回首頁；
 * 學號與屆別核准後只由系辦更正（§2.4 Q7）。
 */
export function ownApplicationDenied(actor: ResolvedActor, capability: 'registration.viewOwn' | 'registration.reviseOwn'): ErrorCode | null {
  const blocked = statusGate(actor, capability)
  if (blocked) return blocked
  if (actor.kind !== 'authenticated') return 'UNAUTHENTICATED'
  return actor.status === 'pending' ? null : 'FORBIDDEN'
}

// ── port ────────────────────────────────────────────────────────────────────

/** 申請人自己看到的樣子。**沒有比對結果**（見檔頭第 2 條）。 */
export type MyApplication = {
  readonly loginEmail: string
  /** 帳號上的姓名（Google 首次進來時是 Google 給的名字）；還沒送申請時拿來預填。 */
  readonly accountName: string
  /**
   * - `none`：帳號建好了但還沒有申請資料（第二步寫入失敗，或直接打 API 註冊的人）。
   * - `pending`：待審。
   * - `rejected`：最近一次申請被退回，可以修改後重新送出（會是一筆新的申請）。
   */
  readonly state: 'none' | 'pending' | 'rejected'
  readonly current: (ApplicationFields & {
    readonly applicationId: string
    readonly revision: number
    readonly submittedAt: string
    readonly updatedAt: string
  }) | null
  readonly rejection: { readonly reason: string; readonly decidedAt: string } | null
  readonly history: readonly { readonly revision: number; readonly at: string }[]
}

/** 待審清單的一列（系辦看的，含即時比對結果）。 */
export type PendingApplication = ApplicationFields & {
  readonly applicationId: string
  readonly userId: string
  readonly revision: number
  readonly loginEmail: string
  readonly submittedAt: string
  readonly updatedAt: string
  readonly match: RosterMatch
  readonly duplicates: DuplicateInfo
  readonly flags: readonly EvidenceFlag[]
  /** 對話框屆別選單的預設值；`null` 代表沒有可以預設的（未命中且沒有開放註冊屆別）。 */
  readonly suggestedCohortId: string | null
  /** 能不能在對話框裡換屆別（只有一屆命中時由名單決定，不能換）。 */
  readonly cohortLocked: boolean
}

export type PendingList = {
  readonly applications: readonly PendingApplication[]
  readonly cohorts: readonly CohortChoice[]
  readonly registrationOpenCohort: CohortChoice | null
}

export type RegistrationReceipt = { readonly userId: string }

export type RevisionReceipt = { readonly applicationId: string; readonly revision: number }

export type DecisionReceipt = {
  readonly applicationId: string
  readonly decision: 'approved' | 'rejected'
  readonly appliedName: string
  readonly revision: number
  readonly cohortName: string | null
  readonly verificationMethod: VerificationMethod | null
  readonly decidedAt: string
}

/**
 * 被限速擋下。不是 ErrorCode，跟上傳限速同一個形狀。
 * 註冊：契約 03 §6 每 IP 每小時 30 次；待審修改：每人每小時 20 次（`RATE_LIMITS.reviseApplication`）。
 */
export type RateLimited = { readonly ok: false; readonly code: 'RATE_LIMITED'; readonly message: string }

export interface RegistrationCommand {
  /** 未登入的人註冊（密碼）。成功時已經登入（受限 session），畫面導到等待審核頁。 */
  apply(actor: ResolvedActor, input: RegistrationInput, clientIp: string): Promise<Result<RegistrationReceipt> | RateLimited>
  /** 本人看自己的申請。 */
  viewMine(actor: ResolvedActor): Promise<Result<MyApplication>>
  /**
   * 本人修改（或第一次補送、被退回後重送）申請。
   *
   * `expectedRevision` 是畫面上看到的版本；另一個分頁先改過就回 `CONFLICT`，不默默蓋掉。
   * 待審申請不存在時（`none`／`rejected`）建立新的一筆，`expectedRevision` 傳 `null`。
   */
  reviseMine(
    actor: ResolvedActor,
    input: ApplicationFields,
    expectedRevision: number | null,
  ): Promise<Result<RevisionReceipt> | RateLimited>
  /** 系辦看待審清單（比對結果即時算）。 */
  listPending(actor: ResolvedActor): Promise<Result<PendingList>>
  approve(
    actor: ResolvedActor,
    input: {
      applicationId: string
      revision: number
      verificationMethod: string
      verificationNote: string
      reason: string
      cohortId: string | null
      requestId: string
    },
  ): Promise<Result<DecisionReceipt>>
  reject(
    actor: ResolvedActor,
    input: { applicationId: string; revision: number; reason: string; requestId: string },
  ): Promise<Result<DecisionReceipt>>
}
