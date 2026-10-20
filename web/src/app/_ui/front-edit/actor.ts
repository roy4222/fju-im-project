import 'server-only'
import { currentActor } from '@/app/_ui/guard'
import { actorHasRole, checkStatus } from '@/composition/accounts'

/** 前台編輯入口共用守門：每次 action 重新解析 session，僅放行可執行業務的系辦。 */
export async function frontEditActor() {
  const actor = await currentActor()
  if (actor.kind !== 'authenticated' || !actorHasRole(actor, 'admin') || checkStatus(actor, 'business') !== null) return null
  return actor
}
