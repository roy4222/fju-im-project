import type { AccountStatus, Role } from '@/application/accounts/actor'
import { hasControlChars, REASON_MAX_LENGTH } from '@/application/accounts/registration'
import { err, type Err } from '@/shared/result'

/**
 * 管理員角色授予／移除與孤兒帳號補建的規則（產品模組 01 §2.5「編輯……角色與帳號狀態」；
 * 工程模組 01 §5 `AccountCommand.grantRole`／`revokeRole`；票 10b）。
 *
 * 這個檔是純邏輯：欄位怎麼驗、誰可以被設為管理員、什麼叫孤兒帳號。寫入、鎖與交易在
 * infrastructure（`account-command.ts`）。
 *
 * **兩個「角色」要一起動**：業務授權一律看 `role_assignments`（`ActorResolver` 每次請求重讀）；
 * Better Auth admin plugin 另外看它自己的 `users.role`——系辦用到的套件管理員能力（停用撤 session、
 * 發臨時密碼、新增老師）都要呼叫端的 `users.role='admin'`，否則套件回 401、用例記「結果未知」。
 * 所以授予與移除在**同一個交易**裡寫這兩邊，永遠不會只改一邊（票 8、票 9 審查建議）。
 */

// ── 管理員角色 ──────────────────────────────────────────────────────────────

/** 這一票只開放授予／移除「管理員」；老師與學生角色各有自己的流程（新增老師、註冊核准）。 */
export type GrantableRole = Extract<Role, 'admin'>

export type RoleChangeInput = {
  readonly userId: string
  readonly role: string
  readonly reason: string
  readonly requestId: string
}

export type RoleChange = { readonly role: GrantableRole; readonly reason: string }

function reasonOf(value: unknown): { ok: true; value: string } | Err {
  const reason = typeof value === 'string' ? value.trim() : ''
  if (!reason) return err('VALIDATION_FAILED', '請寫理由，會留在稽核紀錄裡。', { details: { field: 'reason' } })
  if (reason.length > REASON_MAX_LENGTH || hasControlChars(reason, true)) {
    return err('VALIDATION_FAILED', `理由最多 ${REASON_MAX_LENGTH} 個字。`, { details: { field: 'reason' } })
  }
  return { ok: true, value: reason }
}

/** 授予或移除管理員：角色只能是 admin、理由必填。 */
export function normalizeRoleChange(input: { role: unknown; reason: unknown }): { ok: true; value: RoleChange } | Err {
  if (input.role !== 'admin') return err('VALIDATION_FAILED', '只能設定或取消管理員角色。', { details: { field: 'role' } })
  const reason = reasonOf(input.reason)
  if (!reason.ok) return reason
  return { ok: true, value: { role: 'admin', reason: reason.value } }
}

/** 授予／移除時鎖到的那個帳號的樣子。 */
export type RoleTarget = {
  readonly status: AccountStatus
  readonly roles: readonly Role[]
}

/**
 * 能不能把這個帳號設為管理員（模組 01 §2.5；票 10b「把某位老師或職員設為管理員」）。
 *
 * - 只有狀態正常（active、沒有去識別化）的帳號：待審的人還沒被核實，停用的人登不進來。
 * - 學生不能是管理員：學生帳號綁著學號與屆別，系辦的人不會是用學生帳號上班的人。
 *   「職員」＝沒有學生角色的正常帳號（例如只有管理員角色的系辦助理）。
 * - 已經是管理員就不用再授予（畫面重新整理就會看到）。
 */
export function adminGrantProblem(target: RoleTarget): Err | null {
  if (target.status !== 'active') {
    return err('CONFLICT', '只有已開通、沒有停用的帳號可以設為管理員；請重新整理頁面。')
  }
  if (target.roles.includes('admin')) return err('CONFLICT', '這個帳號已經是管理員了，請重新整理頁面。')
  if (target.roles.includes('student')) {
    return err('VALIDATION_FAILED', '學生帳號不能設為管理員；請用老師或職員的帳號。')
  }
  return null
}

/**
 * 移除之後還剩幾位**有效**管理員。
 *
 * 有效＝有效的 admin 角色列、帳號 active、沒有去識別化。已停用的管理員登不進來，不算數。
 */
export function remainingEffectiveAdmins(
  admins: readonly { readonly userId: string; readonly effective: boolean }[],
  removingUserId: string,
): number {
  return admins.filter((a) => a.effective && a.userId !== removingUserId).length
}

// ── 孤兒帳號 ────────────────────────────────────────────────────────────────

/**
 * 孤兒帳號（票 10b）：Better Auth 的 `users` 有這一列，但我方**什麼都沒有**——
 * 沒有有效角色、沒有任何一筆註冊申請、沒有個人資料（`user_profiles`），而且沒有停用或去識別化。
 *
 * 怎麼來的：套件建帳號（`createUser`／`signUpEmail`）與我方的交易是兩條連線，
 * 套件那一步成功、我方交易失敗就會留下它（`account-command.ts`、`registration-command.ts` 檔頭）。
 *
 * **這個條件也會抓到「註冊了、還沒送出申請」的人**（直接打註冊 API、或第一次用 Google 登入後
 * 還沒補學號的人）：從資料庫上分不出兩者，所以列表只是讓系辦看得到，由系辦看登入 Email 判斷。
 * 那種人自己登入後在等待審核頁補送申請，就不再是孤兒。
 */
export type OrphanFacts = {
  readonly status: AccountStatus
  readonly activeRoles: number
  readonly applications: number
  readonly hasProfile: boolean
}

export function isOrphan(facts: OrphanFacts): boolean {
  return (
    (facts.status === 'pending' || facts.status === 'active') &&
    facts.activeRoles === 0 &&
    facts.applications === 0 &&
    !facts.hasProfile
  )
}

/** 孤兒帳號補建成哪一種角色：老師（之後登入先補資料），或職員（管理員角色）。 */
export type OrphanRole = Extract<Role, 'teacher' | 'admin'>

export const ORPHAN_ROLES: readonly OrphanRole[] = ['teacher', 'admin']

export type OrphanRepairInput = {
  readonly userId: string
  readonly role: string
  readonly reason: string
  readonly requestId: string
}

export function normalizeOrphanRepair(input: { role: unknown; reason: unknown }): { ok: true; value: { role: OrphanRole; reason: string } } | Err {
  if (input.role !== 'teacher' && input.role !== 'admin') {
    return err('VALIDATION_FAILED', '請選擇要補建的角色。', { details: { field: 'role' } })
  }
  const reason = reasonOf(input.reason)
  if (!reason.ok) return reason
  return { ok: true, value: { role: input.role, reason: reason.value } }
}

// ── 回執 ────────────────────────────────────────────────────────────────────

export type RoleChangeReceipt = {
  readonly userId: string
  readonly name: string
  readonly role: GrantableRole
  /** `true`＝授予、`false`＝移除。 */
  readonly granted: boolean
  readonly changedAt: string
}

export type OrphanRepairReceipt = {
  readonly userId: string
  readonly name: string
  readonly role: OrphanRole
  /** 原本是待審就一併開通（pending → active）。 */
  readonly activated: boolean
  readonly changedAt: string
}
