-- C 階段 C2-21：理由選填（設計方案 X2）與不再問核實方式（X3）需要的資料庫放寬，一支 migration 做完（§10.1）。
--
-- - `business_clock_overrides.reason` 改成可 NULL，拿掉非空 CHECK；拿掉 `cohort_status_events_archive_reason_check`
--   （封存、解封理由改選填）。`user_status_events`、`audit_events` 的 `reason` 本來就可 NULL。
-- - 三個 verification-method CHECK（`registration_applications`、`user_status_events`、`audit_events`）加
--   `office_review`（系辦審核，核准／新增成員／臨時密碼的固定值）與 `email_roster_match`（Email 註冊且與名單相同，自動開通）。
-- - 拿掉 `registration_applications_approved_verification_check`：核准不再必有核實方式（舊資料與批次路徑不被卡）。
--
-- 全是放寬：舊列不受影響，空庫升級與已套 0019 的庫走同一條路。沒有新表，不需要權限區塊。

ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_verification_method_check";--> statement-breakpoint
ALTER TABLE "registration_applications" DROP CONSTRAINT "registration_applications_approved_verification_check";--> statement-breakpoint
ALTER TABLE "registration_applications" DROP CONSTRAINT "registration_applications_verification_method_check";--> statement-breakpoint
ALTER TABLE "user_status_events" DROP CONSTRAINT "user_status_events_verification_method_check";--> statement-breakpoint
ALTER TABLE "business_clock_overrides" DROP CONSTRAINT "business_clock_overrides_reason_check";--> statement-breakpoint
ALTER TABLE "cohort_status_events" DROP CONSTRAINT "cohort_status_events_archive_reason_check";--> statement-breakpoint
ALTER TABLE "business_clock_overrides" ALTER COLUMN "reason" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_verification_method_check" CHECK ("audit_events"."verification_method" is null or "audit_events"."verification_method" in ('id_document','school_channel','other','google_email_match','office_review','email_roster_match'));--> statement-breakpoint
ALTER TABLE "registration_applications" ADD CONSTRAINT "registration_applications_verification_method_check" CHECK ("registration_applications"."verification_method" is null or "registration_applications"."verification_method" in ('id_document','school_channel','other','google_email_match','office_review','email_roster_match'));--> statement-breakpoint
ALTER TABLE "user_status_events" ADD CONSTRAINT "user_status_events_verification_method_check" CHECK ("user_status_events"."verification_method" is null or "user_status_events"."verification_method" in ('id_document','school_channel','other','google_email_match','office_review','email_roster_match'));
