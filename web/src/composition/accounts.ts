import 'server-only'
import type { ActorResolver, ResolvedActor } from '@/application/accounts'
import { DbActorResolver } from '@/infrastructure/auth/actor-resolver'

/**
 * 模組 01 的實例組裝（母 spec §4.3：執行期的實作一律由 composition 注入）。
 */
let actorResolver: ActorResolver | undefined

export function getActorResolver(): ActorResolver {
  actorResolver ??= new DbActorResolver()
  return actorResolver
}

/**
 * 給 app 層用的薄門面。
 *
 * app（頁面）對 application 只能帶型別（母 spec §4.3），執行期一律經這裡；
 * 這幾個函式刻意不碰 Next 的 API（不做 redirect、不讀 headers），
 * 那是頁面自己的事，這裡只回答「是誰」與「這個狀態能不能做」。
 */
export function resolveActor(headers: Headers): Promise<ResolvedActor> {
  return getActorResolver().resolve(headers)
}

export { hasRole as actorHasRole, statusGate as checkStatus } from '@/application/accounts'
