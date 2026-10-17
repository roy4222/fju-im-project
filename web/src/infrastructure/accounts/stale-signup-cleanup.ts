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
 *
 * 跟 Better Auth 的兩個公開入口（Review 第 1 輪 P1）也靠同一把 users 列鎖排隊——套件的 hook 跟 adapter 寫入不在同一筆
 * 交易，所以那兩條路各自在 hook 裡開自己的交易鎖同一列重驗（`signup-resume.ts` 的 `confirmEmailVerifiedUnderLock`、
 * `revokeSessionUnlessPasswordCurrent`）：
 * - 公開驗碼（`/email-otp/verify-email`）：hook 鎖到之後帳號還有登入方式才自己寫 `email_verified = true`；這邊先清掉密碼
 *   的話它看到沒密碼就拒絕（回「請回第 1 步」，帳號仍可續辦）；它先寫的話這邊重驗看到已驗證就跳過。
 * - 密碼登入（`/sign-in/email`）：session 列插完之後 hook 鎖到、用這次的明文重驗目前雜湊；這邊先清掉的話它看到 null 就刪掉
 *   剛插的那列、回 401（cookie 從未發出）；它先 commit 的話這邊接著把全部 session 刪掉。
 * 兩條路都只鎖 users 列（不取 advisory lock、不鎖 verifications），跟續辦的 `advisory(email) → users → verifications` 同向。
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
  const batch = options.batch ?? STALE_SIGNUP_BATCH
  const businessAt = options.businessAt ?? now
  let scrubbed = 0
  // 粗篩只看 users／accounts 欄位，完整謂詞在每個帳號的交易裡判斷；不合格的（有角色、有申請…）會一直留在
  // 粗篩結果裡，所以用 keyset（`id > lastId`）往後掃到沒有候選為止，不然前一整批不合格就永遠輪不到後面的。
  let lastId: string | null = null
  for (;;) {
    const { rows }: { rows: { id: string }[] } = await db.query<{ id: string }>(
      `select u.id from users u
        where u.status = 'pending'
          and u.email_verified = false
          and u.created_at < $1
          and ($3::uuid is null or u.id > $3::uuid)
          and exists (select 1 from accounts a
                       where a.user_id = u.id and a.provider_id = 'credential' and a.password is not null)
        order by u.id
        limit $2`,
      [cutoff, batch, lastId],
    )
    for (const { id } of rows) {
      if (await scrubOne(db, id, cutoff, now, businessAt, audit)) scrubbed += 1
    }
    if (rows.length < batch) break
    lastId = rows[rows.length - 1]!.id
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
