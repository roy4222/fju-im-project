ALTER TABLE "evaluations" ADD COLUMN "comment" text;--> statement-breakpoint
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_comment_length_check" CHECK ("evaluations"."comment" is null or char_length("evaluations"."comment") <= 500);

-- B 階段 A-01（TE-B4）：老師評語。`evaluations` 不可變（只允許 insert），評語跟分數同一次暫存／送出寫入、隨列帶；
-- 舊列是 null。最多 500 字（空字串由用例存成 null）。insert 權限是整表，不用補欄級 GRANT。0000–0017 一字不動。
