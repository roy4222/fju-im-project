import 'server-only'
import type { Pool, PoolClient } from 'pg'
import type { ResolvedActor } from '@/application/accounts'

type Queryable = Pick<Pool, 'query'> | PoolClient

/**
 * 誰讀得到簽核版本——**版本頁、版本引用的附件、版本凍結的精選海報、通知匣的簽核通知共用這一個判斷**
 * （契約 03 §1「簽核：當前版本參與者、管理員；附件版本同讀」）。每次都重查此刻的事實，不快取。
 *
 * 讀得到的人（任一個版本符合即可）：
 * - 管理員（由 `canReadSignoffVersions` 先放行；SQL 片段本身不看角色）。
 * - 那一版快照裡的學生——含之後被移出的人：那是他參與過、讀過的版本（維持票 25 的決定）。
 * - 這一組**此刻**的有效組員（`group_memberships.valid_to IS NULL`）：新加入的人要讀得到失效原因與全文。
 * - 這一組**此刻**的主指導（`advisor_assignments.valid_to IS NULL`）。
 *
 * 老師只有最後一條：快照裡的主指導如果已經被換掉，**什麼都看不到**——版本頁、附件、海報一律拒絕
 * （產品 07 §8「換老師後舊老師失權」；2026-09-25 Roy 定：失權含看不到）。快照主指導仍在任時靠的也是同一條，
 * 所以這裡不另看快照裡的 advisor。
 */

/**
 * 上面規則（不含管理員）的 SQL 布林式，給要在同一句查詢裡判斷的地方用（例如通知匣逐列重驗）。
 * `versionMatch` 是篩出版本的條件（別名 `v`），`userId` 是本人 ID 的 SQL 式（例如 `$2`）。
 * 兩個參數都直接拼進 SQL：只能傳程式裡寫死的字面或參數佔位符，**絕不能**來自使用者輸入（值一律走參數綁定）。
 */
export function signoffVersionReadableSql(versionMatch: string, userId: string): string {
  return `exists (
    select 1
      from signoff_package_versions v
      join signoff_packages p on p.id = v.package_id
     where ${versionMatch}
       and (exists (select 1 from jsonb_array_elements(coalesce(v.participants -> 'students', '[]'::jsonb)) s
                     where s ->> 'userId' = (${userId})::text)
            or exists (select 1 from group_memberships m
                        where m.group_id = p.group_id and m.user_id = (${userId})::uuid and m.valid_to is null)
            or exists (select 1 from advisor_assignments a
                        where a.group_id = p.group_id and a.teacher_user_id = (${userId})::uuid and a.valid_to is null)))`
}

export async function canReadSignoffVersions(
  db: Queryable,
  actor: Extract<ResolvedActor, { kind: 'authenticated' }>,
  versionIds: readonly string[],
): Promise<boolean> {
  if (versionIds.length === 0) return false
  if (actor.roles.includes('admin')) return true
  const found = await db.query<{ readable: boolean }>(
    `select ${signoffVersionReadableSql('v.id = any($1::uuid[])', '$2')} as readable`,
    [versionIds, actor.userId],
  )
  return found.rows[0]?.readable === true
}
