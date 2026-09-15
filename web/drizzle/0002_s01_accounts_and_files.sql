CREATE TABLE "file_references" (
	"id" uuid PRIMARY KEY NOT NULL,
	"file_id" uuid NOT NULL,
	"ref_type" text NOT NULL,
	"ref_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	CONSTRAINT "file_references_ref_type_check" CHECK ("file_references"."ref_type" in ('draft','submission_version','item_attachment','signoff_version','showcase_version','showcase_draft','export','roster_version'))
);
--> statement-breakpoint
CREATE TABLE "stored_files" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"cohort_id" uuid,
	"purpose" text NOT NULL,
	"original_name" text NOT NULL,
	"size_bytes" bigint,
	"mime_declared" text NOT NULL,
	"mime_detected" text,
	"extension" text NOT NULL,
	"checksum" text,
	"status" text DEFAULT 'uploading' NOT NULL,
	"storage_key" text NOT NULL,
	"uploaded_real_at" timestamp with time zone NOT NULL,
	"finalized_at" timestamp with time zone,
	"soft_deleted_at" timestamp with time zone,
	"purged_at" timestamp with time zone,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" uuid,
	CONSTRAINT "stored_files_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "stored_files_scope_check" CHECK ("stored_files"."scope" in ('cohort','global')),
	CONSTRAINT "stored_files_scope_cohort_check" CHECK (("stored_files"."scope" = 'cohort') = ("stored_files"."cohort_id" is not null)),
	CONSTRAINT "stored_files_purpose_check" CHECK ("stored_files"."purpose" in ('submission','attachment','roster_csv','poster','photo','export','signoff_attachment')),
	CONSTRAINT "stored_files_status_check" CHECK ("stored_files"."status" in ('uploading','stored','soft_deleted','purged')),
	CONSTRAINT "stored_files_stored_requires_size_check" CHECK ("stored_files"."status" <> 'stored' or "stored_files"."size_bytes" is not null),
	CONSTRAINT "stored_files_stored_requires_checksum_check" CHECK ("stored_files"."status" <> 'stored' or "stored_files"."checksum" is not null)
);
--> statement-breakpoint
CREATE TABLE "application_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"application_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_revisions_identity" UNIQUE("application_id","revision")
);
--> statement-breakpoint
CREATE TABLE "registration_applications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"applied_name" text NOT NULL,
	"student_no" text NOT NULL,
	"department_class" text,
	"phone" text NOT NULL,
	"contact_email" text NOT NULL,
	"login_email" text NOT NULL,
	"roster_version_id" uuid,
	"roster_match" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"decided_by_user_id" uuid,
	"decided_real_at" timestamp with time zone,
	"verification_method" text,
	"verification_note" text,
	"reason" text,
	"assigned_cohort_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" uuid,
	CONSTRAINT "registration_applications_state_check" CHECK ("registration_applications"."state" in ('pending','approved','rejected')),
	CONSTRAINT "registration_applications_verification_method_check" CHECK ("registration_applications"."verification_method" is null or "registration_applications"."verification_method" in ('id_document','school_channel','other')),
	CONSTRAINT "registration_applications_approved_verification_check" CHECK ("registration_applications"."state" <> 'approved' or "registration_applications"."verification_method" is not null),
	CONSTRAINT "registration_applications_other_note_check" CHECK ("registration_applications"."verification_method" is distinct from 'other' or "registration_applications"."verification_note" is not null)
);
--> statement-breakpoint
CREATE TABLE "role_assignments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"granted_by_user_id" uuid NOT NULL,
	"granted_real_at" timestamp with time zone NOT NULL,
	"revoked_by_user_id" uuid,
	"revoked_real_at" timestamp with time zone,
	"reason" text,
	CONSTRAINT "role_assignments_role_check" CHECK ("role_assignments"."role" in ('student','teacher','admin'))
);
--> statement-breakpoint
CREATE TABLE "roster_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"roster_version_id" uuid NOT NULL,
	"student_no" text NOT NULL,
	"name_raw" text NOT NULL,
	"name_normalized" text NOT NULL,
	"department_class" text,
	"email" text,
	"conflict_flag" text,
	CONSTRAINT "roster_entries_identity" UNIQUE("roster_version_id","student_no"),
	CONSTRAINT "roster_entries_conflict_flag_check" CHECK ("roster_entries"."conflict_flag" is null or "roster_entries"."conflict_flag" in ('duplicate','name_mismatch','missing_name'))
);
--> statement-breakpoint
CREATE TABLE "roster_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"cohort_id" uuid NOT NULL,
	"imported_by_user_id" uuid NOT NULL,
	"imported_real_at" timestamp with time zone NOT NULL,
	"summary" jsonb NOT NULL,
	"file_id" uuid
);
--> statement-breakpoint
CREATE TABLE "session_revocations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"status_event_id" uuid NOT NULL,
	"trigger" text DEFAULT 'status_event' NOT NULL,
	"reconcile_reason" text,
	"reconcile_of_id" uuid,
	"reconcile_round" integer DEFAULT 0 NOT NULL,
	"kind" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"outcome_unknown" boolean DEFAULT false NOT NULL,
	"expected_user_status" text NOT NULL,
	"cancel_reason" text,
	"last_error" text,
	"requested_real_at" timestamp with time zone NOT NULL,
	"completed_real_at" timestamp with time zone,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" uuid,
	CONSTRAINT "session_revocations_trigger_check" CHECK ("session_revocations"."trigger" in ('status_event','reconcile')),
	CONSTRAINT "session_revocations_reconcile_reason_check" CHECK ("session_revocations"."reconcile_reason" is null or "session_revocations"."reconcile_reason" in ('after_completion','periodic','manual_retry')),
	CONSTRAINT "session_revocations_reconcile_reason_pairing_check" CHECK (("session_revocations"."trigger" = 'reconcile') = ("session_revocations"."reconcile_reason" is not null)),
	CONSTRAINT "session_revocations_reconcile_of_pairing_check" CHECK (("session_revocations"."trigger" = 'reconcile') = ("session_revocations"."reconcile_of_id" is not null)),
	CONSTRAINT "session_revocations_reconcile_round_check" CHECK (("session_revocations"."trigger" = 'status_event' and "session_revocations"."reconcile_round" = 0) or ("session_revocations"."trigger" = 'reconcile' and "session_revocations"."reconcile_round" >= 1)),
	CONSTRAINT "session_revocations_kind_check" CHECK ("session_revocations"."kind" in ('ban','unban','revoke_all')),
	CONSTRAINT "session_revocations_state_check" CHECK ("session_revocations"."state" in ('queued','executing','done','failed','cancelled')),
	CONSTRAINT "session_revocations_expected_user_status_check" CHECK ("session_revocations"."expected_user_status" in ('disabled','active','deidentified')),
	CONSTRAINT "session_revocations_lease_check" CHECK ("session_revocations"."state" <> 'executing' or ("session_revocations"."lease_owner" is not null and "session_revocations"."lease_expires_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "student_identities" (
	"cohort_id" uuid NOT NULL,
	"student_no" text NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "student_identities_pkey" PRIMARY KEY("cohort_id","student_no"),
	CONSTRAINT "student_identities_user_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "user_profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"name_normalized" text NOT NULL,
	"student_no" text,
	"department_class" text,
	"cohort_id" uuid,
	"phone" text,
	"contact_email" text NOT NULL,
	"login_method_last" text,
	"profile_completed_at" timestamp with time zone,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" uuid,
	CONSTRAINT "user_profiles_login_method_last_check" CHECK ("user_profiles"."login_method_last" is null or "user_profiles"."login_method_last" in ('google','password'))
);
--> statement-breakpoint
CREATE TABLE "user_status_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"from_status" text NOT NULL,
	"to_status" text NOT NULL,
	"reason" text,
	"verification_method" text,
	"actor_kind" text NOT NULL,
	"actor_user_id" uuid,
	"real_at" timestamp with time zone NOT NULL,
	CONSTRAINT "user_status_events_from_status_check" CHECK ("user_status_events"."from_status" in ('pending','active','disabled','deidentified')),
	CONSTRAINT "user_status_events_to_status_check" CHECK ("user_status_events"."to_status" in ('pending','active','disabled','deidentified')),
	CONSTRAINT "user_status_events_verification_method_check" CHECK ("user_status_events"."verification_method" is null or "user_status_events"."verification_method" in ('id_document','school_channel','other')),
	CONSTRAINT "user_status_events_actor_kind_check" CHECK ("user_status_events"."actor_kind" in ('user','system','worker')),
	CONSTRAINT "user_status_events_actor_check" CHECK (("user_status_events"."actor_kind" = 'user') = ("user_status_events"."actor_user_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "file_references" ADD CONSTRAINT "file_references_file_id_stored_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."stored_files"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "stored_files" ADD CONSTRAINT "stored_files_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "stored_files" ADD CONSTRAINT "stored_files_cohort_id_cohorts_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "public"."cohorts"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "stored_files" ADD CONSTRAINT "stored_files_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "application_revisions" ADD CONSTRAINT "application_revisions_application_id_registration_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."registration_applications"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "registration_applications" ADD CONSTRAINT "registration_applications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "registration_applications" ADD CONSTRAINT "registration_applications_roster_version_id_roster_versions_id_fk" FOREIGN KEY ("roster_version_id") REFERENCES "public"."roster_versions"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "registration_applications" ADD CONSTRAINT "registration_applications_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "registration_applications" ADD CONSTRAINT "registration_applications_assigned_cohort_id_cohorts_id_fk" FOREIGN KEY ("assigned_cohort_id") REFERENCES "public"."cohorts"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "registration_applications" ADD CONSTRAINT "registration_applications_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_granted_by_user_id_users_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "roster_entries" ADD CONSTRAINT "roster_entries_roster_version_id_roster_versions_id_fk" FOREIGN KEY ("roster_version_id") REFERENCES "public"."roster_versions"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "roster_versions" ADD CONSTRAINT "roster_versions_cohort_id_cohorts_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "public"."cohorts"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "roster_versions" ADD CONSTRAINT "roster_versions_imported_by_user_id_users_id_fk" FOREIGN KEY ("imported_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "roster_versions" ADD CONSTRAINT "roster_versions_file_id_stored_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."stored_files"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "session_revocations" ADD CONSTRAINT "session_revocations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "session_revocations" ADD CONSTRAINT "session_revocations_status_event_id_user_status_events_id_fk" FOREIGN KEY ("status_event_id") REFERENCES "public"."user_status_events"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "session_revocations" ADD CONSTRAINT "session_revocations_reconcile_of_id_session_revocations_id_fk" FOREIGN KEY ("reconcile_of_id") REFERENCES "public"."session_revocations"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "session_revocations" ADD CONSTRAINT "session_revocations_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "student_identities" ADD CONSTRAINT "student_identities_cohort_id_cohorts_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "public"."cohorts"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "student_identities" ADD CONSTRAINT "student_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_cohort_id_cohorts_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "public"."cohorts"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "user_status_events" ADD CONSTRAINT "user_status_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "user_status_events" ADD CONSTRAINT "user_status_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE UNIQUE INDEX "file_references_active_ref" ON "file_references" USING btree ("file_id","ref_type","ref_id") WHERE "file_references"."released_at" is null;--> statement-breakpoint
CREATE INDEX "file_references_ref_idx" ON "file_references" USING btree ("ref_type","ref_id") WHERE "file_references"."released_at" is null;--> statement-breakpoint
CREATE INDEX "file_references_file_idx" ON "file_references" USING btree ("file_id") WHERE "file_references"."released_at" is null;--> statement-breakpoint
CREATE INDEX "stored_files_status_finalized_idx" ON "stored_files" USING btree ("status","finalized_at");--> statement-breakpoint
CREATE INDEX "stored_files_owner_idx" ON "stored_files" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "registration_applications_one_pending" ON "registration_applications" USING btree ("user_id") WHERE "registration_applications"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "registration_applications_state_created_idx" ON "registration_applications" USING btree ("state","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "role_assignments_one_active" ON "role_assignments" USING btree ("user_id","role") WHERE "role_assignments"."revoked_real_at" is null;--> statement-breakpoint
CREATE INDEX "role_assignments_user_idx" ON "role_assignments" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "session_revocations_one_main_per_event" ON "session_revocations" USING btree ("status_event_id") WHERE "session_revocations"."trigger" = 'status_event';--> statement-breakpoint
CREATE UNIQUE INDEX "session_revocations_one_executing_per_user" ON "session_revocations" USING btree ("user_id") WHERE "session_revocations"."state" = 'executing';--> statement-breakpoint
CREATE UNIQUE INDEX "session_revocations_one_open_reconcile_per_user" ON "session_revocations" USING btree ("user_id") WHERE "session_revocations"."trigger" = 'reconcile' and "session_revocations"."state" in ('queued','executing');--> statement-breakpoint
CREATE INDEX "session_revocations_state_requested_idx" ON "session_revocations" USING btree ("state","requested_real_at");--> statement-breakpoint
CREATE INDEX "session_revocations_user_state_idx" ON "session_revocations" USING btree ("user_id","state");--> statement-breakpoint
CREATE INDEX "session_revocations_user_event_round_idx" ON "session_revocations" USING btree ("user_id","status_event_id","reconcile_round");--> statement-breakpoint
CREATE INDEX "user_profiles_cohort_idx" ON "user_profiles" USING btree ("cohort_id");--> statement-breakpoint
CREATE INDEX "user_profiles_student_no_idx" ON "user_profiles" USING btree ("student_no");--> statement-breakpoint
CREATE INDEX "user_status_events_user_real_at_idx" ON "user_status_events" USING btree ("user_id","real_at");
--> statement-breakpoint

-- S01-01：新表的逐表權限與不可變資料保護（契約 01 §5；模組 01 v2.4 附錄 A、模組 10 附錄 A）。
--
-- S00 的 0001 已經建好 fju_app／fju_backup 兩個角色與 schema 層的 USAGE，這裡只處理本支
-- migration 新增的十一張表；0001 的產生區塊不動（已部署的 migration 不能改）。
--
-- 下面的 GRANT 與 trigger **不是手寫的**：由 web/src/infrastructure/db/permissions/matrix.json
-- 中 slice 為 S01 的列，經 `pnpm -C web db:grants --write` 產生，CI 用 `--check` 核對。

-- >>> 由 scripts/generate-grants.mjs 從 permissions/matrix.json 產生；不要手改 >>>
-- 先全部收回，再照矩陣逐項給回去。沒列到的操作就是沒有。
REVOKE ALL ON user_profiles, student_identities, registration_applications, application_revisions, roster_versions, roster_entries, role_assignments, user_status_events, session_revocations, stored_files, file_references
  FROM fju_app, fju_backup;
--> statement-breakpoint

GRANT SELECT ON user_profiles, student_identities, registration_applications, application_revisions, roster_versions, roster_entries, role_assignments, user_status_events, session_revocations, stored_files, file_references TO fju_app;
--> statement-breakpoint

GRANT INSERT ON user_profiles, student_identities, registration_applications, application_revisions, roster_versions, roster_entries, role_assignments, user_status_events, session_revocations, stored_files, file_references TO fju_app;
--> statement-breakpoint

GRANT UPDATE ON user_profiles, registration_applications, session_revocations TO fju_app;
--> statement-breakpoint

-- 有效區間列：只更新結束欄
GRANT UPDATE (revoked_by_user_id, revoked_real_at, reason) ON role_assignments TO fju_app;
--> statement-breakpoint

-- 狀態欄；purge 是狀態加實體檔，不 DELETE 列
GRANT UPDATE (status, size_bytes, checksum, mime_detected, finalized_at, soft_deleted_at, purged_at, revision, updated_at) ON stored_files TO fju_app;
--> statement-breakpoint

-- 釋放只設欄位；重新附加插入新列（契約 01 §11）
GRANT UPDATE (released_at) ON file_references TO fju_app;
--> statement-breakpoint

GRANT DELETE ON student_identities TO fju_app;
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

DROP TRIGGER IF EXISTS application_revisions_immutable_row ON application_revisions;
--> statement-breakpoint

CREATE TRIGGER application_revisions_immutable_row
  BEFORE UPDATE OR DELETE ON application_revisions
  FOR EACH ROW EXECUTE FUNCTION fju_reject_mutation();
--> statement-breakpoint

DROP TRIGGER IF EXISTS application_revisions_immutable_truncate ON application_revisions;
--> statement-breakpoint

CREATE TRIGGER application_revisions_immutable_truncate
  BEFORE TRUNCATE ON application_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION fju_reject_mutation();
--> statement-breakpoint

DROP TRIGGER IF EXISTS roster_versions_immutable_row ON roster_versions;
--> statement-breakpoint

CREATE TRIGGER roster_versions_immutable_row
  BEFORE UPDATE OR DELETE ON roster_versions
  FOR EACH ROW EXECUTE FUNCTION fju_reject_mutation();
--> statement-breakpoint

DROP TRIGGER IF EXISTS roster_versions_immutable_truncate ON roster_versions;
--> statement-breakpoint

CREATE TRIGGER roster_versions_immutable_truncate
  BEFORE TRUNCATE ON roster_versions
  FOR EACH STATEMENT EXECUTE FUNCTION fju_reject_mutation();
--> statement-breakpoint

DROP TRIGGER IF EXISTS roster_entries_immutable_row ON roster_entries;
--> statement-breakpoint

CREATE TRIGGER roster_entries_immutable_row
  BEFORE UPDATE OR DELETE ON roster_entries
  FOR EACH ROW EXECUTE FUNCTION fju_reject_mutation();
--> statement-breakpoint

DROP TRIGGER IF EXISTS roster_entries_immutable_truncate ON roster_entries;
--> statement-breakpoint

CREATE TRIGGER roster_entries_immutable_truncate
  BEFORE TRUNCATE ON roster_entries
  FOR EACH STATEMENT EXECUTE FUNCTION fju_reject_mutation();
--> statement-breakpoint

DROP TRIGGER IF EXISTS user_status_events_immutable_row ON user_status_events;
--> statement-breakpoint

CREATE TRIGGER user_status_events_immutable_row
  BEFORE UPDATE OR DELETE ON user_status_events
  FOR EACH ROW EXECUTE FUNCTION fju_reject_mutation();
--> statement-breakpoint

DROP TRIGGER IF EXISTS user_status_events_immutable_truncate ON user_status_events;
--> statement-breakpoint

CREATE TRIGGER user_status_events_immutable_truncate
  BEFORE TRUNCATE ON user_status_events
  FOR EACH STATEMENT EXECUTE FUNCTION fju_reject_mutation();
-- <<< 產生區塊結束 <<<
