CREATE TABLE "mail_outbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"to_email" text NOT NULL,
	"template" text NOT NULL,
	"subject" text NOT NULL,
	"body_text" text,
	"status" text NOT NULL,
	"provider_message_id" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "mail_outbox_template_check" CHECK ("mail_outbox"."template" in ('email_otp','password_reset','registration_result')),
	CONSTRAINT "mail_outbox_status_check" CHECK ("mail_outbox"."status" in ('queued','sent','failed','captured'))
);
--> statement-breakpoint
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_verification_method_check";--> statement-breakpoint
ALTER TABLE "registration_applications" DROP CONSTRAINT "registration_applications_verification_method_check";--> statement-breakpoint
ALTER TABLE "user_status_events" DROP CONSTRAINT "user_status_events_verification_method_check";--> statement-breakpoint
CREATE INDEX "mail_outbox_created_at_idx" ON "mail_outbox" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_verification_method_check" CHECK ("audit_events"."verification_method" is null or "audit_events"."verification_method" in ('id_document','school_channel','other','google_email_match'));--> statement-breakpoint
ALTER TABLE "registration_applications" ADD CONSTRAINT "registration_applications_verification_method_check" CHECK ("registration_applications"."verification_method" is null or "registration_applications"."verification_method" in ('id_document','school_channel','other','google_email_match'));--> statement-breakpoint
ALTER TABLE "user_status_events" ADD CONSTRAINT "user_status_events_verification_method_check" CHECK ("user_status_events"."verification_method" is null or "user_status_events"."verification_method" in ('id_document','school_channel','other','google_email_match'));--> statement-breakpoint

-- B 階段 VB-1：寄信底層與 Q42 自動開通的核實方式，一支 migration 加齊（之後的 VB-6 不再出 migration）。
--
-- - `mail_outbox`：三種信（Email 驗證碼、重設密碼、審核結果）每封先寫一列。正式寄出的列 `body_text` 為 NULL，
--   `subject`／`error` 不含驗證碼與 token；只有擷取模式（`MAIL_CAPTURE=1`，限本機與 CI）存全文。
--   app 與 worker 可讀、寫、改狀態，也可刪：保存 90 天後由 worker 清（R5，VB-13）；不是稽核表，刪了不違反不可變原則。
-- - 三個 verification-method CHECK（`registration_applications`、`user_status_events`、`audit_events`）加
--   `google_email_match`（Q42：Google 驗證過的 Email 與名單登記 Email 完全相同才自動核准）。只放寬，舊列不受影響。
--
-- 全是新增與放寬：空庫升級與已套 0014 的庫走同一條路。0000–0014 一字不動。
-- 新表的權限在下面的產生區塊，由 `pnpm -C web db:grants --write` 產生，CI 用 `--check` 核對。

-- >>> 由 scripts/generate-grants.mjs 從 permissions/matrix.json 產生；不要手改 >>>
-- 先全部收回，再照矩陣逐項給回去。沒列到的操作就是沒有。
REVOKE ALL ON mail_outbox
  FROM fju_app, fju_backup;
--> statement-breakpoint

GRANT SELECT ON mail_outbox TO fju_app;
--> statement-breakpoint

GRANT INSERT ON mail_outbox TO fju_app;
--> statement-breakpoint

GRANT UPDATE ON mail_outbox TO fju_app;
--> statement-breakpoint

GRANT DELETE ON mail_outbox TO fju_app;
--> statement-breakpoint

-- 備份角色讀全庫；唯一能寫的 backup_runs 在 S12 才建（matrix.json 的 backupWrites 記著）。
GRANT pg_read_all_data TO fju_backup;
-- <<< 產生區塊結束 <<<
