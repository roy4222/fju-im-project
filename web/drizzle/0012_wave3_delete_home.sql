CREATE TABLE "submission_reopens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"item_id" uuid NOT NULL,
	"receiver_kind" text NOT NULL,
	"receiver_id" uuid NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	CONSTRAINT "submission_reopens_receiver_kind_check" CHECK ("submission_reopens"."receiver_kind" in ('user','group')),
	CONSTRAINT "submission_reopens_reason_check" CHECK (char_length("submission_reopens"."reason") between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "home_settings" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"hero_file_id" uuid,
	"hero_alt" text,
	"tagline_line1" text,
	"tagline_line2" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" uuid NOT NULL,
	CONSTRAINT "home_settings_single_row_check" CHECK ("home_settings"."id" = 1),
	CONSTRAINT "home_settings_hero_alt_check" CHECK ("home_settings"."hero_alt" is null or char_length("home_settings"."hero_alt") between 1 and 120),
	CONSTRAINT "home_settings_tagline_line1_check" CHECK ("home_settings"."tagline_line1" is null or char_length("home_settings"."tagline_line1") between 1 and 40),
	CONSTRAINT "home_settings_tagline_line2_check" CHECK ("home_settings"."tagline_line2" is null or char_length("home_settings"."tagline_line2") between 1 and 120),
	CONSTRAINT "home_settings_revision_check" CHECK ("home_settings"."revision" >= 1)
);
--> statement-breakpoint
ALTER TABLE "project_events" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_events" ADD COLUMN "deleted_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "industry_opportunities" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "industry_opportunities" ADD COLUMN "deleted_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "managed_items" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "managed_items" ADD COLUMN "deleted_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "showcase_entries" ADD COLUMN "home_position" smallint;--> statement-breakpoint
ALTER TABLE "showcase_entries" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "showcase_entries" ADD COLUMN "deleted_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "submission_reopens" ADD CONSTRAINT "submission_reopens_item_id_managed_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."managed_items"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "submission_reopens" ADD CONSTRAINT "submission_reopens_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "home_settings" ADD CONSTRAINT "home_settings_hero_file_id_stored_files_id_fk" FOREIGN KEY ("hero_file_id") REFERENCES "public"."stored_files"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "home_settings" ADD CONSTRAINT "home_settings_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE INDEX "submission_reopens_receiver_idx" ON "submission_reopens" USING btree ("item_id","receiver_kind","receiver_id");--> statement-breakpoint
ALTER TABLE "project_events" ADD CONSTRAINT "project_events_deleted_by_user_id_users_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "industry_opportunities" ADD CONSTRAINT "industry_opportunities_deleted_by_user_id_users_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "managed_items" ADD CONSTRAINT "managed_items_deleted_by_user_id_users_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "showcase_entries" ADD CONSTRAINT "showcase_entries_deleted_by_user_id_users_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "project_events" ADD CONSTRAINT "project_events_deleted_check" CHECK (("project_events"."deleted_at" is null) = ("project_events"."deleted_by_user_id" is null)
          and ("project_events"."deleted_at" is null or "project_events"."status" = 'cancelled'));--> statement-breakpoint
ALTER TABLE "industry_opportunities" ADD CONSTRAINT "industry_opportunities_deleted_check" CHECK (("industry_opportunities"."deleted_at" is null) = ("industry_opportunities"."deleted_by_user_id" is null)
          and ("industry_opportunities"."deleted_at" is null or "industry_opportunities"."status" in ('draft','withdrawn')));--> statement-breakpoint
ALTER TABLE "managed_items" ADD CONSTRAINT "managed_items_deleted_check" CHECK (("managed_items"."deleted_at" is null) = ("managed_items"."deleted_by_user_id" is null)
          and ("managed_items"."deleted_at" is null or "managed_items"."status" in ('draft','archived')));--> statement-breakpoint
ALTER TABLE "showcase_entries" ADD CONSTRAINT "showcase_entries_deleted_check" CHECK (("showcase_entries"."deleted_at" is null) = ("showcase_entries"."deleted_by_user_id" is null)
          and ("showcase_entries"."deleted_at" is null or "showcase_entries"."status" in ('draft','withdrawn')));--> statement-breakpoint
ALTER TABLE "showcase_entries" ADD CONSTRAINT "showcase_entries_home_position_check" CHECK ("showcase_entries"."home_position" is null or "showcase_entries"."home_position" between 1 and 99);--> statement-breakpoint

-- 第三波 W0：資料層一次加好，後面的票（W1 刪除、W2 優秀專題、W3 首頁設定、W10 補交、W11 活動與合作案、
-- W15 輪播順序）只寫用例與畫面，不再改表。
--
-- - 刪除標記 `deleted_at`／`deleted_by_user_id`（`managed_items`、`showcase_entries`、`project_events`、
--   `industry_opportunities`）：刪除＝不實體刪列（這幾張表本來就不給 DELETE、子表外鍵全是 restrict），只記誰在
--   什麼時候刪；沒有恢復。CHECK 守兩件事：時間與刪除者成對；只有「看不到」的狀態能刪（專題事務草稿／已下架、
--   精選與合作案草稿／已下架、活動已取消）。所以被刪的列一定不是發布中，公開查詢不用另加條件。
--   不新增 status 值：`managed_items` 有好幾條 `status = 'draft' or …` 的 CHECK，改 status 會撞。
-- - `showcase_entries.home_position`：首頁輪播順序（1–99，NULL＝沒排、排後面）；跟獎項分開。
-- - `home_settings`：首頁大圖＋兩行標語，固定一列（`id smallint CHECK (id = 1)`，同 `worker_heartbeat`）；
--   還沒存過就沒有列、四個內容欄 NULL 都用程式內預設。大圖沿用 `stored_files.purpose = 'photo'`，
--   不改 `stored_files_purpose_check`、不寫 `file_references`。
-- - `submission_reopens`：截止後讓某個人或某一組補交到 `due_at`；只插不改（不可變）。
--
-- 全是新增：新欄都可空，舊列不用回填，空庫升級與已套 0011 的庫走同一條路。0000–0011 一字不動。
-- `managed_items`、`project_events`、`industry_opportunities` 在矩陣是整列 UPDATE（表級權限本來就涵蓋新欄）；
-- `showcase_entries` 是逐欄白名單，補欄權限記在 matrix.json 的 `updateAddedIn.W0`。兩張新表的權限與舊表補欄
-- 都在下面同一個產生區塊，由 `pnpm -C web db:grants --write` 產生，CI 用 `--check` 核對。

-- >>> 由 scripts/generate-grants.mjs 從 permissions/matrix.json 產生；不要手改 >>>
-- 先全部收回，再照矩陣逐項給回去。沒列到的操作就是沒有。
REVOKE ALL ON submission_reopens, home_settings
  FROM fju_app, fju_backup;
--> statement-breakpoint

GRANT SELECT ON submission_reopens, home_settings TO fju_app;
--> statement-breakpoint

GRANT INSERT ON submission_reopens, home_settings TO fju_app;
--> statement-breakpoint

GRANT UPDATE ON home_settings TO fju_app;
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

DROP TRIGGER IF EXISTS submission_reopens_immutable_row ON submission_reopens;
--> statement-breakpoint

CREATE TRIGGER submission_reopens_immutable_row
  BEFORE UPDATE OR DELETE ON submission_reopens
  FOR EACH ROW EXECUTE FUNCTION fju_reject_mutation();
--> statement-breakpoint

DROP TRIGGER IF EXISTS submission_reopens_immutable_truncate ON submission_reopens;
--> statement-breakpoint

CREATE TRIGGER submission_reopens_immutable_truncate
  BEFORE TRUNCATE ON submission_reopens
  FOR EACH STATEMENT EXECUTE FUNCTION fju_reject_mutation();
--> statement-breakpoint

-- showcase_entries（S11 建）加欄後補的可更新欄；其餘權限照 S11 的產生區塊
GRANT UPDATE (deleted_at, deleted_by_user_id, home_position) ON showcase_entries TO fju_app;
-- <<< 產生區塊結束 <<<
