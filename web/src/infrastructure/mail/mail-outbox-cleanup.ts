import 'server-only'
import type { Pool } from 'pg'

/**
 * 寄信紀錄（`mail_outbox`）超過 90 天的清理（B 階段 VB-13；設計方案 §7.4）。
 *
 * 這張表不是稽核（稽核在 `audit_events`），刪掉不違反不可變原則。
 * 寄送中（`queued`）且還沒滿 1 小時的列不刪；其餘狀態一律照建立時間刪。
 * 一次最多刪 `batch` 列，刪不完就接著下一批，直到沒有可刪的為止。
 */

export const MAIL_OUTBOX_KEEP_DAYS = 90
export const MAIL_OUTBOX_BATCH = 500
const QUEUED_GRACE_MS = 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

export async function purgeMailOutbox(
  db: Pick<Pool, 'query'>,
  now: Date,
  options: { keepDays?: number; batch?: number } = {},
): Promise<number> {
  const cutoff = new Date(now.getTime() - (options.keepDays ?? MAIL_OUTBOX_KEEP_DAYS) * DAY_MS)
  const queuedCutoff = new Date(now.getTime() - QUEUED_GRACE_MS)
  const batch = options.batch ?? MAIL_OUTBOX_BATCH
  let total = 0
  for (;;) {
    const result = await db.query(
      `delete from mail_outbox
        where id in (
          select id from mail_outbox
           where created_at < $1
             and not (status = 'queued' and created_at >= $2)
           order by created_at
           limit $3
        )`,
      [cutoff, queuedCutoff, batch],
    )
    const deleted = result.rowCount ?? 0
    total += deleted
    if (deleted < batch) return total
  }
}
