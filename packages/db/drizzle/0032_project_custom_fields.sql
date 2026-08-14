DROP INDEX "cfd_entity_key_idx";--> statement-breakpoint
ALTER TABLE "custom_field_definitions" ADD COLUMN "project_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "cfd_project_key_idx" ON "custom_field_definitions" USING btree ("entity_type","key","project_id") WHERE project_id is not null;--> statement-breakpoint
CREATE INDEX "cfd_project_idx" ON "custom_field_definitions" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cfd_entity_key_idx" ON "custom_field_definitions" USING btree ("entity_type","key") WHERE project_id is null;