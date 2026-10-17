import 'server-only'
import type { Pool } from 'pg'
import { uuidv7 } from 'uuidv7'
import type { MailMessage } from '@/application/mail'

/**
 * `mail_outbox` 的寫入（設計方案 §3.1）：Brevo 與擷取兩個轉接器共用。
 *
 * 一封信先插一列、寄完改狀態；插入與改狀態各自一個語句，不包交易——寄信打外部，
 * 不能讓資料庫交易等 Brevo。`body_text` 只有擷取模式才給值，正式列一律 NULL。
 */

export type OutboxStatus = 'queued' | 'sent' | 'failed' | 'captured'

export async function insertOutbox(
  db: Pool,
  message: MailMessage,
  row: { status: OutboxStatus; bodyText: string | null; error?: string | null; now: Date },
): Promise<string> {
  const id = uuidv7()
  await db.query(
    `insert into mail_outbox (id, to_email, template, subject, body_text, status, error, created_at, sent_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      message.to,
      message.template,
      message.subject,
      row.bodyText,
      row.status,
      row.error ?? null,
      row.now,
      row.status === 'captured' ? row.now : null,
    ],
  )
  return id
}

export async function markSent(db: Pool, id: string, providerMessageId: string | null, now: Date): Promise<void> {
  await db.query(`update mail_outbox set status = 'sent', provider_message_id = $2, sent_at = $3 where id = $1`, [
    id,
    providerMessageId,
    now,
  ])
}

export async function markFailed(db: Pool, id: string, error: string): Promise<void> {
  await db.query(`update mail_outbox set status = 'failed', error = $2 where id = $1`, [id, error])
}
