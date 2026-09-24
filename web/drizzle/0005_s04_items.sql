CREATE TABLE "form_schema_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"item_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"schema" jsonb NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "form_schema_versions_item_version_unique" UNIQUE("item_id","version_no"),
	CONSTRAINT "form_schema_versions_version_no_check" CHECK ("form_schema_versions"."version_no" >= 1),
	CONSTRAINT "form_schema_versions_schema_check" CHECK (coalesce(jsonb_typeof("form_schema_versions"."schema" -> 'fields'), 'missing') = 'array')
);
--> statement-breakpoint
CREATE TABLE "item_attachments" (
	"item_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"sort" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "item_attachments_pk" PRIMARY KEY("item_id","file_id")
);
--> statement-breakpoint
CREATE TABLE "item_audience_groups" (
	"item_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "item_audience_groups_pk" PRIMARY KEY("item_id","group_id")
);
--> statement-breakpoint
CREATE TABLE "item_publications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"item_id" uuid NOT NULL,
	"action" text NOT NULL,
	"content_version_id" uuid,
	"schema_version_id" uuid,
	"deadline_version" integer,
	"notify" boolean NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"real_at" timestamp with time zone NOT NULL,
	"business_at" timestamp with time zone NOT NULL,
	CONSTRAINT "item_publications_action_check" CHECK ("item_publications"."action" in ('publish','withdraw','archive','republish','deadline_change','schema_change',
          'content_change','settings_change'))
);
--> statement-breakpoint
CREATE TABLE "item_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"item_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"body_html" text NOT NULL,
	"cover_file_id" uuid,
	"category" text,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "item_versions_item_version_unique" UNIQUE("item_id","version_no"),
	CONSTRAINT "item_versions_version_no_check" CHECK ("item_versions"."version_no" >= 1)
);
--> statement-breakpoint
CREATE TABLE "managed_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"cohort_id" uuid NOT NULL,
	"placement" text NOT NULL,
	"audience_kind" text NOT NULL,
	"receiver_unit" text DEFAULT 'none' NOT NULL,
	"stage_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"opens_at" timestamp with time zone,
	"actual_opened_at" timestamp with time zone,
	"due_at" timestamp with time zone,
	"deadline_version" integer DEFAULT 1 NOT NULL,
	"current_content_version_id" uuid,
	"current_schema_version_id" uuid,
	"title" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"body_html" text DEFAULT '' NOT NULL,
	"cover_file_id" uuid,
	"category" text,
	"draft_schema" jsonb DEFAULT '{"fields":[]}'::jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_kind" text NOT NULL,
	"created_by_user_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" uuid,
	CONSTRAINT "managed_items_placement_check" CHECK ("managed_items"."placement" in ('news','resource','submission','requirement','rules','showcase','honor')),
	CONSTRAINT "managed_items_audience_kind_check" CHECK ("managed_items"."audience_kind" in ('public','signed_in','cohort_students','teachers','groups')),
	CONSTRAINT "managed_items_receiver_unit_check" CHECK ("managed_items"."receiver_unit" in ('none','individual','group')),
	CONSTRAINT "managed_items_status_check" CHECK ("managed_items"."status" in ('draft','published','archived')),
	CONSTRAINT "managed_items_receiver_audience_check" CHECK ("managed_items"."receiver_unit" = 'none' or "managed_items"."audience_kind" in ('cohort_students','groups')),
	CONSTRAINT "managed_items_receiver_placement_check" CHECK ("managed_items"."receiver_unit" = 'none' or "managed_items"."placement" in ('submission','requirement')),
	CONSTRAINT "managed_items_receiver_schedule_check" CHECK ("managed_items"."status" = 'draft' or "managed_items"."receiver_unit" = 'none' or ("managed_items"."stage_id" is not null and "managed_items"."due_at" is not null)),
	CONSTRAINT "managed_items_due_after_open_check" CHECK ("managed_items"."due_at" >= coalesce("managed_items"."opens_at", "managed_items"."actual_opened_at")),
	CONSTRAINT "managed_items_published_check" CHECK ("managed_items"."status" = 'draft' or ("managed_items"."actual_opened_at" is not null
          and "managed_items"."current_content_version_id" is not null and "managed_items"."current_schema_version_id" is not null)),
	CONSTRAINT "managed_items_deadline_version_check" CHECK ("managed_items"."deadline_version" >= 1),
	CONSTRAINT "managed_items_draft_schema_check" CHECK (coalesce(jsonb_typeof("managed_items"."draft_schema" -> 'fields'), 'missing') = 'array'),
	CONSTRAINT "managed_items_created_by_kind_check" CHECK ("managed_items"."created_by_kind" in ('user','system','worker')),
	CONSTRAINT "managed_items_created_by_actor_check" CHECK (("managed_items"."created_by_kind" = 'user') = ("managed_items"."created_by_user_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "response_rosters" (
	"id" uuid PRIMARY KEY NOT NULL,
	"item_id" uuid NOT NULL,
	"cohort_id" uuid NOT NULL,
	"receiver_kind" text NOT NULL,
	"receiver_id" uuid NOT NULL,
	"eligible_from_business_at" timestamp with time zone NOT NULL,
	"eligible_to_business_at" timestamp with time zone,
	"source" text NOT NULL,
	"exempt" boolean DEFAULT false NOT NULL,
	"exempt_reason" text,
	"removed_reason" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_kind" text NOT NULL,
	"created_by_user_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" uuid,
	CONSTRAINT "response_rosters_receiver_kind_check" CHECK ("response_rosters"."receiver_kind" in ('user','group')),
	CONSTRAINT "response_rosters_source_check" CHECK ("response_rosters"."source" in ('auto','admin')),
	CONSTRAINT "response_rosters_exempt_reason_check" CHECK (not "response_rosters"."exempt" or length(btrim(coalesce("response_rosters"."exempt_reason", ''))) > 0),
	CONSTRAINT "response_rosters_removed_check" CHECK (("response_rosters"."eligible_to_business_at" is null) = ("response_rosters"."removed_reason" is null)),
	CONSTRAINT "response_rosters_range_check" CHECK ("response_rosters"."eligible_to_business_at" is null or "response_rosters"."eligible_to_business_at" >= "response_rosters"."eligible_from_business_at"),
	CONSTRAINT "response_rosters_created_by_kind_check" CHECK ("response_rosters"."created_by_kind" in ('user','system','worker')),
	CONSTRAINT "response_rosters_created_by_actor_check" CHECK (("response_rosters"."created_by_kind" = 'user') = ("response_rosters"."created_by_user_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "form_schema_versions" ADD CONSTRAINT "form_schema_versions_item_id_managed_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."managed_items"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "form_schema_versions" ADD CONSTRAINT "form_schema_versions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "item_attachments" ADD CONSTRAINT "item_attachments_item_id_managed_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."managed_items"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "item_attachments" ADD CONSTRAINT "item_attachments_file_id_stored_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."stored_files"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "item_audience_groups" ADD CONSTRAINT "item_audience_groups_item_id_managed_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."managed_items"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "item_audience_groups" ADD CONSTRAINT "item_audience_groups_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "item_publications" ADD CONSTRAINT "item_publications_item_id_managed_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."managed_items"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "item_publications" ADD CONSTRAINT "item_publications_content_version_id_item_versions_id_fk" FOREIGN KEY ("content_version_id") REFERENCES "public"."item_versions"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "item_publications" ADD CONSTRAINT "item_publications_schema_version_id_form_schema_versions_id_fk" FOREIGN KEY ("schema_version_id") REFERENCES "public"."form_schema_versions"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "item_publications" ADD CONSTRAINT "item_publications_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "item_versions" ADD CONSTRAINT "item_versions_item_id_managed_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."managed_items"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "item_versions" ADD CONSTRAINT "item_versions_cover_file_id_stored_files_id_fk" FOREIGN KEY ("cover_file_id") REFERENCES "public"."stored_files"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "item_versions" ADD CONSTRAINT "item_versions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "managed_items" ADD CONSTRAINT "managed_items_cohort_id_cohorts_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "public"."cohorts"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "managed_items" ADD CONSTRAINT "managed_items_stage_id_cohort_stages_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."cohort_stages"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "managed_items" ADD CONSTRAINT "managed_items_current_content_version_id_item_versions_id_fk" FOREIGN KEY ("current_content_version_id") REFERENCES "public"."item_versions"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "managed_items" ADD CONSTRAINT "managed_items_current_schema_version_id_form_schema_versions_id_fk" FOREIGN KEY ("current_schema_version_id") REFERENCES "public"."form_schema_versions"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "managed_items" ADD CONSTRAINT "managed_items_cover_file_id_stored_files_id_fk" FOREIGN KEY ("cover_file_id") REFERENCES "public"."stored_files"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "managed_items" ADD CONSTRAINT "managed_items_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "managed_items" ADD CONSTRAINT "managed_items_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "response_rosters" ADD CONSTRAINT "response_rosters_item_id_managed_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."managed_items"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "response_rosters" ADD CONSTRAINT "response_rosters_cohort_id_cohorts_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "public"."cohorts"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "response_rosters" ADD CONSTRAINT "response_rosters_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "response_rosters" ADD CONSTRAINT "response_rosters_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE INDEX "item_publications_item_idx" ON "item_publications" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "managed_items_cohort_status_placement_idx" ON "managed_items" USING btree ("cohort_id","status","placement");--> statement-breakpoint
CREATE INDEX "managed_items_cohort_due_idx" ON "managed_items" USING btree ("cohort_id","due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "response_rosters_one_current" ON "response_rosters" USING btree ("item_id","receiver_kind","receiver_id") WHERE "response_rosters"."eligible_to_business_at" is null;--> statement-breakpoint
CREATE INDEX "response_rosters_item_idx" ON "response_rosters" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "response_rosters_receiver_idx" ON "response_rosters" USING btree ("receiver_kind","receiver_id");
--> statement-breakpoint

-- 票 15（S04-01）：專題事務六張表（模組 04 附錄 A）與收件名單表（模組 05 附錄 A，表歸 05、由這支建）。
--
-- 只新增表，舊表舊資料不動，所以空庫升級與現有資料升版走同一條路。0001–0004 的產生區塊不動
-- （已部署的 migration 不能改）。
--
-- managed_items 與 item_versions、form_schema_versions 互相指（頭列指「目前版本」、版本列指頭列）：
-- 發布時先插版本列、再更新頭列的指標，同一筆交易內完成。
--
-- 下面的 GRANT 不是手寫的：由 web/src/infrastructure/db/permissions/matrix.json 中 slice 為 S04 的列，
-- 經 `pnpm -C web db:grants --write` 產生，CI 用 `--check` 核對。

-- >>> 由 scripts/generate-grants.mjs 從 permissions/matrix.json 產生；不要手改 >>>
-- 先全部收回，再照矩陣逐項給回去。沒列到的操作就是沒有。
REVOKE ALL ON managed_items, item_audience_groups, item_versions, form_schema_versions, item_attachments, item_publications, response_rosters
  FROM fju_app, fju_backup;
--> statement-breakpoint

GRANT SELECT ON managed_items, item_audience_groups, item_versions, form_schema_versions, item_attachments, item_publications, response_rosters TO fju_app;
--> statement-breakpoint

GRANT INSERT ON managed_items, item_audience_groups, item_versions, form_schema_versions, item_attachments, item_publications, response_rosters TO fju_app;
--> statement-breakpoint

GRANT UPDATE ON managed_items, response_rosters TO fju_app;
--> statement-breakpoint

-- 附件集合：只改排序；移除即 DELETE 並釋放 file_references
GRANT UPDATE (sort) ON item_attachments TO fju_app;
--> statement-breakpoint

GRANT DELETE ON item_audience_groups, item_attachments TO fju_app;
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

DROP TRIGGER IF EXISTS item_versions_immutable_row ON item_versions;
--> statement-breakpoint

CREATE TRIGGER item_versions_immutable_row
  BEFORE UPDATE OR DELETE ON item_versions
  FOR EACH ROW EXECUTE FUNCTION fju_reject_mutation();
--> statement-breakpoint

DROP TRIGGER IF EXISTS item_versions_immutable_truncate ON item_versions;
--> statement-breakpoint

CREATE TRIGGER item_versions_immutable_truncate
  BEFORE TRUNCATE ON item_versions
  FOR EACH STATEMENT EXECUTE FUNCTION fju_reject_mutation();
--> statement-breakpoint

DROP TRIGGER IF EXISTS form_schema_versions_immutable_row ON form_schema_versions;
--> statement-breakpoint

CREATE TRIGGER form_schema_versions_immutable_row
  BEFORE UPDATE OR DELETE ON form_schema_versions
  FOR EACH ROW EXECUTE FUNCTION fju_reject_mutation();
--> statement-breakpoint

DROP TRIGGER IF EXISTS form_schema_versions_immutable_truncate ON form_schema_versions;
--> statement-breakpoint

CREATE TRIGGER form_schema_versions_immutable_truncate
  BEFORE TRUNCATE ON form_schema_versions
  FOR EACH STATEMENT EXECUTE FUNCTION fju_reject_mutation();
--> statement-breakpoint

DROP TRIGGER IF EXISTS item_publications_immutable_row ON item_publications;
--> statement-breakpoint

CREATE TRIGGER item_publications_immutable_row
  BEFORE UPDATE OR DELETE ON item_publications
  FOR EACH ROW EXECUTE FUNCTION fju_reject_mutation();
--> statement-breakpoint

DROP TRIGGER IF EXISTS item_publications_immutable_truncate ON item_publications;
--> statement-breakpoint

CREATE TRIGGER item_publications_immutable_truncate
  BEFORE TRUNCATE ON item_publications
  FOR EACH STATEMENT EXECUTE FUNCTION fju_reject_mutation();
-- <<< 產生區塊結束 <<<
