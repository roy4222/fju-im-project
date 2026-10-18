import 'server-only'
import { sql } from 'drizzle-orm'
import { check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

/**
 * 寄信紀錄（0015，B 階段 VB-1；設計方案 §3.1）：每一封信先寫一列，再交給 Brevo 或擷取模式。
 *
 * 正式寄出的列 `body_text` 一律 NULL；`subject` 只存主旨原文（主旨本來就不含驗證碼與重設 token）；
 * `error` 只記 `brevo_<HTTP 狀態>_<code>`、`timeout` 或 `not_configured`，不存回應全文、金鑰與內文。
 * 只有明確開啟擷取模式（`MAIL_CAPTURE=1`，限本機與 CI）時 `status = 'captured'`、`body_text` 存全文。
 *
 * 不可變原則不適用：這不是稽核（稽核在 `audit_events`），保存 90 天後由 worker 刪（R5，VB-13）。
 */

const tz = { withTimezone: true } as const

export const mailOutbox = pgTable(
  'mail_outbox',
  {
    id: uuid('id').primaryKey(),
    toEmail: text('to_email').notNull(),
    template: text('template').notNull(),
    subject: text('subject').notNull(),
    bodyText: text('body_text'),
    status: text('status').notNull(),
    providerMessageId: text('provider_message_id'),
    error: text('error'),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    sentAt: timestamp('sent_at', tz),
  },
  (t) => [
    check('mail_outbox_template_check', sql`${t.template} in ('email_otp','password_reset','registration_result','reminder')`),
    check('mail_outbox_status_check', sql`${t.status} in ('queued','sent','failed','captured')`),
    index('mail_outbox_created_at_idx').on(t.createdAt.desc()),
  ],
)
