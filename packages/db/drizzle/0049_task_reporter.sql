ALTER TABLE "tasks" ADD COLUMN "reporter_id" text;--> statement-breakpoint
-- Existing tasks: whoever created the row set it, as far as anyone can tell.
-- Before the index, so the backfill does not update it row by row.
UPDATE "tasks" SET "reporter_id" = "created_by" WHERE "reporter_id" IS NULL AND "created_by" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "tasks_reporter_idx" ON "tasks" USING btree ("reporter_id");
