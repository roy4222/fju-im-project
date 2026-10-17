CREATE TABLE "grade_settlements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"cohort_id" uuid NOT NULL,
	"stage_key" text NOT NULL,
	"settled_at" timestamp with time zone NOT NULL,
	"settled_by_user_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"counted_evaluations" integer NOT NULL,
	"released_at" timestamp with time zone,
	"released_by_user_id" uuid,
	"release_reason" text,
	"request_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grade_settlements_reason_check" CHECK (char_length("grade_settlements"."reason") between 1 and 500),
	CONSTRAINT "grade_settlements_counted_check" CHECK ("grade_settlements"."counted_evaluations" >= 0),
	CONSTRAINT "grade_settlements_release_reason_check" CHECK ("grade_settlements"."release_reason" is null or char_length("grade_settlements"."release_reason") between 1 and 500),
	CONSTRAINT "grade_settlements_released_check" CHECK (("grade_settlements"."released_at" is null) = ("grade_settlements"."released_by_user_id" is null) and ("grade_settlements"."released_at" is null) = ("grade_settlements"."release_reason" is null))
);
--> statement-breakpoint
ALTER TABLE "grade_settlements" ADD CONSTRAINT "grade_settlements_cohort_id_cohorts_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "public"."cohorts"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "grade_settlements" ADD CONSTRAINT "grade_settlements_settled_by_user_id_users_id_fk" FOREIGN KEY ("settled_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "grade_settlements" ADD CONSTRAINT "grade_settlements_released_by_user_id_users_id_fk" FOREIGN KEY ("released_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE UNIQUE INDEX "grade_settlements_active_one" ON "grade_settlements" USING btree ("cohort_id","stage_key") WHERE "grade_settlements"."released_at" is null;--> statement-breakpoint
CREATE INDEX "grade_settlements_cohort_idx" ON "grade_settlements" USING btree ("cohort_id","settled_at" DESC NULLS LAST);--> statement-breakpoint

-- B 階段 A-01（TE-B2a）：系辦結算表。
--
-- - `grade_settlements`：一屆一個評分階段一筆現行結算（`released_at is null`，部分唯一 `grade_settlements_active_one`）。
--   解除只填 `released_at`／`released_by_user_id`／`release_reason`（三欄一起填，check 守）；結算列不刪。
-- - 結算期間老師的暫存、送出、重送一律擋（用例在方案頭列鎖內查現行結算）。
--
-- 只新增一張表：空庫升級與已套 0016 的庫走同一條路。0000–0016 一字不動。
-- 新表的權限在下面的產生區塊（切片 B17），由 `pnpm -C web db:grants --write` 產生，CI 用 `--check` 核對。

-- >>> 由 scripts/generate-grants.mjs 從 permissions/matrix.json 產生；不要手改 >>>
-- 先全部收回，再照矩陣逐項給回去。沒列到的操作就是沒有。
REVOKE ALL ON grade_settlements
  FROM fju_app, fju_backup;
--> statement-breakpoint

GRANT SELECT ON grade_settlements TO fju_app;
--> statement-breakpoint

GRANT INSERT ON grade_settlements TO fju_app;
--> statement-breakpoint

-- 系辦結算（B 階段 A-01）：一屆一階段一筆現行結算；解除只填解除三欄，結算列不刪
GRANT UPDATE (released_at, released_by_user_id, release_reason) ON grade_settlements TO fju_app;
--> statement-breakpoint

-- 備份角色讀全庫；唯一能寫的 backup_runs 在 S12 才建（matrix.json 的 backupWrites 記著）。
GRANT pg_read_all_data TO fju_backup;
-- <<< 產生區塊結束 <<<
