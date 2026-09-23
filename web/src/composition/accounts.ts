import 'server-only'
import type { ActorResolver } from '@/application/accounts'
import { DbActorResolver } from '@/infrastructure/auth/actor-resolver'

/**
 * 模組 01 的實例組裝（母 spec §4.3：執行期的實作一律由 composition 注入）。
 */
let actorResolver: ActorResolver | undefined

export function getActorResolver(): ActorResolver {
  actorResolver ??= new DbActorResolver()
  return actorResolver
}
