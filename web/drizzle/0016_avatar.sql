ALTER TABLE "file_references" DROP CONSTRAINT "file_references_ref_type_check";--> statement-breakpoint
ALTER TABLE "stored_files" DROP CONSTRAINT "stored_files_purpose_check";--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "avatar_preset" smallint;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "avatar_file_id" uuid;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_avatar_file_id_stored_files_id_fk" FOREIGN KEY ("avatar_file_id") REFERENCES "public"."stored_files"("id") ON DELETE set null ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "file_references" ADD CONSTRAINT "file_references_ref_type_check" CHECK ("file_references"."ref_type" in ('draft','submission_version','item_attachment','signoff_version','showcase_version','showcase_draft','export','roster_version','avatar'));--> statement-breakpoint
ALTER TABLE "stored_files" ADD CONSTRAINT "stored_files_purpose_check" CHECK ("stored_files"."purpose" in ('submission','attachment','roster_csv','advisor_csv','poster','photo','export','signoff_attachment','avatar'));--> statement-breakpoint
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_avatar_preset_check" CHECK ("user_profiles"."avatar_preset" between 1 and 100);