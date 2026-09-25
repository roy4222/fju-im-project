ALTER TABLE "cohort_stages" ADD COLUMN "description" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "managed_items" ADD COLUMN "registration_deadline" date;--> statement-breakpoint
ALTER TABLE "managed_items" ADD COLUMN "event_date" date;--> statement-breakpoint
ALTER TABLE "managed_items" ADD COLUMN "awarded_on" date;--> statement-breakpoint
ALTER TABLE "showcase_entries" ADD COLUMN "award_level" text;--> statement-breakpoint
ALTER TABLE "showcase_entries" ADD COLUMN "award_label" text;--> statement-breakpoint
CREATE INDEX "audit_events_real_at_idx" ON "audit_events" USING btree ("real_at");--> statement-breakpoint
ALTER TABLE "cohort_stages" ADD CONSTRAINT "cohort_stages_description_check" CHECK (length("cohort_stages"."description") <= 200);--> statement-breakpoint
ALTER TABLE "managed_items" ADD CONSTRAINT "managed_items_competition_dates_check" CHECK (("managed_items"."registration_deadline" is null and "managed_items"."event_date" is null) or "managed_items"."placement" = 'news');--> statement-breakpoint
ALTER TABLE "managed_items" ADD CONSTRAINT "managed_items_event_after_deadline_check" CHECK ("managed_items"."event_date" is null or "managed_items"."registration_deadline" is null or "managed_items"."event_date" >= "managed_items"."registration_deadline");--> statement-breakpoint
ALTER TABLE "managed_items" ADD CONSTRAINT "managed_items_awarded_on_check" CHECK ("managed_items"."awarded_on" is null or "managed_items"."placement" = 'honor');--> statement-breakpoint
ALTER TABLE "showcase_entries" ADD CONSTRAINT "showcase_entries_award_level_check" CHECK ("showcase_entries"."award_level" is null or "showcase_entries"."award_level" in ('excellent','merit'));--> statement-breakpoint
ALTER TABLE "showcase_entries" ADD CONSTRAINT "showcase_entries_award_label_check" CHECK ("showcase_entries"."award_label" is null or ("showcase_entries"."award_level" is not null and length("showcase_entries"."award_label") between 1 and 100));--> statement-breakpoint

-- 票 39（#295）：展示與階段補欄位。第五站照原型做畫面時，發現原型有、資料表沒有的欄位（開發計畫第五站規則 3）。
--
-- - `showcase_entries.award_level`／`award_label`：獎項等級（excellent＝優秀專題、merit＝佳作）與獎項全名（原型
--   `ProjectItem.award`／`awardLabel`）。**有等級才出現在公開的「優秀專題」**；沒有等級的已發布作品只在登入後的
--   「歷屆一覽」（產品模組 09 §9.1「歷屆一覽與優秀專題分開」）。預設 NULL＝不在優秀專題，所以 S12 的歷屆補登與
--   一般發布不會自己跑到公開頁。放頭列而不是不可變的 `showcase_versions`：得獎是系上的分類、不是學生授權的內容，
--   改等級不用重新授權、也不用切新版。
-- - `managed_items.registration_deadline`／`event_date`：競賽資訊（公告分類「競賽資訊」）的報名截止與活動日，前台由
--   這兩天推「報名中／決賽／已結束」（原型 `competitionStatus`；狀態不存）。`awarded_on`：榮譽榜的得獎日期，年份篩選
--   用它。三欄都是發布設定（跟 `due_at` 一樣在頭列，不進不可變的 `item_versions`），CHECK 只擋「放錯位置」與
--   「活動日早於截止」。
-- - `cohort_stages.description`：一句話說這階段要做什麼（原型 `Stage.summary`），系辦在時間軸編輯框填、學生時間軸顯示。
-- - `audit_events(real_at)` 索引：操作紀錄頁全部範圍依時間排（#296 審查 P2）。
--
-- 全是新增：新欄都可空或有預設，舊列不用回填，空庫升級與已套 0010 的庫走同一條路。0000–0010 一字不動。
-- `cohort_stages`、`managed_items` 在矩陣是整列 UPDATE（表級權限本來就涵蓋新欄）；`showcase_entries` 是逐欄白名單
-- （權限矩陣該列的 `update` 已含獎項兩欄），所以下面由 `pnpm -C web db:grants --write` 從 matrix.json 的
-- `updateAddedIn.T39` 產生補欄權限，CI 用 `--check` 核對。

-- >>> 由 scripts/generate-grants.mjs 從 permissions/matrix.json 產生；不要手改 >>>
-- showcase_entries（S11 建）加欄後補的可更新欄；其餘權限照 S11 的產生區塊
GRANT UPDATE (award_level, award_label) ON showcase_entries TO fju_app;
-- <<< 產生區塊結束 <<<
