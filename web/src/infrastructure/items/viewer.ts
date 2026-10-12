import 'server-only'
import type { Pool } from 'pg'
import { statusGate, type ResolvedActor } from '@/application/accounts'
import { studentCohortOf, type Viewer } from '@/application/items'

/**
 * 「誰在看」→ 可見性判斷用的 `Viewer`（`canViewItem` 的輸入）。附件下載政策與前台內容頁共用。
 *
 * - 沒登入、停用（resolver 已經當成沒登入）、待審、必須改密：一律當**訪客**——
 *   「登入可見」指的是能正常使用平台的本系成員，不是任何拿到 session 的人。
 * - 其他人：角色、學生屆別、目前所在的有效組別；老師另外帶目前指導的有效組別與那些組的屆別
 *   （`advisor_assignments` 的 `valid_to is null` 那一列；第三波 W4，Q13／Q14）。
 *   組別與指導只有需要時才查（`needsGroups`：對象是「指定組別」或「本屆學生」時）。
 */
export async function viewerOf(
  db: Pick<Pool, 'query'>,
  actor: ResolvedActor,
  options: { readonly needsGroups?: boolean } = {},
): Promise<Viewer> {
  if (actor.kind !== 'authenticated' || statusGate(actor, 'business')) return { kind: 'anonymous' }
  const base = { kind: 'user' as const, roles: actor.roles, studentCohortId: studentCohortOf(actor) }
  if (options.needsGroups === false) return { ...base, groupIds: [], advisedGroupIds: [], advisedCohortIds: [] }
  const [groups, advised] = await Promise.all([
    db.query<{ group_id: string }>(
      `select m.group_id from group_memberships m join groups g on g.id = m.group_id
        where m.user_id = $1 and m.valid_to is null and g.status = 'active'`,
      [actor.userId],
    ),
    actor.roles.includes('teacher')
      ? db.query<{ group_id: string; cohort_id: string }>(
          `select a.group_id, g.cohort_id from advisor_assignments a join groups g on g.id = a.group_id
            where a.teacher_user_id = $1 and a.valid_to is null and g.status = 'active'`,
          [actor.userId],
        )
      : Promise.resolve({ rows: [] as { group_id: string; cohort_id: string }[] }),
  ])
  return {
    ...base,
    groupIds: groups.rows.map((r) => r.group_id),
    advisedGroupIds: advised.rows.map((r) => r.group_id),
    advisedCohortIds: [...new Set(advised.rows.map((r) => r.cohort_id))],
  }
}
