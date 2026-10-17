import type { ResolvedActor } from '@/application/accounts'

/** GA4 唯一的使用者屬性（Q36：只傳角色，不傳 `user_id`、姓名、學號、Email）。 */
export type GaRole = 'guest' | 'student' | 'teacher' | 'admin' | 'pending'

/** 兼任多個角色時取權限最高的那一個；已登入但還沒有角色（待審核）是 `pending`。 */
export function gaRole(actor: ResolvedActor): GaRole {
  if (actor.kind !== 'authenticated') return 'guest'
  if (actor.status === 'pending') return 'pending'
  if (actor.roles.includes('admin')) return 'admin'
  if (actor.roles.includes('teacher')) return 'teacher'
  if (actor.roles.includes('student')) return 'student'
  return 'pending'
}
