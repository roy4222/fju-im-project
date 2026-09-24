import 'server-only'
import type { PoolClient } from 'pg'

/**
 * 「系統至少留一位有效管理員」的鎖（票 10b）。
 *
 * 會讓管理員變少的動作——取消管理員（`account-command.ts`）、停用帳號（`account-directory-command.ts`）——
 * 以及補建管理員，都在交易一開頭先經過 `lockAdmins`，**再**鎖目標帳號。固定這個順序，兩條路互相也不會死結。
 *
 * 為什麼要鎖整組：兩位管理員同時互相取消（或互相停用）時，各自只看目標的話兩邊都會成功，系統就一位
 * 管理員都不剩。先鎖同一組列，後到的那一個會等前一個 commit，醒來時重讀（READ COMMITTED 的
 * `for update` 會重新評估條件），就看得到自己已經不是有效管理員，然後被擋下。
 * 管理員就幾個人，鎖整組的成本可以忽略。
 */

export type LockedAdmin = { readonly userId: string; readonly effective: boolean }

/**
 * 鎖住**全部**有效的管理員角色列（依 id 排序），順便算出每一位是不是有效管理員
 * （帳號 active、沒有去識別化；停用的管理員登不進來，不算）。
 */
export async function lockAdmins(tx: PoolClient): Promise<LockedAdmin[]> {
  const locked = await tx.query<{ user_id: string }>(
    `select user_id from role_assignments
      where role = 'admin' and revoked_real_at is null
      order by id
      for update`,
  )
  const ids = locked.rows.map((r) => r.user_id)
  if (ids.length === 0) return []
  // **鎖到手之後才讀狀態，而且要另一個 statement**：READ COMMITTED 每個 statement 一個新快照。
  // 同一個 statement 裡 join 出來的 `users` 欄位是等鎖之前的舊快照——只有被鎖的列自己被改過才會重讀
  // （EvalPlanQual），而停用只改 `users`、不改 `role_assignments`，等鎖的那一方會拿到停用前的狀態，
  // 兩位管理員互相停用就會兩邊都成功（票 10b 審查時抓到）。
  const fresh = await tx.query<{ id: string; effective: boolean }>(
    `select id, (status = 'active' and deidentified_at is null) as effective from users where id = any($1::uuid[])`,
    [ids],
  )
  const effective = new Map(fresh.rows.map((r) => [r.id, r.effective]))
  return ids.map((userId) => ({ userId, effective: effective.get(userId) ?? false }))
}

/** 這個人在鎖住的管理員列裡、而且帳號此刻仍是 active（不是只信請求開始時解析出來的 actor）。 */
export function isEffectiveAdmin(admins: readonly LockedAdmin[], userId: string): boolean {
  return admins.some((a) => a.userId === userId && a.effective)
}
