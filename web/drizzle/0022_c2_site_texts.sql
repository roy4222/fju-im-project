CREATE TABLE "site_texts" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" uuid NOT NULL,
	CONSTRAINT "site_texts_key_check" CHECK ("site_texts"."key" in ('footer_contact', 'quick_card_1', 'quick_card_2', 'quick_card_3', 'privacy')),
	CONSTRAINT "site_texts_revision_check" CHECK ("site_texts"."revision" >= 1)
);
--> statement-breakpoint
ALTER TABLE "site_texts" ADD CONSTRAINT "site_texts_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint

-- C 階段 C2-17（規格② 設計方案 §6.5、§10.2）：系辦可在前台直接改的站內文字。
--
-- - 新表 `site_texts`：一個 key 一列（`footer_contact`、`quick_card_1`～`quick_card_3`、`privacy`），
--   `value` 是那一種文字的 JSON（形狀由 `application/site/site-texts.ts` 定），`revision` 樂觀鎖同 `home_settings`。
-- - 沒有列就用程式內預設，所以 seed-demo 不插資料；首頁橫幅仍在 0012 的 `home_settings`。
-- - 權限照 0012 給 `home_settings` 的寫法：`fju_app` SELECT／INSERT／UPDATE，不給 DELETE（只改不刪）。
--
-- 只有新增：空庫升級與已套 0021 的庫走同一條路。0000–0021 一字不動。
-- 下面的產生區塊照 `scripts/generate-grants.mjs` 的格式手寫（切片 C2）；矩陣登錄後 `pnpm -C web db:grants --check` 應一字不差。

-- >>> 由 scripts/generate-grants.mjs 從 permissions/matrix.json 產生；不要手改 >>>
-- 先全部收回，再照矩陣逐項給回去。沒列到的操作就是沒有。
REVOKE ALL ON site_texts
  FROM fju_app, fju_backup;
--> statement-breakpoint

GRANT SELECT ON site_texts TO fju_app;
--> statement-breakpoint

GRANT INSERT ON site_texts TO fju_app;
--> statement-breakpoint

GRANT UPDATE ON site_texts TO fju_app;
--> statement-breakpoint

-- 備份角色讀全庫；唯一能寫的 backup_runs 在 S12 才建（matrix.json 的 backupWrites 記著）。
GRANT pg_read_all_data TO fju_backup;
-- <<< 產生區塊結束 <<<
