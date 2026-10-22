CREATE TABLE "grading_stage_settings" (
	"cohort_id" uuid NOT NULL,
	"stage_key" text NOT NULL,
	"item_id" uuid,
	"description" text,
	"panel_key" text,
	"updated_by_user_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grading_stage_settings_pk" PRIMARY KEY("cohort_id","stage_key"),
	CONSTRAINT "grading_stage_settings_stage_key_check" CHECK (length("grading_stage_settings"."stage_key") between 1 and 40),
	CONSTRAINT "grading_stage_settings_description_check" CHECK ("grading_stage_settings"."description" is null or char_length("grading_stage_settings"."description") between 1 and 500),
	CONSTRAINT "grading_stage_settings_panel_key_check" CHECK ("grading_stage_settings"."panel_key" is null or char_length("grading_stage_settings"."panel_key") between 1 and 40),
	CONSTRAINT "grading_stage_settings_not_empty_check" CHECK ("grading_stage_settings"."item_id" is not null or "grading_stage_settings"."description" is not null or "grading_stage_settings"."panel_key" is not null)
);
--> statement-breakpoint
ALTER TABLE "signoff_packages" DROP CONSTRAINT "signoff_packages_group_purpose_unique";--> statement-breakpoint
ALTER TABLE "managed_items" DROP CONSTRAINT "managed_items_receiver_audience_check";--> statement-breakpoint
ALTER TABLE "managed_items" DROP CONSTRAINT "managed_items_receiver_schedule_check";--> statement-breakpoint
ALTER TABLE "response_rosters" DROP CONSTRAINT "response_rosters_exempt_reason_check";--> statement-breakpoint
ALTER TABLE "submission_reopens" DROP CONSTRAINT "submission_reopens_reason_check";--> statement-breakpoint
ALTER TABLE "evaluator_assignments" DROP CONSTRAINT "evaluator_assignments_ended_check";--> statement-breakpoint
ALTER TABLE "grade_overrides" DROP CONSTRAINT "grade_overrides_reason_check";--> statement-breakpoint
ALTER TABLE "grade_settlements" DROP CONSTRAINT "grade_settlements_reason_check";--> statement-breakpoint
ALTER TABLE "grade_settlements" DROP CONSTRAINT "grade_settlements_released_check";--> statement-breakpoint
ALTER TABLE "approvals" DROP CONSTRAINT "approvals_reason_check";--> statement-breakpoint
ALTER TABLE "mail_outbox" DROP CONSTRAINT "mail_outbox_template_check";--> statement-breakpoint
ALTER TABLE "submission_reopens" ALTER COLUMN "reason" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "grade_overrides" ALTER COLUMN "reason" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "grade_settlements" ALTER COLUMN "reason" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "managed_items" ADD COLUMN "consent_mode" text;--> statement-breakpoint
ALTER TABLE "managed_items" ADD COLUMN "consent_purpose" text;--> statement-breakpoint
ALTER TABLE "signoff_packages" ADD COLUMN "item_id" uuid;--> statement-breakpoint
ALTER TABLE "grading_stage_settings" ADD CONSTRAINT "grading_stage_settings_cohort_id_cohorts_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "public"."cohorts"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "grading_stage_settings" ADD CONSTRAINT "grading_stage_settings_item_id_managed_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."managed_items"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "grading_stage_settings" ADD CONSTRAINT "grading_stage_settings_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "signoff_packages" ADD CONSTRAINT "signoff_packages_item_id_managed_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."managed_items"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE UNIQUE INDEX "signoff_packages_group_item_unique" ON "signoff_packages" USING btree ("group_id","item_id") WHERE "signoff_packages"."item_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "signoff_packages_legacy_group_purpose_unique" ON "signoff_packages" USING btree ("group_id","purpose") WHERE "signoff_packages"."item_id" is null;--> statement-breakpoint
CREATE INDEX "signoff_packages_item_idx" ON "signoff_packages" USING btree ("item_id");--> statement-breakpoint
ALTER TABLE "managed_items" ADD CONSTRAINT "managed_items_teacher_receiver_check" CHECK ("managed_items"."audience_kind" <> 'teachers' or "managed_items"."receiver_unit" in ('none','individual'));--> statement-breakpoint
ALTER TABLE "managed_items" ADD CONSTRAINT "managed_items_consent_mode_check" CHECK ("managed_items"."consent_mode" is null or "managed_items"."consent_mode" in ('form','upload'));--> statement-breakpoint
ALTER TABLE "managed_items" ADD CONSTRAINT "managed_items_consent_unit_check" CHECK ("managed_items"."consent_mode" is null or ("managed_items"."consent_mode" = 'upload' and "managed_items"."receiver_unit" = 'individual')
          or ("managed_items"."consent_mode" = 'form' and "managed_items"."receiver_unit" = 'group'));--> statement-breakpoint
ALTER TABLE "managed_items" ADD CONSTRAINT "managed_items_consent_purpose_value_check" CHECK ("managed_items"."consent_purpose" is null or "managed_items"."consent_purpose" in ('result_confirmation','final_document'));--> statement-breakpoint
ALTER TABLE "managed_items" ADD CONSTRAINT "managed_items_consent_purpose_check" CHECK (("managed_items"."consent_mode" is not distinct from 'form') = ("managed_items"."consent_purpose" is not null));--> statement-breakpoint
ALTER TABLE "managed_items" ADD CONSTRAINT "managed_items_receiver_audience_check" CHECK ("managed_items"."receiver_unit" = 'none' or "managed_items"."audience_kind" in ('cohort_students','groups','teachers'));--> statement-breakpoint
ALTER TABLE "managed_items" ADD CONSTRAINT "managed_items_receiver_schedule_check" CHECK ("managed_items"."status" = 'draft' or "managed_items"."receiver_unit" = 'none' or "managed_items"."consent_mode" is not distinct from 'form' or "managed_items"."due_at" is not null);--> statement-breakpoint
ALTER TABLE "response_rosters" ADD CONSTRAINT "response_rosters_exempt_reason_check" CHECK ("response_rosters"."exempt_reason" is null or length(btrim("response_rosters"."exempt_reason")) > 0);--> statement-breakpoint
ALTER TABLE "submission_reopens" ADD CONSTRAINT "submission_reopens_reason_check" CHECK ("submission_reopens"."reason" is null or char_length("submission_reopens"."reason") between 1 and 200);--> statement-breakpoint
ALTER TABLE "evaluator_assignments" ADD CONSTRAINT "evaluator_assignments_ended_check" CHECK (("evaluator_assignments"."valid_to" is null) = ("evaluator_assignments"."ended_real_at" is null)
          and ("evaluator_assignments"."removal_choice" is null or "evaluator_assignments"."valid_to" is not null));--> statement-breakpoint
ALTER TABLE "grade_overrides" ADD CONSTRAINT "grade_overrides_reason_check" CHECK ("grade_overrides"."reason" is null or length(btrim("grade_overrides"."reason")) > 0);--> statement-breakpoint
ALTER TABLE "grade_settlements" ADD CONSTRAINT "grade_settlements_reason_check" CHECK ("grade_settlements"."reason" is null or char_length("grade_settlements"."reason") between 1 and 500);--> statement-breakpoint
ALTER TABLE "grade_settlements" ADD CONSTRAINT "grade_settlements_released_check" CHECK (("grade_settlements"."released_at" is null) = ("grade_settlements"."released_by_user_id" is null) and ("grade_settlements"."release_reason" is null or "grade_settlements"."released_at" is not null));--> statement-breakpoint
ALTER TABLE "mail_outbox" ADD CONSTRAINT "mail_outbox_template_check" CHECK ("mail_outbox"."template" in ('email_otp','password_reset','registration_result','reminder'));--> statement-breakpoint

-- C 階段 C1-01（規格①設計方案 §1）：作業、同意書、評分需要的資料庫改動，一支 migration 做完。
--
-- - `managed_items`：收件離開草稿只要截止、不再要階段（`stage_id` 保留、不回填）；站內同意表單截止選填。
--   收件對象加老師（老師作業一律個人收件）；新欄 `consent_mode`（form＝站內同意表單、整組收件／upload＝上傳簽名檔、個人收件）
--   與 `consent_purpose`（只有 form 有、而且一定要有）。
-- - `signoff_packages.item_id`：同意書連到作業。唯一鍵 `(group_id, purpose)` 拆成兩條部分唯一：
--   連作業的包一組一份作業一包、沒連作業的舊包維持一組一用途一包。不回填、不動資料。
-- - 新表 `grading_stage_settings`：評分項目的對應作業、說明、評審組（`panel_key`）；不影響分數，所以不放進不可變的方案版本。
-- - 理由選填（X2）：拿掉 `approvals_reason_check`；免繳、補交、更正、結算／解除結算、結束指派的理由都改選填，
--   有填才驗長度（CHECK 同名 drop＋add）。退回評分的理由維持必填。
-- - `mail_outbox` 模板加 `reminder`（催繳信）。
--
-- 全是新增與放寬：空庫升級與已套 0020 的庫走同一條路。0000–0020 一字不動。
-- 新表的權限在下面的產生區塊（切片 C1），由 `pnpm -C web db:grants --write` 產生，CI 用 `--check` 核對。

-- >>> 由 scripts/generate-grants.mjs 從 permissions/matrix.json 產生；不要手改 >>>
-- 先全部收回，再照矩陣逐項給回去。沒列到的操作就是沒有。
REVOKE ALL ON grading_stage_settings
  FROM fju_app, fju_backup;
--> statement-breakpoint

GRANT SELECT ON grading_stage_settings TO fju_app;
--> statement-breakpoint

GRANT INSERT ON grading_stage_settings TO fju_app;
--> statement-breakpoint

-- 評分項目側表（C 階段 C1-01）：對應作業、說明、評審組，改了不建版不重算；屆別與項目 key 寫了就不動，三欄都清空＝刪列
GRANT UPDATE (item_id, description, panel_key, updated_by_user_id, updated_at) ON grading_stage_settings TO fju_app;
--> statement-breakpoint

GRANT DELETE ON grading_stage_settings TO fju_app;
--> statement-breakpoint

-- 備份角色讀全庫；唯一能寫的 backup_runs 在 S12 才建（matrix.json 的 backupWrites 記著）。
GRANT pg_read_all_data TO fju_backup;
-- <<< 產生區塊結束 <<<
