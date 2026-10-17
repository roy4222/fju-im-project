ALTER TABLE "managed_items" ADD COLUMN "rules_position" integer;--> statement-breakpoint
CREATE INDEX "managed_items_rules_position_idx" ON "managed_items" USING btree ("cohort_id","rules_position") WHERE "managed_items"."placement" = 'rules' and "managed_items"."deleted_at" is null;--> statement-breakpoint
-- B 階段 A-14（Q198）：規則章節排序。回填按屆別各自從 1 編號，順序同遷移前前台 `/rules`（實際開放時間、id），
-- 跟 `moveRule` 的鄰居集合一致（同屆、placement rules、未刪除，含草稿與已下架）。0000–0018 一字不動。
update managed_items m set rules_position = x.rn from (select id, row_number() over (partition by cohort_id order by actual_opened_at asc nulls last, id asc) rn from managed_items where placement='rules' and deleted_at is null) x where x.id = m.id;
