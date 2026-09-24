CREATE TABLE "evaluation_status" (
	"evaluation_id" uuid PRIMARY KEY NOT NULL,
	"assignment_id" uuid NOT NULL,
	"state" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" uuid,
	CONSTRAINT "evaluation_status_state_check" CHECK ("evaluation_status"."state" in ('draft','counted','historical','returned','invalidated')),
	CONSTRAINT "evaluation_status_revision_check" CHECK ("evaluation_status"."revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE "evaluation_status_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"evaluation_id" uuid NOT NULL,
	"from_state" text,
	"to_state" text NOT NULL,
	"reason" text,
	"actor_kind" text NOT NULL,
	"actor_user_id" uuid,
	"real_at" timestamp with time zone NOT NULL,
	CONSTRAINT "evaluation_status_events_state_check" CHECK ("evaluation_status_events"."to_state" in ('draft','counted','historical','returned','invalidated') and ("evaluation_status_events"."from_state" is null or "evaluation_status_events"."from_state" in ('draft','counted','historical','returned','invalidated'))),
	CONSTRAINT "evaluation_status_events_returned_reason_check" CHECK ("evaluation_status_events"."to_state" <> 'returned' or length(btrim(coalesce("evaluation_status_events"."reason", ''))) > 0),
	CONSTRAINT "evaluation_status_events_actor_kind_check" CHECK ("evaluation_status_events"."actor_kind" in ('user','system','worker')),
	CONSTRAINT "evaluation_status_events_actor_check" CHECK (("evaluation_status_events"."actor_kind" = 'user') = ("evaluation_status_events"."actor_user_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "evaluations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"assignment_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"scheme_version_id" uuid NOT NULL,
	"scores" jsonb NOT NULL,
	"submitted_real_at" timestamp with time zone NOT NULL,
	"submitted_business_at" timestamp with time zone NOT NULL,
	"request_id" uuid NOT NULL,
	CONSTRAINT "evaluations_kind_check" CHECK ("evaluations"."kind" in ('draft','final')),
	CONSTRAINT "evaluations_scores_check" CHECK (jsonb_typeof("evaluations"."scores") = 'object')
);
--> statement-breakpoint
CREATE TABLE "evaluator_assignments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"group_id" uuid NOT NULL,
	"stage_key" text NOT NULL,
	"teacher_user_id" uuid NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone,
	"removal_choice" text,
	"reason" text,
	"assigned_by_user_id" uuid NOT NULL,
	"previous_assignment_id" uuid,
	"ended_real_at" timestamp with time zone,
	"ended_by_user_id" uuid,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evaluator_assignments_stage_key_check" CHECK (length("evaluator_assignments"."stage_key") between 1 and 40),
	CONSTRAINT "evaluator_assignments_removal_choice_check" CHECK ("evaluator_assignments"."removal_choice" in ('keep','replace','add')),
	CONSTRAINT "evaluator_assignments_valid_range_check" CHECK ("evaluator_assignments"."valid_to" is null or "evaluator_assignments"."valid_to" >= "evaluator_assignments"."valid_from"),
	CONSTRAINT "evaluator_assignments_ended_check" CHECK (("evaluator_assignments"."valid_to" is null) = ("evaluator_assignments"."ended_real_at" is null)
          and ("evaluator_assignments"."valid_to" is null or length(btrim(coalesce("evaluator_assignments"."reason", ''))) > 0)
          and ("evaluator_assignments"."removal_choice" is null or "evaluator_assignments"."valid_to" is not null)),
	CONSTRAINT "evaluator_assignments_revision_check" CHECK ("evaluator_assignments"."revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE "grade_overrides" (
	"id" uuid PRIMARY KEY NOT NULL,
	"group_id" uuid NOT NULL,
	"scheme_version_id" uuid NOT NULL,
	"original_value" numeric(10, 4) NOT NULL,
	"new_value" numeric(10, 4) NOT NULL,
	"basis_hash" text NOT NULL,
	"reason" text NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"real_at" timestamp with time zone NOT NULL,
	CONSTRAINT "grade_overrides_reason_check" CHECK (length(btrim("grade_overrides"."reason")) > 0)
);
--> statement-breakpoint
CREATE TABLE "grading_scheme_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"scheme_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"stages" jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"locked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	CONSTRAINT "grading_scheme_versions_no_unique" UNIQUE("scheme_id","version_no"),
	CONSTRAINT "grading_scheme_versions_status_check" CHECK ("grading_scheme_versions"."status" in ('draft','published','locked')),
	CONSTRAINT "grading_scheme_versions_version_no_check" CHECK ("grading_scheme_versions"."version_no" >= 1),
	CONSTRAINT "grading_scheme_versions_stages_check" CHECK (jsonb_typeof("grading_scheme_versions"."stages") = 'array'),
	CONSTRAINT "grading_scheme_versions_locked_at_check" CHECK (("grading_scheme_versions"."status" = 'locked') = ("grading_scheme_versions"."locked_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "grading_schemes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"cohort_id" uuid NOT NULL,
	"name" text NOT NULL,
	"current_version_id" uuid,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_kind" text NOT NULL,
	"created_by_user_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" uuid,
	CONSTRAINT "grading_schemes_cohort_unique" UNIQUE("cohort_id"),
	CONSTRAINT "grading_schemes_name_check" CHECK (length(btrim("grading_schemes"."name")) > 0),
	CONSTRAINT "grading_schemes_revision_check" CHECK ("grading_schemes"."revision" >= 1),
	CONSTRAINT "grading_schemes_created_by_kind_check" CHECK ("grading_schemes"."created_by_kind" in ('user','system','worker')),
	CONSTRAINT "grading_schemes_created_by_actor_check" CHECK (("grading_schemes"."created_by_kind" = 'user') = ("grading_schemes"."created_by_user_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "override_review_state" (
	"override_id" uuid PRIMARY KEY NOT NULL,
	"state" text DEFAULT 'effective' NOT NULL,
	"resolved_by_user_id" uuid,
	"resolved_at" timestamp with time zone,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "override_review_state_state_check" CHECK ("override_review_state"."state" in ('effective','pending_review','superseded')),
	CONSTRAINT "override_review_state_revision_check" CHECK ("override_review_state"."revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE "stage_requirements" (
	"group_id" uuid NOT NULL,
	"stage_key" text NOT NULL,
	"required_count" integer NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" uuid,
	CONSTRAINT "stage_requirements_pk" PRIMARY KEY("group_id","stage_key"),
	CONSTRAINT "stage_requirements_required_count_check" CHECK ("stage_requirements"."required_count" >= 0),
	CONSTRAINT "stage_requirements_stage_key_check" CHECK (length("stage_requirements"."stage_key") between 1 and 40),
	CONSTRAINT "stage_requirements_revision_check" CHECK ("stage_requirements"."revision" >= 1)
);
--> statement-breakpoint
ALTER TABLE "evaluation_status" ADD CONSTRAINT "evaluation_status_evaluation_id_evaluations_id_fk" FOREIGN KEY ("evaluation_id") REFERENCES "public"."evaluations"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "evaluation_status" ADD CONSTRAINT "evaluation_status_assignment_id_evaluator_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."evaluator_assignments"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "evaluation_status" ADD CONSTRAINT "evaluation_status_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "evaluation_status_events" ADD CONSTRAINT "evaluation_status_events_evaluation_id_evaluations_id_fk" FOREIGN KEY ("evaluation_id") REFERENCES "public"."evaluations"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "evaluation_status_events" ADD CONSTRAINT "evaluation_status_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_assignment_id_evaluator_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."evaluator_assignments"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_scheme_version_id_grading_scheme_versions_id_fk" FOREIGN KEY ("scheme_version_id") REFERENCES "public"."grading_scheme_versions"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "evaluator_assignments" ADD CONSTRAINT "evaluator_assignments_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "evaluator_assignments" ADD CONSTRAINT "evaluator_assignments_teacher_user_id_users_id_fk" FOREIGN KEY ("teacher_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "evaluator_assignments" ADD CONSTRAINT "evaluator_assignments_assigned_by_user_id_users_id_fk" FOREIGN KEY ("assigned_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "evaluator_assignments" ADD CONSTRAINT "evaluator_assignments_previous_assignment_id_evaluator_assignments_id_fk" FOREIGN KEY ("previous_assignment_id") REFERENCES "public"."evaluator_assignments"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "evaluator_assignments" ADD CONSTRAINT "evaluator_assignments_ended_by_user_id_users_id_fk" FOREIGN KEY ("ended_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "grade_overrides" ADD CONSTRAINT "grade_overrides_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "grade_overrides" ADD CONSTRAINT "grade_overrides_scheme_version_id_grading_scheme_versions_id_fk" FOREIGN KEY ("scheme_version_id") REFERENCES "public"."grading_scheme_versions"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "grade_overrides" ADD CONSTRAINT "grade_overrides_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "grading_scheme_versions" ADD CONSTRAINT "grading_scheme_versions_scheme_id_grading_schemes_id_fk" FOREIGN KEY ("scheme_id") REFERENCES "public"."grading_schemes"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "grading_scheme_versions" ADD CONSTRAINT "grading_scheme_versions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "grading_schemes" ADD CONSTRAINT "grading_schemes_cohort_id_cohorts_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "public"."cohorts"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "grading_schemes" ADD CONSTRAINT "grading_schemes_current_version_id_grading_scheme_versions_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."grading_scheme_versions"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "grading_schemes" ADD CONSTRAINT "grading_schemes_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "grading_schemes" ADD CONSTRAINT "grading_schemes_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "override_review_state" ADD CONSTRAINT "override_review_state_override_id_grade_overrides_id_fk" FOREIGN KEY ("override_id") REFERENCES "public"."grade_overrides"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "override_review_state" ADD CONSTRAINT "override_review_state_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "stage_requirements" ADD CONSTRAINT "stage_requirements_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "stage_requirements" ADD CONSTRAINT "stage_requirements_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "stage_requirements" ADD CONSTRAINT "stage_requirements_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE UNIQUE INDEX "evaluation_status_one_counted" ON "evaluation_status" USING btree ("assignment_id") WHERE "evaluation_status"."state" = 'counted';--> statement-breakpoint
CREATE INDEX "evaluation_status_assignment_idx" ON "evaluation_status" USING btree ("assignment_id");--> statement-breakpoint
CREATE INDEX "evaluation_status_events_evaluation_idx" ON "evaluation_status_events" USING btree ("evaluation_id","real_at");--> statement-breakpoint
CREATE INDEX "evaluations_assignment_idx" ON "evaluations" USING btree ("assignment_id","submitted_real_at");--> statement-breakpoint
CREATE UNIQUE INDEX "evaluator_assignments_one_active" ON "evaluator_assignments" USING btree ("group_id","stage_key","teacher_user_id") WHERE "evaluator_assignments"."valid_to" is null;--> statement-breakpoint
CREATE INDEX "evaluator_assignments_group_idx" ON "evaluator_assignments" USING btree ("group_id","stage_key");--> statement-breakpoint
CREATE INDEX "evaluator_assignments_teacher_active_idx" ON "evaluator_assignments" USING btree ("teacher_user_id") WHERE "evaluator_assignments"."valid_to" is null;--> statement-breakpoint
CREATE INDEX "grade_overrides_group_idx" ON "grade_overrides" USING btree ("group_id","real_at");--> statement-breakpoint

-- 票 23（S10）：評分方案、指派與老師評分——模組 06 附錄 A 的九張表：評分方案頭列（`grading_schemes`）、
-- 方案版本（`grading_scheme_versions`）、每組每階段要求份數（`stage_requirements`）、評分老師指派
-- （`evaluator_assignments`）、老師輸入（`evaluations`）、評分狀態頭列與狀態紀錄（`evaluation_status`、
-- `evaluation_status_events`）、最終結果更正與復核狀態（`grade_overrides`、`override_review_state`）。
-- 票 24（成績表、退回、更正、改派三選一、匯出）在開發計畫標「改資料庫結構：否」，所以九張在這一支一次建好。
--
-- 只新增表，舊表舊資料一欄都不動，所以空庫升級與現有資料升版走同一條路。0000–0008 的產生區塊不動
-- （已部署的 migration 不能改）。
--
-- 下面的 GRANT 不是手寫的：由 web/src/infrastructure/db/permissions/matrix.json 中 slice 為 S10 的列，
-- 經 `pnpm -C web db:grants --write` 產生，CI 用 `--check` 核對。產生區塊之後是手寫的三個 trigger
-- （方案版本只前進、評分狀態只走規定的轉換、結束的指派不能復活）：產生器只會做「整張不可變」，
-- 這三張是「部分可改」，規則要自己寫。

-- >>> 由 scripts/generate-grants.mjs 從 permissions/matrix.json 產生；不要手改 >>>
-- 先全部收回，再照矩陣逐項給回去。沒列到的操作就是沒有。
REVOKE ALL ON grading_schemes, grading_scheme_versions, stage_requirements, evaluator_assignments, evaluations, evaluation_status, evaluation_status_events, grade_overrides, override_review_state
  FROM fju_app, fju_backup;
--> statement-breakpoint

GRANT SELECT ON grading_schemes, grading_scheme_versions, stage_requirements, evaluator_assignments, evaluations, evaluation_status, evaluation_status_events, grade_overrides, override_review_state TO fju_app;
--> statement-breakpoint

GRANT INSERT ON grading_schemes, grading_scheme_versions, stage_requirements, evaluator_assignments, evaluations, evaluation_status, evaluation_status_events, grade_overrides, override_review_state TO fju_app;
--> statement-breakpoint

-- 評分方案頭列（一屆一個）：只改名稱、目前版本與通用欄；屆別寫了就不動，不刪列
GRANT UPDATE (name, current_version_id, revision, updated_at, updated_by_user_id) ON grading_schemes TO fju_app;
--> statement-breakpoint

-- 方案版本：內容不可變，只改狀態與鎖定時間（trigger 另擋內容變更與狀態倒退）
GRANT UPDATE (status, locked_at) ON grading_scheme_versions TO fju_app;
--> statement-breakpoint

-- 每組每階段要求份數：只改份數與通用欄；組別與階段寫了就不動，不刪列
GRANT UPDATE (required_count, revision, updated_at, updated_by_user_id) ON stage_requirements TO fju_app;
--> statement-breakpoint

-- 評分指派有效區間列：只更新結束欄（移除、改派）與通用欄
GRANT UPDATE (valid_to, removal_choice, reason, ended_real_at, ended_by_user_id, revision, updated_at) ON evaluator_assignments TO fju_app;
--> statement-breakpoint

-- 評分狀態頭列：只改狀態與通用欄（trigger 另擋不合規的轉換）
GRANT UPDATE (state, revision, updated_at, updated_by_user_id) ON evaluation_status TO fju_app;
--> statement-breakpoint

-- 更正的復核狀態頭列：只改狀態、處理人、處理時間與通用欄
GRANT UPDATE (state, resolved_by_user_id, resolved_at, revision, updated_at) ON override_review_state TO fju_app;
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

DROP TRIGGER IF EXISTS evaluations_immutable_row ON evaluations;
--> statement-breakpoint

CREATE TRIGGER evaluations_immutable_row
  BEFORE UPDATE OR DELETE ON evaluations
  FOR EACH ROW EXECUTE FUNCTION fju_reject_mutation();
--> statement-breakpoint

DROP TRIGGER IF EXISTS evaluations_immutable_truncate ON evaluations;
--> statement-breakpoint

CREATE TRIGGER evaluations_immutable_truncate
  BEFORE TRUNCATE ON evaluations
  FOR EACH STATEMENT EXECUTE FUNCTION fju_reject_mutation();
--> statement-breakpoint

DROP TRIGGER IF EXISTS evaluation_status_events_immutable_row ON evaluation_status_events;
--> statement-breakpoint

CREATE TRIGGER evaluation_status_events_immutable_row
  BEFORE UPDATE OR DELETE ON evaluation_status_events
  FOR EACH ROW EXECUTE FUNCTION fju_reject_mutation();
--> statement-breakpoint

DROP TRIGGER IF EXISTS evaluation_status_events_immutable_truncate ON evaluation_status_events;
--> statement-breakpoint

CREATE TRIGGER evaluation_status_events_immutable_truncate
  BEFORE TRUNCATE ON evaluation_status_events
  FOR EACH STATEMENT EXECUTE FUNCTION fju_reject_mutation();
--> statement-breakpoint

DROP TRIGGER IF EXISTS grade_overrides_immutable_row ON grade_overrides;
--> statement-breakpoint

CREATE TRIGGER grade_overrides_immutable_row
  BEFORE UPDATE OR DELETE ON grade_overrides
  FOR EACH ROW EXECUTE FUNCTION fju_reject_mutation();
--> statement-breakpoint

DROP TRIGGER IF EXISTS grade_overrides_immutable_truncate ON grade_overrides;
--> statement-breakpoint

CREATE TRIGGER grade_overrides_immutable_truncate
  BEFORE TRUNCATE ON grade_overrides
  FOR EACH STATEMENT EXECUTE FUNCTION fju_reject_mutation();
-- <<< 產生區塊結束 <<<
--> statement-breakpoint

-- 方案版本：內容（階段、項目、權重、滿分）寫了就不能改，改結構要建新版本；狀態只前進
-- draft → published → locked，鎖定時間鎖了就不動；不能刪（模組 06 §3、契約 01 §5「狀態欄只前進」）。
-- 欄級 GRANT 已經只給 fju_app 改 status／locked_at；這個 trigger 連 owner 也擋，並補上「只前進」。
CREATE OR REPLACE FUNCTION fju_grading_scheme_versions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  old_rank int := array_position(ARRAY['draft','published','locked'], OLD.status::text);
  new_rank int := array_position(ARRAY['draft','published','locked'], NEW.status::text);
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.scheme_id IS DISTINCT FROM OLD.scheme_id
     OR NEW.version_no IS DISTINCT FROM OLD.version_no
     OR NEW.stages IS DISTINCT FROM OLD.stages
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id THEN
    RAISE EXCEPTION '評分方案版本的內容寫了就不能改；要改結構請建立新版本（模組 06 §3）'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF new_rank < old_rank THEN
    RAISE EXCEPTION '評分方案版本的狀態只能往前走（% → % 被拒）', OLD.status, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'locked' AND NEW.locked_at IS DISTINCT FROM OLD.locked_at THEN
    RAISE EXCEPTION '評分方案版本已鎖定，鎖定時間不能改'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS grading_scheme_versions_guard ON grading_scheme_versions;
--> statement-breakpoint

CREATE TRIGGER grading_scheme_versions_guard
  BEFORE UPDATE ON grading_scheme_versions
  FOR EACH ROW EXECUTE FUNCTION fju_grading_scheme_versions_guard();
--> statement-breakpoint

DROP TRIGGER IF EXISTS grading_scheme_versions_no_delete ON grading_scheme_versions;
--> statement-breakpoint

CREATE TRIGGER grading_scheme_versions_no_delete
  BEFORE DELETE ON grading_scheme_versions
  FOR EACH ROW EXECUTE FUNCTION fju_reject_mutation();
--> statement-breakpoint

DROP TRIGGER IF EXISTS grading_scheme_versions_no_truncate ON grading_scheme_versions;
--> statement-breakpoint

CREATE TRIGGER grading_scheme_versions_no_truncate
  BEFORE TRUNCATE ON grading_scheme_versions
  FOR EACH STATEMENT EXECUTE FUNCTION fju_reject_mutation();
--> statement-breakpoint

-- 評分狀態頭列：新建時只能是「暫存」或「採計」，而且要和那筆老師輸入的種類與指派對得上
-- （draft 輸入 → draft、final 輸入 → counted）；之後只允許規定的轉換——
-- 暫存 → 失效／歷史，採計 → 退回／歷史。正式送出的評分不會回到暫存，退回、歷史、失效是終點
-- （要重評就是新的一筆正式輸入）。評分、指派兩個指向寫了就不動；不能刪（模組 06 §3、母 spec §4.7）。
CREATE OR REPLACE FUNCTION fju_evaluation_status_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  source_kind text;
  source_assignment uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT e.kind, e.assignment_id INTO source_kind, source_assignment
      FROM evaluations e WHERE e.id = NEW.evaluation_id;
    IF source_assignment IS DISTINCT FROM NEW.assignment_id THEN
      RAISE EXCEPTION '評分狀態的指派要和那筆老師輸入一致'
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NOT ((source_kind = 'draft' AND NEW.state = 'draft') OR (source_kind = 'final' AND NEW.state = 'counted')) THEN
      RAISE EXCEPTION '評分狀態新建時只能是暫存（對暫存輸入）或採計（對正式輸入），收到 %／%', source_kind, NEW.state
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.evaluation_id IS DISTINCT FROM OLD.evaluation_id OR NEW.assignment_id IS DISTINCT FROM OLD.assignment_id THEN
    RAISE EXCEPTION '評分狀態指向的評分與指派不能改'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
       (OLD.state = 'draft' AND NEW.state IN ('invalidated', 'historical'))
    OR (OLD.state = 'counted' AND NEW.state IN ('returned', 'historical'))
  ) THEN
    RAISE EXCEPTION '評分狀態不能從 % 改成 %（正式送出的評分不可改；要重評由管理員退回後重新送出）', OLD.state, NEW.state
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS evaluation_status_guard ON evaluation_status;
--> statement-breakpoint

CREATE TRIGGER evaluation_status_guard
  BEFORE INSERT OR UPDATE ON evaluation_status
  FOR EACH ROW EXECUTE FUNCTION fju_evaluation_status_guard();
--> statement-breakpoint

DROP TRIGGER IF EXISTS evaluation_status_no_delete ON evaluation_status;
--> statement-breakpoint

CREATE TRIGGER evaluation_status_no_delete
  BEFORE DELETE ON evaluation_status
  FOR EACH ROW EXECUTE FUNCTION fju_reject_mutation();
--> statement-breakpoint

DROP TRIGGER IF EXISTS evaluation_status_no_truncate ON evaluation_status;
--> statement-breakpoint

CREATE TRIGGER evaluation_status_no_truncate
  BEFORE TRUNCATE ON evaluation_status
  FOR EACH STATEMENT EXECUTE FUNCTION fju_reject_mutation();
--> statement-breakpoint

-- 評分指派：組別、階段、老師、起始時間寫了就不動；結束了就不能復活（重新指派同一位老師是插一列新的，
-- 舊指派與它底下失效的暫存不會回來——產品 7.4「先前失效的草稿不自動復活」）。不能刪。
CREATE OR REPLACE FUNCTION fju_evaluator_assignments_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.group_id IS DISTINCT FROM OLD.group_id
     OR NEW.stage_key IS DISTINCT FROM OLD.stage_key
     OR NEW.teacher_user_id IS DISTINCT FROM OLD.teacher_user_id
     OR NEW.valid_from IS DISTINCT FROM OLD.valid_from
     OR NEW.assigned_by_user_id IS DISTINCT FROM OLD.assigned_by_user_id THEN
    RAISE EXCEPTION '評分指派的組別、階段、老師與起始時間寫了就不能改'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.valid_to IS NOT NULL AND (
       NEW.valid_to IS DISTINCT FROM OLD.valid_to
    OR NEW.ended_real_at IS DISTINCT FROM OLD.ended_real_at
    OR NEW.ended_by_user_id IS DISTINCT FROM OLD.ended_by_user_id
    OR NEW.removal_choice IS DISTINCT FROM OLD.removal_choice
    OR NEW.reason IS DISTINCT FROM OLD.reason
  ) THEN
    RAISE EXCEPTION '已結束的評分指派不能改或復活；要再指派請新增一筆'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS evaluator_assignments_guard ON evaluator_assignments;
--> statement-breakpoint

CREATE TRIGGER evaluator_assignments_guard
  BEFORE UPDATE ON evaluator_assignments
  FOR EACH ROW EXECUTE FUNCTION fju_evaluator_assignments_guard();
--> statement-breakpoint

DROP TRIGGER IF EXISTS evaluator_assignments_no_delete ON evaluator_assignments;
--> statement-breakpoint

CREATE TRIGGER evaluator_assignments_no_delete
  BEFORE DELETE ON evaluator_assignments
  FOR EACH ROW EXECUTE FUNCTION fju_reject_mutation();
--> statement-breakpoint

DROP TRIGGER IF EXISTS evaluator_assignments_no_truncate ON evaluator_assignments;
--> statement-breakpoint

CREATE TRIGGER evaluator_assignments_no_truncate
  BEFORE TRUNCATE ON evaluator_assignments
  FOR EACH STATEMENT EXECUTE FUNCTION fju_reject_mutation();
