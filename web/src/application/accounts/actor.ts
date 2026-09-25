import type { ErrorCode } from '@/shared/errors'

/**
 * 「現在是誰在操作」與「這個狀態能不能做這件事」（模組 01 §5、契約 03 §2、母 spec §4.12）。
 *
 * 這個檔是**純邏輯**：沒有資料庫、沒有 Better Auth、沒有 Next。
 * 怎麼把 session 變成 `Actor` 是 infrastructure 的事（`infrastructure/auth/actor-resolver.ts`）；
 * 這裡只回答「拿到這個 Actor 之後，某件事該不該放行」，所以規則可以單獨測、也只有一份。
 */

export type Role = 'student' | 'teacher' | 'admin'

/** 帳號狀態（契約 01 §4.1 `users.status`；`deidentified` 由去識別化用例寫）。 */
export type AccountStatus = 'pending' | 'active' | 'disabled' | 'deidentified'

export type CohortMembership = {
  readonly cohortId: string
  readonly role: Role
}

export type Actor = {
  readonly userId: string
  readonly roles: readonly Role[]
  readonly status: AccountStatus
  readonly mustChangePassword: boolean
  readonly cohortMemberships: readonly CohortMembership[]
  /**
   * 本人的顯示姓名（個人資料列的姓名；還沒有個人資料列就是帳號名稱）。只給外殼的頭像與問候用，
   * **不拿來做任何授權判斷**。選填：測試裡手工組的 Actor 可以不給，畫面退回顯示角色字。
   */
  readonly displayName?: string
  /**
   * 這次 session 實際使用的登入方式（契約 01 §4.1 `sessions.login_method`；契約 02 §2 `OperationContext.loginMethod`）。
   * 由 actor resolver 從**同一個 session** 讀出來，不從帳號綁定推論、也不收呼叫端傳入的值（票 26：同意紀錄要記這一欄）。
   * 測試自己組的 actor 可以不帶；需要它的用例（簽核表態）沒有就拒絕。
   */
  readonly loginMethod?: 'google' | 'password'
}

/** 沒有有效 session 時的結果。刻意是明確的值，不是 `null`，呼叫端就漏不掉。 */
export type AnonymousActor = { readonly kind: 'anonymous' }

export type ResolvedActor = ({ readonly kind: 'authenticated' } & Actor) | AnonymousActor

export const ANONYMOUS: AnonymousActor = { kind: 'anonymous' }

/**
 * 用例的能力分類。
 *
 * 只分到「狀態閘門看得懂」的粒度——誰能做什麼（角色、關係、屆別）是各模組 policy 的事，
 * 這裡只管「帳號狀態本身有沒有把人擋在門外」。
 */
export type Capability =
  /** 讀自己的 session、登出：任何有 session 的人都可以。 */
  | 'self.session'
  /** 改密碼：pending 與 must-change 都可以（那是他們唯一能做的事）。 */
  | 'self.changePassword'
  /** 看自己的註冊申請與退回理由。 */
  | 'registration.viewOwn'
  /** 修改自己的註冊申請並重新比對。 */
  | 'registration.reviseOwn'
  /** 連結另一種登入方式：只有 active 且 fresh session。 */
  | 'self.linkAccount'
  /** 其他所有業務用例。 */
  | 'business'

/** pending 帳號唯一能做的幾件事（ARCHITECTURE §4.12）。 */
const PENDING_ALLOWED: ReadonlySet<Capability> = new Set([
  'self.session',
  'self.changePassword',
  'registration.viewOwn',
  'registration.reviseOwn',
])

/** 被要求改密碼時唯一能做的幾件事。 */
const MUST_CHANGE_ALLOWED: ReadonlySet<Capability> = new Set(['self.session', 'self.changePassword'])

/**
 * 這個 actor 現在能不能做這件事。
 *
 * 回 `null` 代表狀態閘門放行（**不代表有權限**——角色與關係由各模組 policy 再判）；
 * 回錯誤碼代表被狀態擋下，呼叫端直接回那個碼。
 */
export function statusGate(actor: ResolvedActor, capability: Capability): ErrorCode | null {
  if (actor.kind === 'anonymous') return 'UNAUTHENTICATED'

  // 停用與去識別化一律「當作未登入」（契約 03 §2）：不回 ACCOUNT_DISABLED，
  // 免得變成一個可以拿來探測「這個帳號存在而且被停用」的側通道。
  if (actor.status === 'disabled' || actor.status === 'deidentified') return 'UNAUTHENTICATED'

  // must-change 先於 pending 判定：A1 第一次登入就是 active＋must-change，
  // 而待審的人被系辦發臨時密碼時也可能同時是 pending＋must-change。
  if (actor.mustChangePassword) {
    return MUST_CHANGE_ALLOWED.has(capability) ? null : 'PASSWORD_CHANGE_REQUIRED'
  }

  if (actor.status === 'pending') {
    return PENDING_ALLOWED.has(capability) ? null : 'ACCOUNT_PENDING'
  }

  return null
}

/** `statusGate` 的布林版本，寫條件式時比較順。 */
export function canPerform(actor: ResolvedActor, capability: Capability): boolean {
  return statusGate(actor, capability) === null
}

/** 這個 actor 有沒有某個角色。 */
export function hasRole(actor: ResolvedActor, role: Role): boolean {
  return actor.kind === 'authenticated' && actor.roles.includes(role)
}
