CREATE TABLE "group_leaders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"group_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone,
	"changed_by_user_id" uuid NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_leaders_valid_range_check" CHECK ("group_leaders"."valid_to" is null or "group_leaders"."valid_to" >= "group_leaders"."valid_from")
);
--> statement-breakpoint
CREATE TABLE "group_memberships" (
	"id" uuid PRIMARY KEY NOT NULL,
	"group_id" uuid NOT NULL,
	"cohort_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone,
	"added_by_kind" text NOT NULL,
	"added_by_user_id" uuid,
	"removal_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_memberships_valid_range_check" CHECK ("group_memberships"."valid_to" is null or "group_memberships"."valid_to" >= "group_memberships"."valid_from"),
	CONSTRAINT "group_memberships_added_by_kind_check" CHECK ("group_memberships"."added_by_kind" in ('user','system','worker')),
	CONSTRAINT "group_memberships_added_by_actor_check" CHECK (("group_memberships"."added_by_kind" = 'user') = ("group_memberships"."added_by_user_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "group_proposals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"cohort_id" uuid NOT NULL,
	"proposer_user_id" uuid NOT NULL,
	"group_type" text NOT NULL,
	"expires_business_at" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"termination_kind" text,
	"reason" text,
	"established_group_id" uuid,
	"deadline_version" integer DEFAULT 1 NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_real_at" timestamp with time zone NOT NULL,
	"created_business_at" timestamp with time zone NOT NULL,
	"closed_real_at" timestamp with time zone,
	"closed_business_at" timestamp with time zone,
	"closed_by_kind" text,
	"closed_by_user_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_proposals_group_type_check" CHECK ("group_proposals"."group_type" in ('general','industry')),
	CONSTRAINT "group_proposals_state_check" CHECK ("group_proposals"."state" in ('open','established','terminated')),
	CONSTRAINT "group_proposals_termination_kind_check" CHECK ("group_proposals"."termination_kind" is null or "group_proposals"."termination_kind" in
          ('declined','member_withdrew','proposer_withdrew','expired','admin_voided','conflict')),
	CONSTRAINT "group_proposals_terminated_kind_check" CHECK (("group_proposals"."state" = 'terminated') = ("group_proposals"."termination_kind" is not null)),
	CONSTRAINT "group_proposals_admin_voided_reason_check" CHECK ("group_proposals"."termination_kind" is distinct from 'admin_voided' or length(btrim(coalesce("group_proposals"."reason", ''))) > 0),
	CONSTRAINT "group_proposals_established_group_check" CHECK (("group_proposals"."state" = 'established') = ("group_proposals"."established_group_id" is not null)),
	CONSTRAINT "group_proposals_closed_check" CHECK (("group_proposals"."state" = 'open') = ("group_proposals"."closed_real_at" is null)
          and ("group_proposals"."closed_real_at" is null) = ("group_proposals"."closed_business_at" is null)
          and ("group_proposals"."closed_real_at" is null) = ("group_proposals"."closed_by_kind" is null)),
	CONSTRAINT "group_proposals_closed_by_kind_check" CHECK ("group_proposals"."closed_by_kind" is null or "group_proposals"."closed_by_kind" in ('user','system','worker')),
	CONSTRAINT "group_proposals_closed_by_actor_check" CHECK ("group_proposals"."closed_by_kind" is null or ("group_proposals"."closed_by_kind" = 'user') = ("group_proposals"."closed_by_user_id" is not null)),
	CONSTRAINT "group_proposals_deadline_version_check" CHECK ("group_proposals"."deadline_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"cohort_id" uuid NOT NULL,
	"code" text NOT NULL,
	"group_type" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"established_real_at" timestamp with time zone NOT NULL,
	"established_business_at" timestamp with time zone NOT NULL,
	"dissolved_real_at" timestamp with time zone,
	"dissolve_reason" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_kind" text NOT NULL,
	"created_by_user_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" uuid,
	CONSTRAINT "groups_cohort_code_unique" UNIQUE("cohort_id","code"),
	CONSTRAINT "groups_group_type_check" CHECK ("groups"."group_type" in ('general','industry')),
	CONSTRAINT "groups_status_check" CHECK ("groups"."status" in ('active','dissolved')),
	CONSTRAINT "groups_dissolved_check" CHECK (("groups"."status" = 'dissolved') = ("groups"."dissolved_real_at" is not null)
          and ("groups"."status" <> 'dissolved' or "groups"."dissolve_reason" is not null)),
	CONSTRAINT "groups_created_by_kind_check" CHECK ("groups"."created_by_kind" in ('user','system','worker')),
	CONSTRAINT "groups_created_by_actor_check" CHECK (("groups"."created_by_kind" = 'user') = ("groups"."created_by_user_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "proposal_invitations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"proposal_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"decided_real_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proposal_invitations_proposal_user_unique" UNIQUE("proposal_id","user_id"),
	CONSTRAINT "proposal_invitations_state_check" CHECK ("proposal_invitations"."state" in ('pending','confirmed','declined','withdrawn','released'))
);
--> statement-breakpoint
CREATE TABLE "proposal_occupancy" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"proposal_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cohorts" ADD COLUMN "proposal_default_days" integer DEFAULT 7 NOT NULL;--> statement-breakpoint
ALTER TABLE "cohorts" ADD COLUMN "group_size_min" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "cohorts" ADD COLUMN "group_size_max" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "open_to_join" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "group_leaders" ADD CONSTRAINT "group_leaders_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "group_leaders" ADD CONSTRAINT "group_leaders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "group_leaders" ADD CONSTRAINT "group_leaders_changed_by_user_id_users_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "group_memberships" ADD CONSTRAINT "group_memberships_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "group_memberships" ADD CONSTRAINT "group_memberships_cohort_id_cohorts_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "public"."cohorts"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "group_memberships" ADD CONSTRAINT "group_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "group_memberships" ADD CONSTRAINT "group_memberships_added_by_user_id_users_id_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "group_proposals" ADD CONSTRAINT "group_proposals_cohort_id_cohorts_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "public"."cohorts"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "group_proposals" ADD CONSTRAINT "group_proposals_proposer_user_id_users_id_fk" FOREIGN KEY ("proposer_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "group_proposals" ADD CONSTRAINT "group_proposals_established_group_id_groups_id_fk" FOREIGN KEY ("established_group_id") REFERENCES "public"."groups"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "group_proposals" ADD CONSTRAINT "group_proposals_closed_by_user_id_users_id_fk" FOREIGN KEY ("closed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_cohort_id_cohorts_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "public"."cohorts"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "proposal_invitations" ADD CONSTRAINT "proposal_invitations_proposal_id_group_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."group_proposals"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "proposal_invitations" ADD CONSTRAINT "proposal_invitations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "proposal_occupancy" ADD CONSTRAINT "proposal_occupancy_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "proposal_occupancy" ADD CONSTRAINT "proposal_occupancy_proposal_id_group_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."group_proposals"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE UNIQUE INDEX "group_leaders_one_active" ON "group_leaders" USING btree ("group_id") WHERE "group_leaders"."valid_to" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "group_memberships_one_active" ON "group_memberships" USING btree ("user_id","cohort_id") WHERE "group_memberships"."valid_to" is null;--> statement-breakpoint
CREATE INDEX "group_memberships_group_idx" ON "group_memberships" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "group_proposals_cohort_state_idx" ON "group_proposals" USING btree ("cohort_id","state");--> statement-breakpoint
CREATE INDEX "group_proposals_proposer_idx" ON "group_proposals" USING btree ("proposer_user_id");--> statement-breakpoint
CREATE INDEX "proposal_invitations_user_idx" ON "proposal_invitations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "proposal_occupancy_proposal_idx" ON "proposal_occupancy" USING btree ("proposal_id");--> statement-breakpoint
ALTER TABLE "cohorts" ADD CONSTRAINT "cohorts_active_year_end_check" CHECK ("cohorts"."status" <> 'active' or "cohorts"."year_end_date" is not null) NOT VALID;--> statement-breakpoint
ALTER TABLE "cohorts" ADD CONSTRAINT "cohorts_proposal_default_days_check" CHECK ("cohorts"."proposal_default_days" > 0);--> statement-breakpoint
ALTER TABLE "cohorts" ADD CONSTRAINT "cohorts_group_size_check" CHECK ("cohorts"."group_size_min" >= 1 and "cohorts"."group_size_min" <= "cohorts"."group_size_max");
--> statement-breakpoint

-- 票 13（S03-01）：分組六張表的逐表權限，以及屆別的三個新欄（契約 01 §5；模組 03、02 附錄 A）。
--
-- 只新增：六張表、cohorts 三欄（提案預設天數、每組最少／最多人數，都有預設值，舊列直接補上預設）、
-- user_profiles 一欄（公開找組員，預設關閉）、三條 cohorts CHECK。舊表舊資料不動，
-- 所以空庫升級與現有資料升版走同一條路。0001–0003 的產生區塊不動（已部署的 migration 不能改）。
--
-- `cohorts_active_year_end_check` 以 NOT VALID 加（模組 02 附錄 A）：之後的寫入都會檢查，
-- 既有的「進行中但沒有年度結束日」列不會讓升版失敗；A1 補齊後再 `VALIDATE CONSTRAINT`（另開 migration）。
--
-- 下面的 GRANT 不是手寫的：由 web/src/infrastructure/db/permissions/matrix.json 中 slice 為 S03 的列，
-- 經 `pnpm -C web db:grants --write` 產生，CI 用 `--check` 核對。

-- >>> 由 scripts/generate-grants.mjs 從 permissions/matrix.json 產生；不要手改 >>>
-- 先全部收回，再照矩陣逐項給回去。沒列到的操作就是沒有。
REVOKE ALL ON group_proposals, proposal_invitations, proposal_occupancy, groups, group_memberships, group_leaders
  FROM fju_app, fju_backup;
--> statement-breakpoint

GRANT SELECT ON group_proposals, proposal_invitations, proposal_occupancy, groups, group_memberships, group_leaders TO fju_app;
--> statement-breakpoint

GRANT INSERT ON group_proposals, proposal_invitations, proposal_occupancy, groups, group_memberships, group_leaders TO fju_app;
--> statement-breakpoint

GRANT UPDATE ON group_proposals, groups TO fju_app;
--> statement-breakpoint

-- 狀態列；成立或終止後不再變
GRANT UPDATE (state, decided_real_at) ON proposal_invitations TO fju_app;
--> statement-breakpoint

-- 有效區間列：只更新結束欄
GRANT UPDATE (valid_to, removal_reason, updated_at) ON group_memberships TO fju_app;
--> statement-breakpoint

-- 有效區間列：只更新結束欄
GRANT UPDATE (valid_to) ON group_leaders TO fju_app;
--> statement-breakpoint

GRANT DELETE ON proposal_occupancy TO fju_app;
--> statement-breakpoint

-- 備份角色讀全庫；唯一能寫的 backup_runs 在 S12 才建（matrix.json 的 backupWrites 記著）。
GRANT pg_read_all_data TO fju_backup;
-- <<< 產生區塊結束 <<<