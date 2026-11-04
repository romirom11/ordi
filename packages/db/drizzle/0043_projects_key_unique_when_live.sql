ALTER TABLE "projects" DROP CONSTRAINT "projects_key_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "projects_key_live_idx" ON "projects" USING btree ("key") WHERE deleted_at is null;