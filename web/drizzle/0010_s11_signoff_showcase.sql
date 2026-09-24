CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"version_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"display_name_at" text NOT NULL,
	"student_no_at" text,
	"result" text NOT NULL,
	"reason" text,
	"login_method" text NOT NULL,
	"button_text" text NOT NULL,
	"event_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"real_at" timestamp with time zone NOT NULL,
	"business_at" timestamp with time zone NOT NULL,
	CONSTRAINT "approvals_one_vote" UNIQUE("version_id","user_id"),
	CONSTRAINT "approvals_role_check" CHECK ("approvals"."role" in ('student','advisor')),
	CONSTRAINT "approvals_result_check" CHECK (("approvals"."role" = 'student' and "approvals"."result" in ('agree','disagree'))
          or ("approvals"."role" = 'advisor' and "approvals"."result" in ('agree','return'))),
	CONSTRAINT "approvals_reason_check" CHECK ("approvals"."result" = 'agree' or length(btrim(coalesce("approvals"."reason", ''))) > 0),
	CONSTRAINT "approvals_student_no_check" CHECK ("approvals"."role" = 'student' or "approvals"."student_no_at" is null),
	CONSTRAINT "approvals_login_method_check" CHECK ("approvals"."login_method" in ('google','password')),
	CONSTRAINT "approvals_button_text_check" CHECK (length(btrim("approvals"."button_text")) > 0)
);
--> statement-breakpoint
CREATE TABLE "signoff_exports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"version_id" uuid NOT NULL,
	"format" text NOT NULL,
	"file_id" uuid NOT NULL,
	"exported_by_user_id" uuid NOT NULL,
	"real_at" timestamp with time zone NOT NULL,
	CONSTRAINT "signoff_exports_format_check" CHECK ("signoff_exports"."format" in ('printable','csv'))
);
--> statement-breakpoint
CREATE TABLE "signoff_package_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"package_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"content_text" text NOT NULL,
	"content_checksum" text NOT NULL,
	"attachment_file_versions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"participants" jsonb NOT NULL,
	"supersede_cause" text,
	"authorization_scope" jsonb,
	"created_by_user_id" uuid NOT NULL,
	"created_real_at" timestamp with time zone NOT NULL,
	"created_business_at" timestamp with time zone NOT NULL,
	CONSTRAINT "signoff_package_versions_no_unique" UNIQUE("package_id","version_no"),
	CONSTRAINT "signoff_package_versions_version_no_check" CHECK ("signoff_package_versions"."version_no" >= 1),
	CONSTRAINT "signoff_package_versions_content_check" CHECK (length(btrim("signoff_package_versions"."content_text")) > 0),
	CONSTRAINT "signoff_package_versions_checksum_check" CHECK ("signoff_package_versions"."content_checksum" = encode(sha256(convert_to("signoff_package_versions"."content_text", 'UTF8')), 'hex')),
	CONSTRAINT "signoff_package_versions_attachments_check" CHECK (jsonb_typeof("signoff_package_versions"."attachment_file_versions") = 'array'),
	CONSTRAINT "signoff_package_versions_participants_check" CHECK (jsonb_typeof("signoff_package_versions"."participants") = 'object' and jsonb_typeof("signoff_package_versions"."participants" -> 'students') = 'array'),
	CONSTRAINT "signoff_package_versions_supersede_cause_check" CHECK ("signoff_package_versions"."supersede_cause" in ('member_change','advisor_change','content_change','reset')),
	CONSTRAINT "signoff_package_versions_scope_check" CHECK ("signoff_package_versions"."authorization_scope" is null or jsonb_typeof("signoff_package_versions"."authorization_scope") = 'object')
);
--> statement-breakpoint
CREATE TABLE "signoff_packages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"group_id" uuid NOT NULL,
	"cohort_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"current_version_id" uuid,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" uuid,
	CONSTRAINT "signoff_packages_group_purpose_unique" UNIQUE("group_id","purpose"),
	CONSTRAINT "signoff_packages_purpose_check" CHECK ("signoff_packages"."purpose" in ('final_document','result_confirmation')),
	CONSTRAINT "signoff_packages_revision_check" CHECK ("signoff_packages"."revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE "signoff_version_status" (
	"version_id" uuid PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"cause" text,
	"completed_real_at" timestamp with time zone,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" uuid,
	CONSTRAINT "signoff_version_status_state_check" CHECK ("signoff_version_status"."state" in ('collecting','teacher_pending','complete','revision','superseded','void')),
	CONSTRAINT "signoff_version_status_cause_check" CHECK ("signoff_version_status"."state" not in ('revision','superseded','void') or length(btrim(coalesce("signoff_version_status"."cause", ''))) > 0),
	CONSTRAINT "signoff_version_status_completed_check" CHECK ("signoff_version_status"."state" <> 'complete' or "signoff_version_status"."completed_real_at" is not null),
	CONSTRAINT "signoff_version_status_revision_check" CHECK ("signoff_version_status"."revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE "showcase_drafts" (
	"entry_id" uuid PRIMARY KEY NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"summary_checksum" text NOT NULL,
	"video_url" text,
	"poster_file_id" uuid,
	"poster_checksum" text,
	"authorization_kind" text,
	"authorization_ref" uuid,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" uuid,
	CONSTRAINT "showcase_drafts_title_check" CHECK (length("showcase_drafts"."title") <= 200),
	CONSTRAINT "showcase_drafts_summary_check" CHECK (length("showcase_drafts"."summary") <= 2000),
	CONSTRAINT "showcase_drafts_summary_checksum_check" CHECK ("showcase_drafts"."summary_checksum" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "showcase_drafts_video_url_check" CHECK ("showcase_drafts"."video_url" is null or (length("showcase_drafts"."video_url") <= 500 and "showcase_drafts"."video_url" ~ '^https?://[^[:space:]]+$')),
	CONSTRAINT "showcase_drafts_poster_check" CHECK (("showcase_drafts"."poster_file_id" is null) = ("showcase_drafts"."poster_checksum" is null)),
	CONSTRAINT "showcase_drafts_authorization_check" CHECK (("showcase_drafts"."authorization_kind" is null) = ("showcase_drafts"."authorization_ref" is null)
          and ("showcase_drafts"."authorization_kind" is null or "showcase_drafts"."authorization_kind" in ('signoff','external'))),
	CONSTRAINT "showcase_drafts_revision_check" CHECK ("showcase_drafts"."revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE "showcase_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"cohort_id" uuid NOT NULL,
	"group_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"current_version_id" uuid,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" uuid,
	CONSTRAINT "showcase_entries_status_check" CHECK ("showcase_entries"."status" in ('draft','published','withdrawn')),
	CONSTRAINT "showcase_entries_published_check" CHECK ("showcase_entries"."status" <> 'published' or "showcase_entries"."current_version_id" is not null),
	CONSTRAINT "showcase_entries_revision_check" CHECK ("showcase_entries"."revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE "showcase_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"entry_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"summary_checksum" text NOT NULL,
	"video_url" text,
	"poster_file_id" uuid,
	"poster_checksum" text,
	"authorization_kind" text NOT NULL,
	"authorization_ref" uuid NOT NULL,
	"pii_check" jsonb NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_real_at" timestamp with time zone NOT NULL,
	CONSTRAINT "showcase_versions_no_unique" UNIQUE("entry_id","version_no"),
	CONSTRAINT "showcase_versions_version_no_check" CHECK ("showcase_versions"."version_no" >= 1),
	CONSTRAINT "showcase_versions_authorization_kind_check" CHECK ("showcase_versions"."authorization_kind" in ('signoff','external')),
	CONSTRAINT "showcase_versions_poster_check" CHECK (("showcase_versions"."poster_file_id" is null) = ("showcase_versions"."poster_checksum" is null)),
	CONSTRAINT "showcase_versions_video_url_check" CHECK ("showcase_versions"."video_url" is null or "showcase_versions"."video_url" ~ '^https?://[^[:space:]]+$'),
	CONSTRAINT "showcase_versions_pii_check" CHECK (jsonb_typeof("showcase_versions"."pii_check") = 'object')
);
--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_version_id_signoff_package_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."signoff_package_versions"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_event_id_domain_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."domain_events"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "signoff_exports" ADD CONSTRAINT "signoff_exports_version_id_signoff_package_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."signoff_package_versions"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "signoff_exports" ADD CONSTRAINT "signoff_exports_file_id_stored_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."stored_files"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "signoff_exports" ADD CONSTRAINT "signoff_exports_exported_by_user_id_users_id_fk" FOREIGN KEY ("exported_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "signoff_package_versions" ADD CONSTRAINT "signoff_package_versions_package_id_signoff_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."signoff_packages"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "signoff_package_versions" ADD CONSTRAINT "signoff_package_versions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "signoff_packages" ADD CONSTRAINT "signoff_packages_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "signoff_packages" ADD CONSTRAINT "signoff_packages_cohort_id_cohorts_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "public"."cohorts"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "signoff_packages" ADD CONSTRAINT "signoff_packages_current_version_id_signoff_package_versions_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."signoff_package_versions"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "signoff_packages" ADD CONSTRAINT "signoff_packages_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "signoff_packages" ADD CONSTRAINT "signoff_packages_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "signoff_version_status" ADD CONSTRAINT "signoff_version_status_version_id_signoff_package_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."signoff_package_versions"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "signoff_version_status" ADD CONSTRAINT "signoff_version_status_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "showcase_drafts" ADD CONSTRAINT "showcase_drafts_entry_id_showcase_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."showcase_entries"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "showcase_drafts" ADD CONSTRAINT "showcase_drafts_poster_file_id_stored_files_id_fk" FOREIGN KEY ("poster_file_id") REFERENCES "public"."stored_files"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "showcase_drafts" ADD CONSTRAINT "showcase_drafts_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "showcase_entries" ADD CONSTRAINT "showcase_entries_cohort_id_cohorts_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "public"."cohorts"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "showcase_entries" ADD CONSTRAINT "showcase_entries_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "showcase_entries" ADD CONSTRAINT "showcase_entries_current_version_id_showcase_versions_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."showcase_versions"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "showcase_entries" ADD CONSTRAINT "showcase_entries_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "showcase_entries" ADD CONSTRAINT "showcase_entries_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "showcase_versions" ADD CONSTRAINT "showcase_versions_entry_id_showcase_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."showcase_entries"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "showcase_versions" ADD CONSTRAINT "showcase_versions_poster_file_id_stored_files_id_fk" FOREIGN KEY ("poster_file_id") REFERENCES "public"."stored_files"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "showcase_versions" ADD CONSTRAINT "showcase_versions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE INDEX "signoff_exports_version_idx" ON "signoff_exports" USING btree ("version_id","real_at");--> statement-breakpoint
CREATE INDEX "signoff_packages_cohort_idx" ON "signoff_packages" USING btree ("cohort_id");--> statement-breakpoint
CREATE UNIQUE INDEX "showcase_entries_one_per_group" ON "showcase_entries" USING btree ("cohort_id","group_id") WHERE "showcase_entries"."group_id" is not null;;--> statement-breakpoint

-- 票 25（S11）：精選草稿與簽核建版——模組 07 附錄 A 的簽核五表（簽核包頭列 `signoff_packages`、不可變版本內容
-- `signoff_package_versions`、版本狀態頭列 `signoff_version_status`、每人一票 `approvals`、匯出紀錄 `signoff_exports`）
-- 與模組 09 附錄 A 的精選三表（條目頭列 `showcase_entries`、可變草稿 `showcase_drafts`、發布版本 `showcase_versions`）。
-- 票 26（逐人同意、老師同意、重置、作廢、匯出）在開發計畫標「改資料庫結構：否」，所以 `approvals`、`signoff_exports`
-- 在這一支一起建好；`showcase_versions` 是 `showcase_entries.current_version_id` 的 FK 目標，S11 只建空表（S12 才寫）。
--
-- 只新增表，舊表舊資料一欄都不動，所以空庫升級與現有資料升版走同一條路。0000–0009 的產生區塊不動
-- （已部署的 migration 不能改）。`stored_files.purpose` 早就有 'poster'／'signoff_attachment'，
-- `file_references.ref_type` 早就有 'signoff_version'／'showcase_draft'／'showcase_version'（0002），不用 ALTER。
--
-- 下面的 GRANT 不是手寫的：由 web/src/infrastructure/db/permissions/matrix.json 中 slice 為 S11 的列，
-- 經 `pnpm -C web db:grants --write` 產生，CI 用 `--check` 核對。產生區塊之後是手寫的兩個 trigger：
-- 版本的授權範圍要和用途對得上、版本狀態的終點不能被改。其他狀態轉換交給用例（附錄 A「DB 只擋非法值」）。

-- >>> 由 scripts/generate-grants.mjs 從 permissions/matrix.json 產生；不要手改 >>>
-- 先全部收回，再照矩陣逐項給回去。沒列到的操作就是沒有。
REVOKE ALL ON signoff_packages, signoff_package_versions, signoff_version_status, approvals, signoff_exports, showcase_entries, showcase_drafts, showcase_versions
  FROM fju_app, fju_backup;
--> statement-breakpoint

GRANT SELECT ON signoff_packages, signoff_package_versions, signoff_version_status, approvals, signoff_exports, showcase_entries, showcase_drafts, showcase_versions TO fju_app;
--> statement-breakpoint

GRANT INSERT ON signoff_packages, signoff_package_versions, signoff_version_status, approvals, signoff_exports, showcase_entries, showcase_drafts, showcase_versions TO fju_app;
--> statement-breakpoint

-- 簽核包頭列（一組一用途一個）：只改目前版本與通用欄；組別、屆別、用途寫了就不動，不刪列
GRANT UPDATE (current_version_id, revision, updated_at, updated_by_user_id) ON signoff_packages TO fju_app;
--> statement-breakpoint

-- 簽核版本狀態頭列：只改狀態、原因、完成時間與通用欄（trigger 另擋終點狀態被改與指向被改）
GRANT UPDATE (state, cause, completed_real_at, revision, updated_at, updated_by_user_id) ON signoff_version_status TO fju_app;
--> statement-breakpoint

-- 精選條目頭列：只改狀態、目前版本與通用欄；屆別與組別寫了就不動，不刪列；worker 自動撤稿（S12）
GRANT UPDATE (status, current_version_id, revision, updated_at, updated_by_user_id) ON showcase_entries TO fju_app;
--> statement-breakpoint

-- 精選草稿（一個條目一份）：只改內容與通用欄；條目寫了就不動，不刪列
GRANT UPDATE (title, summary, summary_checksum, video_url, poster_file_id, poster_checksum, authorization_kind, authorization_ref, revision, updated_at, updated_by_user_id) ON showcase_drafts TO fju_app;
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

DROP TRIGGER IF EXISTS signoff_package_versions_immutable_row ON signoff_package_versions;
--> statement-breakpoint

CREATE TRIGGER signoff_package_versions_immutable_row
  BEFORE UPDATE OR DELETE ON signoff_package_versions
  FOR EACH ROW EXECUTE FUNCTION fju_reject_mutation();
--> statement-breakpoint

DROP TRIGGER IF EXISTS signoff_package_versions_immutable_truncate ON signoff_package_versions;
--> statement-breakpoint

CREATE TRIGGER signoff_package_versions_immutable_truncate
  BEFORE TRUNCATE ON signoff_package_versions
  FOR EACH STATEMENT EXECUTE FUNCTION fju_reject_mutation();
--> statement-breakpoint

DROP TRIGGER IF EXISTS approvals_immutable_row ON approvals;
--> statement-breakpoint

CREATE TRIGGER approvals_immutable_row
  BEFORE UPDATE OR DELETE ON approvals
  FOR EACH ROW EXECUTE FUNCTION fju_reject_mutation();
--> statement-breakpoint

DROP TRIGGER IF EXISTS approvals_immutable_truncate ON approvals;
--> statement-breakpoint

CREATE TRIGGER approvals_immutable_truncate
  BEFORE TRUNCATE ON approvals
  FOR EACH STATEMENT EXECUTE FUNCTION fju_reject_mutation();
--> statement-breakpoint

DROP TRIGGER IF EXISTS signoff_exports_immutable_row ON signoff_exports;
--> statement-breakpoint

CREATE TRIGGER signoff_exports_immutable_row
  BEFORE UPDATE OR DELETE ON signoff_exports
  FOR EACH ROW EXECUTE FUNCTION fju_reject_mutation();
--> statement-breakpoint

DROP TRIGGER IF EXISTS signoff_exports_immutable_truncate ON signoff_exports;
--> statement-breakpoint

CREATE TRIGGER signoff_exports_immutable_truncate
  BEFORE TRUNCATE ON signoff_exports
  FOR EACH STATEMENT EXECUTE FUNCTION fju_reject_mutation();
--> statement-breakpoint

DROP TRIGGER IF EXISTS showcase_versions_immutable_row ON showcase_versions;
--> statement-breakpoint

CREATE TRIGGER showcase_versions_immutable_row
  BEFORE UPDATE OR DELETE ON showcase_versions
  FOR EACH ROW EXECUTE FUNCTION fju_reject_mutation();
--> statement-breakpoint

DROP TRIGGER IF EXISTS showcase_versions_immutable_truncate ON showcase_versions;
--> statement-breakpoint

CREATE TRIGGER showcase_versions_immutable_truncate
  BEFORE TRUNCATE ON showcase_versions
  FOR EACH STATEMENT EXECUTE FUNCTION fju_reject_mutation();
-- <<< 產生區塊結束 <<<
--> statement-breakpoint

-- 簽核版本的授權範圍：用途是「最終文件授權」的版本一定要帶從精選草稿凍結的授權範圍，
-- 「期中結果確認」一定不帶（模組 07 §2 RR06、附錄 A `authorization_scope`；S11-04「期中卻選了精選草稿 → 被拒」）。
-- 版本列本身不可變（上面的產生器 trigger），所以只要在 INSERT 時檢查一次。
CREATE OR REPLACE FUNCTION fju_signoff_version_scope_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  package_purpose text;
BEGIN
  SELECT p.purpose INTO package_purpose FROM signoff_packages p WHERE p.id = NEW.package_id;
  IF package_purpose = 'final_document' AND NEW.authorization_scope IS NULL THEN
    RAISE EXCEPTION '最終文件授權的簽核版本一定要帶授權範圍（從精選草稿凍結）'
      USING ERRCODE = 'check_violation';
  END IF;
  IF package_purpose = 'result_confirmation' AND NEW.authorization_scope IS NOT NULL THEN
    RAISE EXCEPTION '期中結果確認的簽核版本不帶授權範圍'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS signoff_package_versions_scope_guard ON signoff_package_versions;
--> statement-breakpoint

CREATE TRIGGER signoff_package_versions_scope_guard
  BEFORE INSERT ON signoff_package_versions
  FOR EACH ROW EXECUTE FUNCTION fju_signoff_version_scope_guard();
--> statement-breakpoint

-- 簽核版本狀態：新建一定是「收集中」；指向的版本寫了就不動；「作廢」是終點，「已失效」只能再作廢
-- （舊同意留歷史不計入新版，失效的版本不會再回來收票——產品「參與者版本與失效」、模組 07 §3）。
-- 收集中 → 待老師 → 完成、退回等其他轉換由用例判（附錄 A「由 domain 驗證，DB 只擋非法值」）。不能刪。
CREATE OR REPLACE FUNCTION fju_signoff_version_status_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'collecting' THEN
      RAISE EXCEPTION '簽核版本的狀態新建時只能是 collecting，收到 %', NEW.state
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.version_id IS DISTINCT FROM OLD.version_id THEN
    RAISE EXCEPTION '簽核版本狀態指向的版本不能改'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.state = 'void' AND (NEW.state IS DISTINCT FROM OLD.state OR NEW.cause IS DISTINCT FROM OLD.cause) THEN
    RAISE EXCEPTION '已作廢的簽核版本不能再改'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.state = 'superseded' AND NEW.state NOT IN ('superseded', 'void') THEN
    RAISE EXCEPTION '已失效的簽核版本不能回到 %；請建立新版本重新簽核', NEW.state
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS signoff_version_status_guard ON signoff_version_status;
--> statement-breakpoint

CREATE TRIGGER signoff_version_status_guard
  BEFORE INSERT OR UPDATE ON signoff_version_status
  FOR EACH ROW EXECUTE FUNCTION fju_signoff_version_status_guard();
--> statement-breakpoint

DROP TRIGGER IF EXISTS signoff_version_status_no_delete ON signoff_version_status;
--> statement-breakpoint

CREATE TRIGGER signoff_version_status_no_delete
  BEFORE DELETE ON signoff_version_status
  FOR EACH ROW EXECUTE FUNCTION fju_reject_mutation();
--> statement-breakpoint

DROP TRIGGER IF EXISTS signoff_version_status_no_truncate ON signoff_version_status;
--> statement-breakpoint

CREATE TRIGGER signoff_version_status_no_truncate
  BEFORE TRUNCATE ON signoff_version_status
  FOR EACH STATEMENT EXECUTE FUNCTION fju_reject_mutation();
