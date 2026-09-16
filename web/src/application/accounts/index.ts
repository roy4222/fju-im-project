/**
 * 模組 01 帳號與權限的公開入口（母 spec §4.3）。
 *
 * 跨模組只能從這裡引用，而且只能帶型別；執行期的實作由 composition 注入。
 */
export type {
  AccountStatus,
  Actor,
  AnonymousActor,
  Capability,
  CohortMembership,
  ResolvedActor,
  Role,
} from '@/application/accounts/actor'
export { ANONYMOUS, canPerform, hasRole, statusGate } from '@/application/accounts/actor'
export type { ActorResolver } from '@/application/accounts/ports'
export type {
  ChangePasswordInput,
  ChangePasswordOutcome,
  SelfAccountCommand,
} from '@/application/accounts/self-account'
