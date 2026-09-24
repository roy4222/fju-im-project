CREATE TABLE "business_clock_overrides" (
	"id" uuid PRIMARY KEY NOT NULL,
	"environment" text NOT NULL,
	"business_at" timestamp with time zone NOT NULL,
	"real_at" timestamp with time zone NOT NULL,
	"previous_business_at" timestamp with time zone,
	"set_by_user_id" uuid NOT NULL,
	"reason" text NOT NULL,
	CONSTRAINT "business_clock_overrides_environment_check" CHECK ("business_clock_overrides"."environment" in ('local','staging')),
	CONSTRAINT "business_clock_overrides_reason_check" CHECK (length(btrim("business_clock_overrides"."reason")) > 0)
);
--> statement-breakpoint
CREATE TABLE "cohort_stages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"cohort_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"name" text NOT NULL,
	"start_date" date NOT NULL,
	"deadline_version" integer DEFAULT 1 NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_kind" text NOT NULL,
	"created_by_user_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" uuid,
	CONSTRAINT "cohort_stages_seq_unique" UNIQUE("cohort_id","seq"),
	CONSTRAINT "cohort_stages_start_date_unique" UNIQUE("cohort_id","start_date"),
	CONSTRAINT "cohort_stages_seq_check" CHECK ("cohort_stages"."seq" >= 1),
	CONSTRAINT "cohort_stages_created_by_kind_check" CHECK ("cohort_stages"."created_by_kind" in ('user','system','worker')),
	CONSTRAINT "cohort_stages_created_by_actor_check" CHECK (("cohort_stages"."created_by_kind" = 'user') = ("cohort_stages"."created_by_user_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "cohort_status_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"cohort_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"reason" text,
	"unfinished_summary" jsonb,
	"actor_user_id" uuid NOT NULL,
	"real_at" timestamp with time zone NOT NULL,
	"business_at" timestamp with time zone NOT NULL,
	CONSTRAINT "cohort_status_events_from_status_check" CHECK ("cohort_status_events"."from_status" is null or "cohort_status_events"."from_status" in ('preparing','active','archived')),
	CONSTRAINT "cohort_status_events_to_status_check" CHECK ("cohort_status_events"."to_status" in ('preparing','active','archived')),
	CONSTRAINT "cohort_status_events_archive_reason_check" CHECK (("cohort_status_events"."to_status" <> 'archived' and "cohort_status_events"."from_status" is distinct from 'archived') or "cohort_status_events"."reason" is not null)
);
--> statement-breakpoint
CREATE TABLE "project_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"cohort_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"all_day" boolean DEFAULT false NOT NULL,
	"audience_kind" text NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_kind" text NOT NULL,
	"created_by_user_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" uuid,
	CONSTRAINT "project_events_ends_after_starts_check" CHECK ("project_events"."ends_at" is null or "project_events"."ends_at" >= "project_events"."starts_at"),
	CONSTRAINT "project_events_audience_kind_check" CHECK ("project_events"."audience_kind" in ('public','signed_in','cohort_students','teachers')),
	CONSTRAINT "project_events_status_check" CHECK ("project_events"."status" in ('scheduled','cancelled')),
	CONSTRAINT "project_events_created_by_kind_check" CHECK ("project_events"."created_by_kind" in ('user','system','worker')),
	CONSTRAINT "project_events_created_by_actor_check" CHECK (("project_events"."created_by_kind" = 'user') = ("project_events"."created_by_user_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "digest_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"cohort_id" uuid,
	"subject_id" uuid,
	"deadline_version" integer NOT NULL,
	"count" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"event_id" uuid NOT NULL,
	"generated_business_at" timestamp with time zone NOT NULL,
	CONSTRAINT "digest_events_identity" UNIQUE("kind","subject_id","deadline_version"),
	CONSTRAINT "digest_events_kind_check" CHECK ("digest_events"."kind" in ('overdue','unassigned_groups','projection_failed','backup_failed'))
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"event_id" uuid NOT NULL,
	"recipient_user_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"cohort_id" uuid,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"source_ref" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	CONSTRAINT "notifications_event_recipient_unique" UNIQUE("event_id","recipient_user_id"),
	CONSTRAINT "notifications_scope_check" CHECK ("notifications"."scope" in ('cohort','global')),
	CONSTRAINT "notifications_scope_cohort_check" CHECK (("notifications"."scope" = 'cohort') = ("notifications"."cohort_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "worker_heartbeat" (
	"id" smallint PRIMARY KEY NOT NULL,
	"version" text NOT NULL,
	"last_tick_real_at" timestamp with time zone NOT NULL,
	"last_projection_at" timestamp with time zone,
	"last_due_work_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "worker_heartbeat_single_row_check" CHECK ("worker_heartbeat"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "cohorts" ADD COLUMN "year_end_date" date;--> statement-breakpoint
ALTER TABLE "business_clock_overrides" ADD CONSTRAINT "business_clock_overrides_set_by_user_id_users_id_fk" FOREIGN KEY ("set_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "cohort_stages" ADD CONSTRAINT "cohort_stages_cohort_id_cohorts_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "public"."cohorts"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "cohort_stages" ADD CONSTRAINT "cohort_stages_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "cohort_stages" ADD CONSTRAINT "cohort_stages_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "cohort_status_events" ADD CONSTRAINT "cohort_status_events_cohort_id_cohorts_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "public"."cohorts"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "cohort_status_events" ADD CONSTRAINT "cohort_status_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "project_events" ADD CONSTRAINT "project_events_cohort_id_cohorts_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "public"."cohorts"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "project_events" ADD CONSTRAINT "project_events_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "project_events" ADD CONSTRAINT "project_events_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "digest_events" ADD CONSTRAINT "digest_events_cohort_id_cohorts_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "public"."cohorts"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "digest_events" ADD CONSTRAINT "digest_events_event_id_domain_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."domain_events"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_event_id_domain_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."domain_events"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_user_id_users_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_cohort_id_cohorts_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "public"."cohorts"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE INDEX "business_clock_overrides_real_at_idx" ON "business_clock_overrides" USING btree ("real_at");--> statement-breakpoint
CREATE INDEX "cohort_status_events_cohort_real_at_idx" ON "cohort_status_events" USING btree ("cohort_id","real_at");--> statement-breakpoint
CREATE INDEX "project_events_cohort_starts_idx" ON "project_events" USING btree ("cohort_id","starts_at");--> statement-breakpoint
CREATE INDEX "notifications_recipient_created_idx" ON "notifications" USING btree ("recipient_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notifications_recipient_read_idx" ON "notifications" USING btree ("recipient_user_id","read_at");
--> statement-breakpoint

-- 票 11（S02-01）：新表的逐表權限與不可變資料保護（契約 01 §5；模組 02、08 附錄 A）。
--
-- 只新增七張表與 `cohorts.year_end_date`（可為 NULL）一欄；舊表與舊資料一個不動，
-- 所以空庫升級與現有資料升版走同一條路。0001／0002 的產生區塊不動（已部署的 migration 不能改）。
--
-- 下面的 GRANT 與 trigger **不是手寫的**：由 web/src/infrastructure/db/permissions/matrix.json
-- 中 slice 為 S02 的列，經 `pnpm -C web db:grants --write` 產生，CI 用 `--check` 核對。

-- >>> 由 scripts/generate-grants.mjs 從 permissions/matrix.json 產生；不要手改 >>>
-- 先全部收回，再照矩陣逐項給回去。沒列到的操作就是沒有。
REVOKE ALL ON cohort_stages, project_events, business_clock_overrides, cohort_status_events, notifications, digest_events, worker_heartbeat
  FROM fju_app, fju_backup;
--> statement-breakpoint

GRANT SELECT ON cohort_stages, project_events, business_clock_overrides, cohort_status_events, notifications, digest_events, worker_heartbeat TO fju_app;
--> statement-breakpoint

GRANT INSERT ON cohort_stages, project_events, business_clock_overrides, cohort_status_events, notifications, digest_events, worker_heartbeat TO fju_app;
--> statement-breakpoint

GRANT UPDATE ON cohort_stages, project_events, worker_heartbeat TO fju_app;
--> statement-breakpoint

-- worker 建立、本人已讀
GRANT UPDATE (read_at) ON notifications TO fju_app;
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

DROP TRIGGER IF EXISTS business_clock_overrides_immutable_row ON business_clock_overrides;
--> statement-breakpoint

CREATE TRIGGER business_clock_overrides_immutable_row
  BEFORE UPDATE OR DELETE ON business_clock_overrides
  FOR EACH ROW EXECUTE FUNCTION fju_reject_mutation();
--> statement-breakpoint

DROP TRIGGER IF EXISTS business_clock_overrides_immutable_truncate ON business_clock_overrides;
--> statement-breakpoint

CREATE TRIGGER business_clock_overrides_immutable_truncate
  BEFORE TRUNCATE ON business_clock_overrides
  FOR EACH STATEMENT EXECUTE FUNCTION fju_reject_mutation();
--> statement-breakpoint

DROP TRIGGER IF EXISTS cohort_status_events_immutable_row ON cohort_status_events;
--> statement-breakpoint

CREATE TRIGGER cohort_status_events_immutable_row
  BEFORE UPDATE OR DELETE ON cohort_status_events
  FOR EACH ROW EXECUTE FUNCTION fju_reject_mutation();
--> statement-breakpoint

DROP TRIGGER IF EXISTS cohort_status_events_immutable_truncate ON cohort_status_events;
--> statement-breakpoint

CREATE TRIGGER cohort_status_events_immutable_truncate
  BEFORE TRUNCATE ON cohort_status_events
  FOR EACH STATEMENT EXECUTE FUNCTION fju_reject_mutation();
--> statement-breakpoint

DROP TRIGGER IF EXISTS digest_events_immutable_row ON digest_events;
--> statement-breakpoint

CREATE TRIGGER digest_events_immutable_row
  BEFORE UPDATE OR DELETE ON digest_events
  FOR EACH ROW EXECUTE FUNCTION fju_reject_mutation();
--> statement-breakpoint

DROP TRIGGER IF EXISTS digest_events_immutable_truncate ON digest_events;
--> statement-breakpoint

CREATE TRIGGER digest_events_immutable_truncate
  BEFORE TRUNCATE ON digest_events
  FOR EACH STATEMENT EXECUTE FUNCTION fju_reject_mutation();
-- <<< 產生區塊結束 <<<