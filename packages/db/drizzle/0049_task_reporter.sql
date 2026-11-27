ALTER TABLE "tasks" ADD COLUMN "reporter_id" text;--> statement-breakpoint
CREATE INDEX "tasks_reporter_idx" ON "tasks" USING btree ("reporter_id");--> statement-breakpoint
-- Existing tasks: whoever created the row set it, as far as anyone can tell.
UPDATE "tasks" SET "reporter_id" = "created_by" WHERE "reporter_id" IS NULL AND "created_by" IS NOT NULL;
