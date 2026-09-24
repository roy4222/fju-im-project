CREATE TABLE "advisor_visibility_settings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"item_id" uuid NOT NULL,
	"enabled" boolean NOT NULL,
	"effective_from_version_no" integer NOT NULL,
	"set_by_user_id" uuid NOT NULL,
	"set_at" timestamp with time zone NOT NULL,
	CONSTRAINT "advisor_visibility_settings_effective_check" CHECK ("advisor_visibility_settings"."effective_from_version_no" >= 1)
);
--> statement-breakpoint
CREATE TABLE "submission_files" (
	"submission_version_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"field_key" text NOT NULL,
	"checksum" text NOT NULL,
	CONSTRAINT "submission_files_pk" PRIMARY KEY("submission_version_id","file_id"),
	CONSTRAINT "submission_files_field_unique" UNIQUE("submission_version_id","field_key"),
	CONSTRAINT "submission_files_checksum_check" CHECK ("submission_files"."checksum" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "advisor_visibility_settings" ADD CONSTRAINT "advisor_visibility_settings_item_id_managed_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."managed_items"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "advisor_visibility_settings" ADD CONSTRAINT "advisor_visibility_settings_set_by_user_id_users_id_fk" FOREIGN KEY ("set_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "submission_files" ADD CONSTRAINT "submission_files_submission_version_id_submission_versions_id_fk" FOREIGN KEY ("submission_version_id") REFERENCES "public"."submission_versions"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "submission_files" ADD CONSTRAINT "submission_files_file_id_stored_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."stored_files"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE INDEX "advisor_visibility_settings_item_idx" ON "advisor_visibility_settings" USING btree ("item_id","set_at");--> statement-breakpoint
CREATE INDEX "submission_files_file_idx" ON "submission_files" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "stored_files_uploading_gc_idx" ON "stored_files" USING btree ("uploaded_real_at") WHERE "stored_files"."status" = 'uploading';--> statement-breakpoint
CREATE INDEX "stored_files_soft_deleted_gc_idx" ON "stored_files" USING btree ("soft_deleted_at") WHERE "stored_files"."status" = 'soft_deleted';
--> statement-breakpoint

-- 票 21（S07）：組別共用草稿、上傳與正式送出——模組 05 附錄 A 的繳交附件（`submission_files`）與
-- 主指導閱覽設定（`advisor_visibility_settings`）兩張不可變表，以及模組 10 的檔案回收索引
-- （`stored_files` 兩條部分索引：超過 24 小時的 `uploading` 殘留、7 天後永久刪除的軟刪除檔）。
--
-- 只新增表與索引，舊表舊資料一欄都不動（契約 01 §12：「S07 只加 GC 相關索引」），
-- 所以空庫升級與現有資料升版走同一條路。0000–0007 的產生區塊不動（已部署的 migration 不能改）。
--
-- 下面的 GRANT 不是手寫的：由 web/src/infrastructure/db/permissions/matrix.json 中 slice 為 S07 的列，
-- 經 `pnpm -C web db:grants --write` 產生，CI 用 `--check` 核對。

-- >>> 由 scripts/generate-grants.mjs 從 permissions/matrix.json 產生；不要手改 >>>
-- 先全部收回，再照矩陣逐項給回去。沒列到的操作就是沒有。
REVOKE ALL ON submission_files, advisor_visibility_settings
  FROM fju_app, fju_backup;
--> statement-breakpoint

GRANT SELECT ON submission_files, advisor_visibility_settings TO fju_app;
--> statement-breakpoint

GRANT INSERT ON submission_files, advisor_visibility_settings TO fju_app;
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

DROP TRIGGER IF EXISTS submission_files_immutable_row ON submission_files;
--> statement-breakpoint

CREATE TRIGGER submission_files_immutable_row
  BEFORE UPDATE OR DELETE ON submission_files
  FOR EACH ROW EXECUTE FUNCTION fju_reject_mutation();
--> statement-breakpoint

DROP TRIGGER IF EXISTS submission_files_immutable_truncate ON submission_files;
--> statement-breakpoint

CREATE TRIGGER submission_files_immutable_truncate
  BEFORE TRUNCATE ON submission_files
  FOR EACH STATEMENT EXECUTE FUNCTION fju_reject_mutation();
--> statement-breakpoint

DROP TRIGGER IF EXISTS advisor_visibility_settings_immutable_row ON advisor_visibility_settings;
--> statement-breakpoint

CREATE TRIGGER advisor_visibility_settings_immutable_row
  BEFORE UPDATE OR DELETE ON advisor_visibility_settings
  FOR EACH ROW EXECUTE FUNCTION fju_reject_mutation();
--> statement-breakpoint

DROP TRIGGER IF EXISTS advisor_visibility_settings_immutable_truncate ON advisor_visibility_settings;
--> statement-breakpoint

CREATE TRIGGER advisor_visibility_settings_immutable_truncate
  BEFORE TRUNCATE ON advisor_visibility_settings
  FOR EACH STATEMENT EXECUTE FUNCTION fju_reject_mutation();
-- <<< 產生區塊結束 <<<
