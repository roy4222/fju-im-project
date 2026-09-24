CREATE TABLE "advisor_assignments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"group_id" uuid NOT NULL,
	"teacher_user_id" uuid NOT NULL,
	"source" text NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone,
	"assigned_by_user_id" uuid NOT NULL,
	"reason" text,
	"previous_assignment_id" uuid,
	"ended_real_at" timestamp with time zone,
	"ended_by_user_id" uuid,
	"end_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "advisor_assignments_source_check" CHECK ("advisor_assignments"."source" in ('claim','admin','csv')),
	CONSTRAINT "advisor_assignments_valid_range_check" CHECK ("advisor_assignments"."valid_to" is null or "advisor_assignments"."valid_to" >= "advisor_assignments"."valid_from"),
	CONSTRAINT "advisor_assignments_claim_self_check" CHECK ("advisor_assignments"."source" <> 'claim' or "advisor_assignments"."assigned_by_user_id" = "advisor_assignments"."teacher_user_id"),
	CONSTRAINT "advisor_assignments_admin_reason_check" CHECK ("advisor_assignments"."source" = 'claim' or length(btrim(coalesce("advisor_assignments"."reason", ''))) > 0),
	CONSTRAINT "advisor_assignments_ended_check" CHECK (("advisor_assignments"."valid_to" is null) = ("advisor_assignments"."ended_real_at" is null)
          and ("advisor_assignments"."valid_to" is null or ("advisor_assignments"."ended_by_user_id" is not null and length(btrim(coalesce("advisor_assignments"."end_reason", ''))) > 0)))
);
--> statement-breakpoint
CREATE TABLE "industry_opportunities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_teacher_user_id" uuid NOT NULL,
	"company_name" text NOT NULL,
	"department" text NOT NULL,
	"content" text NOT NULL,
	"requirements" text NOT NULL,
	"notes" text,
	"notes_visibility" text DEFAULT 'internal' NOT NULL,
	"address" text,
	"contact_name" text,
	"contact_phone" text,
	"contact_email" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"published_business_at" timestamp with time zone,
	"withdrawn_business_at" timestamp with time zone,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_kind" text NOT NULL,
	"created_by_user_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" uuid,
	CONSTRAINT "industry_opportunities_status_check" CHECK ("industry_opportunities"."status" in ('draft','published','withdrawn')),
	CONSTRAINT "industry_opportunities_notes_visibility_check" CHECK ("industry_opportunities"."notes_visibility" in ('signed_in','internal')),
	CONSTRAINT "industry_opportunities_published_at_check" CHECK ("industry_opportunities"."status" <> 'published' or "industry_opportunities"."published_business_at" is not null),
	CONSTRAINT "industry_opportunities_withdrawn_at_check" CHECK ("industry_opportunities"."status" <> 'withdrawn' or "industry_opportunities"."withdrawn_business_at" is not null),
	CONSTRAINT "industry_opportunities_revision_check" CHECK ("industry_opportunities"."revision" >= 1),
	CONSTRAINT "industry_opportunities_created_by_kind_check" CHECK ("industry_opportunities"."created_by_kind" in ('user','system','worker')),
	CONSTRAINT "industry_opportunities_created_by_actor_check" CHECK (("industry_opportunities"."created_by_kind" = 'user') = ("industry_opportunities"."created_by_user_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "opportunity_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"group_id" uuid NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone,
	"linked_by_user_id" uuid NOT NULL,
	"previous_link_id" uuid,
	"ended_real_at" timestamp with time zone,
	"ended_by_user_id" uuid,
	"end_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "opportunity_links_valid_range_check" CHECK ("opportunity_links"."valid_to" is null or "opportunity_links"."valid_to" >= "opportunity_links"."valid_from"),
	CONSTRAINT "opportunity_links_ended_check" CHECK (("opportunity_links"."valid_to" is null) = ("opportunity_links"."ended_real_at" is null)
          and ("opportunity_links"."valid_to" is null or ("opportunity_links"."ended_by_user_id" is not null and length(btrim(coalesce("opportunity_links"."end_reason", ''))) > 0)))
);
--> statement-breakpoint
ALTER TABLE "stored_files" DROP CONSTRAINT "stored_files_purpose_check";--> statement-breakpoint
ALTER TABLE "advisor_assignments" ADD CONSTRAINT "advisor_assignments_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "advisor_assignments" ADD CONSTRAINT "advisor_assignments_teacher_user_id_users_id_fk" FOREIGN KEY ("teacher_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "advisor_assignments" ADD CONSTRAINT "advisor_assignments_assigned_by_user_id_users_id_fk" FOREIGN KEY ("assigned_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "advisor_assignments" ADD CONSTRAINT "advisor_assignments_previous_assignment_id_advisor_assignments_id_fk" FOREIGN KEY ("previous_assignment_id") REFERENCES "public"."advisor_assignments"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "advisor_assignments" ADD CONSTRAINT "advisor_assignments_ended_by_user_id_users_id_fk" FOREIGN KEY ("ended_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "industry_opportunities" ADD CONSTRAINT "industry_opportunities_owner_teacher_user_id_users_id_fk" FOREIGN KEY ("owner_teacher_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "industry_opportunities" ADD CONSTRAINT "industry_opportunities_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "industry_opportunities" ADD CONSTRAINT "industry_opportunities_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "opportunity_links" ADD CONSTRAINT "opportunity_links_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "opportunity_links" ADD CONSTRAINT "opportunity_links_opportunity_id_industry_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."industry_opportunities"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "opportunity_links" ADD CONSTRAINT "opportunity_links_linked_by_user_id_users_id_fk" FOREIGN KEY ("linked_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "opportunity_links" ADD CONSTRAINT "opportunity_links_previous_link_id_opportunity_links_id_fk" FOREIGN KEY ("previous_link_id") REFERENCES "public"."opportunity_links"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "opportunity_links" ADD CONSTRAINT "opportunity_links_ended_by_user_id_users_id_fk" FOREIGN KEY ("ended_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE UNIQUE INDEX "advisor_assignments_one_active" ON "advisor_assignments" USING btree ("group_id") WHERE "advisor_assignments"."valid_to" is null;--> statement-breakpoint
CREATE INDEX "advisor_assignments_group_idx" ON "advisor_assignments" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "advisor_assignments_teacher_active_idx" ON "advisor_assignments" USING btree ("teacher_user_id") WHERE "advisor_assignments"."valid_to" is null;--> statement-breakpoint
CREATE INDEX "industry_opportunities_owner_idx" ON "industry_opportunities" USING btree ("owner_teacher_user_id");--> statement-breakpoint
CREATE INDEX "industry_opportunities_status_idx" ON "industry_opportunities" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "opportunity_links_one_active" ON "opportunity_links" USING btree ("group_id") WHERE "opportunity_links"."valid_to" is null;--> statement-breakpoint
CREATE INDEX "opportunity_links_group_idx" ON "opportunity_links" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "opportunity_links_opportunity_idx" ON "opportunity_links" USING btree ("opportunity_id");--> statement-breakpoint
ALTER TABLE "stored_files" ADD CONSTRAINT "stored_files_purpose_check" CHECK ("stored_files"."purpose" in ('submission','attachment','roster_csv','advisor_csv','poster','photo','export','signoff_attachment'));
--> statement-breakpoint

-- 票 19（S06）：指導老師指派、認領與重派——模組 03 附錄 A 的主指導（`advisor_assignments`）、
-- 產學合作案（`industry_opportunities`）、合作案連結（`opportunity_links`）三張表。
-- 合作案兩張表的用例與畫面在票 20（開發計畫標「改資料庫結構：否」），所以一起在這支建好。
--
-- 另外把 `stored_files_purpose_check` 的白名單多收一種 `advisor_csv`（批次指派的原始 CSV，
-- 沿用票 6 名單匯入的上傳、預覽、執行同一份原檔的做法）。這條 CHECK 只是放寬：先拿掉再加回，
-- 既有的檔案列都在舊白名單內，一定通過。
--
-- 其餘只新增表，舊表舊資料不動，所以空庫升級與現有資料升版走同一條路。0000–0006 的產生區塊不動
-- （已部署的 migration 不能改）。
--
-- 下面的 GRANT 不是手寫的：由 web/src/infrastructure/db/permissions/matrix.json 中 slice 為 S06 的列，
-- 經 `pnpm -C web db:grants --write` 產生，CI 用 `--check` 核對。

-- >>> 由 scripts/generate-grants.mjs 從 permissions/matrix.json 產生；不要手改 >>>
-- 先全部收回，再照矩陣逐項給回去。沒列到的操作就是沒有。
REVOKE ALL ON advisor_assignments, industry_opportunities, opportunity_links
  FROM fju_app, fju_backup;
--> statement-breakpoint

GRANT SELECT ON advisor_assignments, industry_opportunities, opportunity_links TO fju_app;
--> statement-breakpoint

GRANT INSERT ON advisor_assignments, industry_opportunities, opportunity_links TO fju_app;
--> statement-breakpoint

GRANT UPDATE ON industry_opportunities TO fju_app;
--> statement-breakpoint

-- 主指導有效區間列：只更新結束欄（解除、重派）
GRANT UPDATE (valid_to, ended_real_at, ended_by_user_id, end_reason) ON advisor_assignments TO fju_app;
--> statement-breakpoint

-- 連結有效區間列：只更新結束欄（解除、換案）
GRANT UPDATE (valid_to, ended_real_at, ended_by_user_id, end_reason) ON opportunity_links TO fju_app;
--> statement-breakpoint

-- 備份角色讀全庫；唯一能寫的 backup_runs 在 S12 才建（matrix.json 的 backupWrites 記著）。
GRANT pg_read_all_data TO fju_backup;
-- <<< 產生區塊結束 <<<
