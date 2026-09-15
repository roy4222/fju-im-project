CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" uuid NOT NULL,
	"impersonated_by" text,
	"login_method" text NOT NULL,
	CONSTRAINT "sessions_token_unique" UNIQUE("token"),
	CONSTRAINT "sessions_login_method_check" CHECK ("sessions"."login_method" in ('google','password'))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"role" text,
	"banned" boolean DEFAULT false,
	"ban_reason" text,
	"ban_expires" timestamp with time zone,
	"status" text DEFAULT 'pending' NOT NULL,
	"must_change_password" boolean DEFAULT false NOT NULL,
	"deidentified_at" timestamp with time zone,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_status_check" CHECK ("users"."status" in ('pending','active','disabled'))
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_user_id" uuid,
	"role" text,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid,
	"scope" text NOT NULL,
	"cohort_id" uuid,
	"reason" text,
	"verification_method" text,
	"real_at" timestamp with time zone NOT NULL,
	"business_at" timestamp with time zone NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "audit_events_actor_kind_check" CHECK ("audit_events"."actor_kind" in ('user','system','worker')),
	CONSTRAINT "audit_events_actor_check" CHECK (("audit_events"."actor_kind" = 'user') = ("audit_events"."actor_user_id" is not null)),
	CONSTRAINT "audit_events_role_check" CHECK ("audit_events"."role" is null or "audit_events"."role" in ('student','teacher','admin')),
	CONSTRAINT "audit_events_scope_check" CHECK ("audit_events"."scope" in ('cohort','global')),
	CONSTRAINT "audit_events_scope_cohort_check" CHECK (("audit_events"."scope" = 'cohort') = ("audit_events"."cohort_id" is not null)),
	CONSTRAINT "audit_events_verification_method_check" CHECK ("audit_events"."verification_method" is null or "audit_events"."verification_method" in ('id_document','school_channel','other'))
);
--> statement-breakpoint
CREATE TABLE "cohorts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'preparing' NOT NULL,
	"is_default_working" boolean DEFAULT false NOT NULL,
	"is_registration_open" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_kind" text NOT NULL,
	"created_by_user_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" uuid,
	CONSTRAINT "cohorts_code_unique" UNIQUE("code"),
	CONSTRAINT "cohorts_status_check" CHECK ("cohorts"."status" in ('preparing','active','archived')),
	CONSTRAINT "cohorts_created_by_kind_check" CHECK ("cohorts"."created_by_kind" in ('user','system','worker')),
	CONSTRAINT "cohorts_created_by_actor_check" CHECK (("cohorts"."created_by_kind" = 'user') = ("cohorts"."created_by_user_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "domain_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"scope" text NOT NULL,
	"cohort_id" uuid,
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"source_version" integer,
	"actor_kind" text NOT NULL,
	"actor_user_id" uuid,
	"occurred_real_at" timestamp with time zone NOT NULL,
	"occurred_business_at" timestamp with time zone NOT NULL,
	"recipients" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"recipient_basis" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "domain_events_scope_check" CHECK ("domain_events"."scope" in ('cohort','global')),
	CONSTRAINT "domain_events_scope_cohort_check" CHECK (("domain_events"."scope" = 'cohort') = ("domain_events"."cohort_id" is not null)),
	CONSTRAINT "domain_events_actor_kind_check" CHECK ("domain_events"."actor_kind" in ('user','system','worker')),
	CONSTRAINT "domain_events_actor_check" CHECK (("domain_events"."actor_kind" = 'user') = ("domain_events"."actor_user_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "due_work" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"deadline_version" integer DEFAULT 1 NOT NULL,
	"due_business_at" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"done_at" timestamp with time zone,
	"result_ref" jsonb,
	"last_error" text,
	CONSTRAINT "due_work_identity" UNIQUE("kind","subject_type","subject_id","deadline_version"),
	CONSTRAINT "due_work_kind_check" CHECK ("due_work"."kind" in ('proposal_expiry','deadline_snapshot','snapshot_reconcile','overdue_digest','stage_end_unassigned','file_gc','receipt_purge','test_noop')),
	CONSTRAINT "due_work_state_check" CHECK ("due_work"."state" in ('pending','done','cancelled','failed'))
);
--> statement-breakpoint
CREATE TABLE "event_projections" (
	"event_id" uuid NOT NULL,
	"consumer" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"claimed_at" timestamp with time zone,
	"done_at" timestamp with time zone,
	"last_error" text,
	CONSTRAINT "event_projections_pkey" PRIMARY KEY("event_id","consumer"),
	CONSTRAINT "event_projections_consumer_check" CHECK ("event_projections"."consumer" in ('notifications','digest','showcase')),
	CONSTRAINT "event_projections_state_check" CHECK ("event_projections"."state" in ('pending','done','failed'))
);
--> statement-breakpoint
CREATE TABLE "operation_records" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"operation_kind" text NOT NULL,
	"request_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"state" text NOT NULL,
	"result_ref" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"receipt" jsonb,
	"scope" text NOT NULL,
	"cohort_id" uuid,
	"committed_real_at" timestamp with time zone NOT NULL,
	"receipt_expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "operation_records_dedupe_key" UNIQUE("actor_user_id","operation_kind","request_id"),
	CONSTRAINT "operation_records_state_check" CHECK ("operation_records"."state" in ('committed','failed')),
	CONSTRAINT "operation_records_scope_check" CHECK ("operation_records"."scope" in ('cohort','global')),
	CONSTRAINT "operation_records_scope_cohort_check" CHECK (("operation_records"."scope" = 'cohort') = ("operation_records"."cohort_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "schema_meta" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_cohort_id_cohorts_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "public"."cohorts"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "cohorts" ADD CONSTRAINT "cohorts_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "cohorts" ADD CONSTRAINT "cohorts_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_cohort_id_cohorts_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "public"."cohorts"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "event_projections" ADD CONSTRAINT "event_projections_event_id_domain_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."domain_events"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "operation_records" ADD CONSTRAINT "operation_records_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "operation_records" ADD CONSTRAINT "operation_records_cohort_id_cohorts_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "public"."cohorts"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE INDEX "accounts_userId_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_userId_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "users_status_idx" ON "users" USING btree ("status");--> statement-breakpoint
CREATE INDEX "verifications_identifier_idx" ON "verifications" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "audit_events_target_idx" ON "audit_events" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "audit_events_cohort_real_at_idx" ON "audit_events" USING btree ("cohort_id","real_at");--> statement-breakpoint
CREATE INDEX "audit_events_actor_real_at_idx" ON "audit_events" USING btree ("actor_user_id","real_at");--> statement-breakpoint
CREATE UNIQUE INDEX "cohorts_one_default_working" ON "cohorts" USING btree ("is_default_working") WHERE "cohorts"."is_default_working";--> statement-breakpoint
CREATE UNIQUE INDEX "cohorts_one_registration_open" ON "cohorts" USING btree ("is_registration_open") WHERE "cohorts"."is_registration_open";--> statement-breakpoint
CREATE INDEX "domain_events_occurred_real_at_idx" ON "domain_events" USING btree ("occurred_real_at");--> statement-breakpoint
CREATE INDEX "domain_events_source_idx" ON "domain_events" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "due_work_state_due_idx" ON "due_work" USING btree ("state","due_business_at");--> statement-breakpoint
CREATE INDEX "due_work_state_next_attempt_idx" ON "due_work" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE INDEX "event_projections_state_event_idx" ON "event_projections" USING btree ("state","event_id");