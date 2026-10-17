import 'server-only'
import type { Pool, PoolClient } from 'pg'
import type { AuditWriter } from '@/application/ops'
import { isResumableSignup } from '@/infrastructure/auth/signup-resume'
import { PgAuditWriter } from '@/infrastructure/ops/audit-writer'

/**
 * 半成品帳號 7 天軟性處理（B 階段 VB-14；設計方案 §7.5、R9）。
 *
 * 「半成品」＝ VB-2 的可續辦謂詞（`isResumableSignup`）成立，而且建立滿 7 天、credential 密碼還在。
 * 處理方式是**清密碼、刪 session、記一筆 system 稽核**；`users`／`accounts` 列一律保留（兩表沒有 DELETE 權限），
 * Email 仍被占用，同一個 Email 再來註冊時照 VB-2 續辦（續辦本來就會換新的密碼雜湊）。
 *
 * 每個候選帳號一筆交易（▶R2-3）：鎖 users 列 → 交易內重驗謂詞 → 清密碼 → 直接刪 sessions → 寫稽核 → commit。
 * 不走 `SessionRevocationExecutor`（它的工作要帶 `statusEventId`，而且會把 pending 判成 active 去 unban），
 * 不寫 `user_status_events`／`session_revocations`。
 *
 * 鎖序：一筆交易只鎖一個 users 列，不碰 cohorts／groups 等，跟既有 `cohort → groups → grading_schemes` 不會成環。
 * 跟續辦完成（`finishSignupResume`：advisory lock → users 列）搶同一列時排隊：續辦先 commit 的話，
 * 這邊鎖到之後重驗已不是半成品（`email_verified = true`）就跳過；這邊先 commit 的話，續辦接著把密碼換成新的。
 * 第二輪因為密碼已是 null 不會再選到，可以放心重跑。
 */

export const STALE_SIGNUP_DAYS = 7
export const STALE_SIGNUP_BATCH = 200
const DAY_MS = 24 * 60 * 60 * 1000

export type StaleSignupCleanupOptions = {
  audit?: AuditWriter<PoolClient>
  /** 稽核的業務時間；沒給就用 `now`。 */
  businessAt?: Date
  batch?: number
}

/** 跑一輪，回傳這一輪處理掉的帳號數。 */
export async function scrubStaleSignups(db: Pool, now: Date, options: StaleSignupCleanupOptions = {}): Promise<number> {
  const audit = options.audit ?? new PgAuditWriter()
  const cutoff = new Date(now.getTime() - STALE_SIGNUP_DAYS * DAY_MS)
  const candidates = await db.query<{ id: string }>(
    `select u.id from users u
      where u.status = 'pending'
        and u.email_verified = false
        and u.created_at < $1
        and exists (select 1 from accounts a
                     where a.user_id = u.id and a.provider_id = 'credential' and a.password is not null)
      order by u.id
      limit $2`,
    [cutoff, options.batch ?? STALE_SIGNUP_BATCH],
  )

  let scrubbed = 0
  for (const { id } of candidates.rows) {
    if (await scrubOne(db, id, cutoff, now, options.businessAt ?? now, audit)) scrubbed += 1
  }
  return scrubbed
}

async function scrubOne(
  db: Pool,
  userId: string,
  cutoff: Date,
  now: Date,
  businessAt: Date,
  audit: AuditWriter<PoolClient>,
): Promise<boolean> {
  const tx = await db.connect()
  try {
    await tx.query('begin')
    const locked = await tx.query<{ created_at: Date }>('select created_at from users where id = $1 for update', [
      userId,
    ])
    const createdAt = locked.rows[0]?.created_at
    // 等鎖的期間可能已經續辦完成、送了申請、或被系辦處理：鎖到之後在交易裡重驗一次。
    if (!createdAt || new Date(createdAt).getTime() >= cutoff.getTime() || !(await isResumableSignup(tx, userId))) {
      await tx.query('rollback')
      return false
    }
    const updated = await tx.query(
      `update accounts set password = null, updated_at = $2
        where user_id = $1 and provider_id = 'credential' and password is not null`,
      [userId, now],
    )
    if (updated.rowCount !== 1) {
      await tx.query('rollback')
      return false
    }
    const sessions = await tx.query('delete from sessions where user_id = $1', [userId])
    await audit.append(tx, {
      actorKind: 'system',
      action: 'account.stale_signup_scrubbed',
      targetType: 'user',
      targetId: userId,
      scope: 'global',
      realAt: now,
      businessAt,
      payload: {
        daysSinceCreated: Math.floor((now.getTime() - new Date(createdAt).getTime()) / DAY_MS),
        sessionsDeleted: sessions.rowCount ?? 0,
      },
    })
    await tx.query('commit')
    return true
  } catch (error) {
    await tx.query('rollback').catch(() => undefined)
    throw error
  } finally {
    tx.release()
  }
}
