import 'server-only'
import type { Pool } from 'pg'
import type { RevocationTargetStatus } from '@/application/accounts'

/**
 * Better Auth 的第二層狀態（`users.banned` 與 session）怎麼讀、怎麼寫（模組 01 附錄 A 規則 3、5）。
 *
 * **讀**（`readBanned`）：`fju_app` 對 `users` 套件欄的唯讀 SELECT——沒有 session、沒有 request、
 * 不經 `auth.api.*`（契約 03 §2 v2.2 D1）。
 *
 * **寫**是這張票要決定的待決事項（契約 03 §2「2026-09-15 安裝後補充」）：admin plugin 的
 * `banUser`／`unbanUser` 要求呼叫端帶一個 admin 角色的 session，背景工作沒有任何 session。
 * 選項是「服務帳號的 session」或「不經 admin plugin 的等價寫入」；這裡用**後者**：
 * 照 better-auth 1.7.5 `plugins/admin/routes.mjs` 的實作逐欄做同樣的事——
 * - ban：`banned=true`、`ban_reason`、`ban_expires=null`、`updated_at`，再刪掉這個人的全部 session；
 * - unban：`banned=false`、`ban_reason=null`、`ban_expires=null`、`updated_at`。
 * - revoke_all（去識別化）：刪全部 session 再 ban。
 * 本專案沒有開 secondary storage 與 cookie 快取（`auth-instance.ts`），session 只在 `sessions` 表，
 * 刪列就等於撤銷。這樣不必為 worker 造一個長期有效的管理員 session，也不必放寬 `/admin/*`。
 * 升級 better-auth 時要重新核對上述實作（附錄 A 規則 5 的「安裝後 gate」）。
 */
export interface BanStateGateway {
  apply(userId: string, target: RevocationTargetStatus): Promise<void>
}

export class SqlBanStateGateway implements BanStateGateway {
  readonly #pool: () => Pick<Pool, 'connect'>

  constructor(pool: () => Pick<Pool, 'connect'>) {
    this.#pool = pool
  }

  async apply(userId: string, target: RevocationTargetStatus): Promise<void> {
    const client = await this.#pool().connect()
    try {
      await client.query('begin')
      if (target === 'active') {
        await client.query(
          `update users set banned = false, ban_reason = null, ban_expires = null, updated_at = now() where id = $1`,
          [userId],
        )
      } else {
        const reason = target === 'disabled' ? '帳號已停用' : '帳號已去識別化'
        await client.query(
          `update users set banned = true, ban_reason = $2, ban_expires = null, updated_at = now() where id = $1`,
          [userId, reason],
        )
        await client.query('delete from sessions where user_id = $1', [userId])
      }
      await client.query('commit')
    } catch (error) {
      await client.query('rollback').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }
}

/** Better Auth 目前認定這個人被 ban 了沒（`banned` 是 null 當成 false）。 */
export async function readBanned(db: Pick<Pool, 'query'>, userId: string): Promise<boolean> {
  const rows = await db.query<{ banned: boolean | null }>('select banned from users where id = $1', [userId])
  return rows.rows[0]?.banned === true
}
