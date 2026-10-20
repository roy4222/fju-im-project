ALTER TABLE "project_events" DROP CONSTRAINT "project_events_ends_after_starts_check";--> statement-breakpoint
ALTER TABLE "project_events" DROP CONSTRAINT "project_events_deleted_check";--> statement-breakpoint
-- ③-2 資料搬移：舊的全天活動 ends_at 是 NULL，補成「結束日的次日 00:00」（單日＝開始 + 1 天）；要在加 CHECK 之前。
UPDATE "project_events" SET "ends_at" = "starts_at" + interval '1 day' WHERE "all_day" AND "ends_at" IS NULL;--> statement-breakpoint
ALTER TABLE "project_events" ADD CONSTRAINT "project_events_all_day_end_check" CHECK ("project_events"."all_day" = false or "project_events"."ends_at" is not null);--> statement-breakpoint
ALTER TABLE "project_events" ADD CONSTRAINT "project_events_ends_after_starts_check" CHECK (("project_events"."ends_at" is null) or (not "project_events"."all_day" and "project_events"."ends_at" >= "project_events"."starts_at") or ("project_events"."all_day" and "project_events"."ends_at" > "project_events"."starts_at"));--> statement-breakpoint
ALTER TABLE "project_events" ADD CONSTRAINT "project_events_deleted_check" CHECK (("project_events"."deleted_at" is null) = ("project_events"."deleted_by_user_id" is null));