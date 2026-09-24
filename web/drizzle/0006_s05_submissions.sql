CREATE TABLE "submission_drafts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"item_id" uuid NOT NULL,
	"receiver_kind" text NOT NULL,
	"receiver_id" uuid NOT NULL,
	"schema_version_id" uuid NOT NULL,
	"answers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"legacy_answers" jsonb,
	"file_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"migration_state" text DEFAULT 'none' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_kind" text NOT NULL,
	"created_by_user_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" uuid,
	CONSTRAINT "submission_drafts_receiver_unique" UNIQUE("item_id","receiver_kind","receiver_id"),
	CONSTRAINT "submission_drafts_receiver_kind_check" CHECK ("submission_drafts"."receiver_kind" in ('user','group')),
	CONSTRAINT "submission_drafts_answers_check" CHECK (jsonb_typeof("submission_drafts"."answers") = 'object'),
	CONSTRAINT "submission_drafts_migration_state_check" CHECK ("submission_drafts"."migration_state" in ('none','auto','needs_review')),
	CONSTRAINT "submission_drafts_revision_check" CHECK ("submission_drafts"."revision" >= 1),
	CONSTRAINT "submission_drafts_created_by_kind_check" CHECK ("submission_drafts"."created_by_kind" in ('user','system','worker')),
	CONSTRAINT "submission_drafts_created_by_actor_check" CHECK (("submission_drafts"."created_by_kind" = 'user') = ("submission_drafts"."created_by_user_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "submission_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"item_id" uuid NOT NULL,
	"receiver_kind" text NOT NULL,
	"receiver_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"schema_version_id" uuid NOT NULL,
	"answers" jsonb NOT NULL,
	"submitted_by_user_id" uuid NOT NULL,
	"received_real_at" timestamp with time zone NOT NULL,
	"received_business_at" timestamp with time zone NOT NULL,
	"request_id" uuid NOT NULL,
	"membership_snapshot" jsonb,
	"advisor_snapshot" jsonb,
	"deadline_version_at_submit" integer NOT NULL,
	CONSTRAINT "submission_versions_receiver_version_unique" UNIQUE("item_id","receiver_kind","receiver_id","version_no"),
	CONSTRAINT "submission_versions_request_unique" UNIQUE("submitted_by_user_id","request_id"),
	CONSTRAINT "submission_versions_receiver_kind_check" CHECK ("submission_versions"."receiver_kind" in ('user','group')),
	CONSTRAINT "submission_versions_version_no_check" CHECK ("submission_versions"."version_no" >= 1),
	CONSTRAINT "submission_versions_answers_check" CHECK (jsonb_typeof("submission_versions"."answers") = 'object'),
	CONSTRAINT "submission_versions_membership_check" CHECK (("submission_versions"."receiver_kind" = 'group') = ("submission_versions"."membership_snapshot" is not null)),
	CONSTRAINT "submission_versions_deadline_version_check" CHECK ("submission_versions"."deadline_version_at_submit" >= 1)
);
--> statement-breakpoint
ALTER TABLE "submission_drafts" ADD CONSTRAINT "submission_drafts_item_id_managed_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."managed_items"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "submission_drafts" ADD CONSTRAINT "submission_drafts_schema_version_id_form_schema_versions_id_fk" FOREIGN KEY ("schema_version_id") REFERENCES "public"."form_schema_versions"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "submission_drafts" ADD CONSTRAINT "submission_drafts_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "submission_drafts" ADD CONSTRAINT "submission_drafts_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "submission_versions" ADD CONSTRAINT "submission_versions_item_id_managed_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."managed_items"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "submission_versions" ADD CONSTRAINT "submission_versions_schema_version_id_form_schema_versions_id_fk" FOREIGN KEY ("schema_version_id") REFERENCES "public"."form_schema_versions"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "submission_versions" ADD CONSTRAINT "submission_versions_submitted_by_user_id_users_id_fk" FOREIGN KEY ("submitted_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE INDEX "submission_versions_item_idx" ON "submission_versions" USING btree ("item_id");
--> statement-breakpoint

-- 票 17（S05）：個人填報與送出——模組 05 附錄 A 的草稿（`submission_drafts`，附錄 A 叫 `drafts`）
-- 與正式版本（`submission_versions`，不可變）兩張表。
--
-- 只新增表，舊表舊資料不動，所以空庫升級與現有資料升版走同一條路。0000–0005 的產生區塊不動
-- （已部署的 migration 不能改）。
--
-- 下面的 GRANT 不是手寫的：由 web/src/infrastructure/db/permissions/matrix.json 中 slice 為 S05 的列，
-- 經 `pnpm -C web db:grants --write` 產生，CI 用 `--check` 核對。

-- >>> 由 scripts/generate-grants.mjs 從 permissions/matrix.json 產生；不要手改 >>>
-- 先全部收回，再照矩陣逐項給回去。沒列到的操作就是沒有。
REVOKE ALL ON submission_drafts, submission_versions
  FROM fju_app, fju_backup;
--> statement-breakpoint

GRANT SELECT ON submission_drafts, submission_versions TO fju_app;
--> statement-breakpoint

GRANT INSERT ON submission_drafts, submission_versions TO fju_app;
--> statement-breakpoint

-- 收件者的草稿（附錄 A drafts）：只改內容與通用欄；項目與收件者寫了就不動，不刪列
GRANT UPDATE (schema_version_id, answers, legacy_answers, file_ids, migration_state, revision, updated_at, updated_by_user_id) ON submission_drafts TO fju_app;
--> statement-breakpoint

-- 備份角色讀全庫；唯一能寫的 backup_runs 在 S12 才建（matrix.json 的 backupWrites 記著）。
GRANT pg_read_all_data TO fju_backup;
--> statement-breakpoint

-- 不可變表的第二層保護：除了不給 UPDATE／DELETE，trigger 也一律拒絕。
CREATE OR REPLACE FUNCTION fju_reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% 是不可變表，不接受 %（契約 01 §5）', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END $$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS submission_versions_immutable_row ON submission_versions;
--> statement-breakpoint

CREATE TRIGGER submission_versions_immutable_row
  BEFORE UPDATE OR DELETE ON submission_versions
  FOR EACH ROW EXECUTE FUNCTION fju_reject_mutation();
--> statement-breakpoint

DROP TRIGGER IF EXISTS submission_versions_immutable_truncate ON submission_versions;
--> statement-breakpoint

CREATE TRIGGER submission_versions_immutable_truncate
  BEFORE TRUNCATE ON submission_versions
  FOR EACH STATEMENT EXECUTE FUNCTION fju_reject_mutation();
-- <<< 產生區塊結束 <<<
