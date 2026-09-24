import 'server-only'
import type { Pool } from 'pg'
import { statusGate, type ResolvedActor } from '@/application/accounts'
import { studentCohortOf, type Viewer } from '@/application/items'

/**
 * 「誰在看」→ 可見性判斷用的 `Viewer`（`canViewItem` 的輸入）。附件下載政策與前台內容頁共用。
 *
 * - 沒登入、停用（resolver 已經當成沒登入）、待審、必須改密：一律當**訪客**——
 *   「登入可見」指的是能正常使用平台的本系成員，不是任何拿到 session 的人。
 * - 其他人：角色、學生屆別、目前所在的有效組別（只有需要時才查組別，`needsGroups`）。
 */
export async function viewerOf(
  db: Pick<Pool, 'query'>,
  actor: ResolvedActor,
  options: { readonly needsGroups?: boolean } = {},
): Promise<Viewer> {
  if (actor.kind !== 'authenticated' || statusGate(actor, 'business')) return { kind: 'anonymous' }
  const groupIds =
    options.needsGroups === false
      ? []
      : (
          await db.query<{ group_id: string }>(
            `select m.group_id from group_memberships m join groups g on g.id = m.group_id
              where m.user_id = $1 and m.valid_to is null and g.status = 'active'`,
            [actor.userId],
          )
        ).rows.map((r) => r.group_id)
  return { kind: 'user', roles: actor.roles, studentCohortId: studentCohortOf(actor), groupIds }
}
