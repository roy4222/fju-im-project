ALTER TABLE "group_proposals" DROP CONSTRAINT "group_proposals_admin_voided_reason_check";--> statement-breakpoint
ALTER TABLE "groups" DROP CONSTRAINT "groups_dissolved_check";--> statement-breakpoint
ALTER TABLE "advisor_assignments" DROP CONSTRAINT "advisor_assignments_admin_reason_check";--> statement-breakpoint
ALTER TABLE "advisor_assignments" DROP CONSTRAINT "advisor_assignments_ended_check";--> statement-breakpoint
ALTER TABLE "opportunity_links" DROP CONSTRAINT "opportunity_links_ended_check";--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "bio" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "skills" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "group_proposals" ADD COLUMN "opportunity_id" uuid;--> statement-breakpoint
ALTER TABLE "opportunity_links" ADD COLUMN "state" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "group_proposals" ADD CONSTRAINT "group_proposals_opportunity_id_industry_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."industry_opportunities"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_bio_length_check" CHECK (length("user_profiles"."bio") <= 50);--> statement-breakpoint
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_skills_array_check" CHECK (jsonb_typeof("user_profiles"."skills") = 'array');--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_dissolved_check" CHECK (("groups"."status" = 'dissolved') = ("groups"."dissolved_real_at" is not null));--> statement-breakpoint
ALTER TABLE "advisor_assignments" ADD CONSTRAINT "advisor_assignments_ended_check" CHECK (("advisor_assignments"."valid_to" is null) = ("advisor_assignments"."ended_real_at" is null)
          and ("advisor_assignments"."valid_to" is null or "advisor_assignments"."ended_by_user_id" is not null));--> statement-breakpoint
ALTER TABLE "opportunity_links" ADD CONSTRAINT "opportunity_links_state_check" CHECK ("opportunity_links"."state" in ('pending','active'));--> statement-breakpoint
ALTER TABLE "opportunity_links" ADD CONSTRAINT "opportunity_links_ended_check" CHECK (("opportunity_links"."valid_to" is null) = ("opportunity_links"."ended_real_at" is null)
          and ("opportunity_links"."valid_to" is null or "opportunity_links"."ended_by_user_id" is not null));--> statement-breakpoint

-- C 階段 C3-01（規格③ 設計方案 §10.1，③-1）：名片欄位、分組理由放寬、產學確認欄位。
--
-- - `user_profiles` 加 `bio`（≤50 字）、`skills`（jsonb 字串陣列）；矩陣是 update "all"，不用補權限。
-- - 理由改選填：拿掉 `advisor_assignments_admin_reason_check`、`group_proposals_admin_voided_reason_check`；
--   `advisor_assignments_ended_check`、`opportunity_links_ended_check` 只要求結束列有 `ended_by_user_id`，
--   `groups_dissolved_check` 只綁 `dissolved_real_at`（同名 DROP 再 ADD，照 0015）。
-- - `opportunity_links.state`（pending／active，既有列為 active）、`group_proposals.opportunity_id`（產學提案選的合作案）。
--   `opportunity_links` 的 update 是欄位清單，`state` 由下面的產生區塊補權限（切片 C3）。
--
-- 不加表；`project_events` 不動（③-2 在 C3-06）。0000–0022 一字不動。

-- >>> 由 scripts/generate-grants.mjs 從 permissions/matrix.json 產生；不要手改 >>>
-- opportunity_links（S06 建）加欄後補的可更新欄；其餘權限照 S06 的產生區塊
GRANT UPDATE (state) ON opportunity_links TO fju_app;
-- <<< 產生區塊結束 <<<
