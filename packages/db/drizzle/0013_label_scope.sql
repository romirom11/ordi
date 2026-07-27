ALTER TABLE "labels" ADD COLUMN "scope" text DEFAULT 'task' NOT NULL;--> statement-breakpoint
CREATE INDEX "labels_scope_idx" ON "labels" USING btree ("scope");--> statement-breakpoint

-- Tasks and projects used to share one label pool, so every task label ("Bug",
-- "Frontend") was offered on projects as well. Split the existing rows into the
-- two vocabularies without losing a single binding.

-- A label that only ever labelled projects belongs to the project vocabulary.
UPDATE "labels" SET "scope" = 'project'
WHERE "id" IN (SELECT "label_id" FROM "project_labels")
  AND "id" NOT IN (SELECT "label_id" FROM "task_labels");--> statement-breakpoint

-- A label used on both sides gets a project-scoped twin that the project
-- bindings move to. The original id stays with the tasks, so task filters,
-- saved views and activity history keep resolving.
-- One row per label, never per binding: a label on two projects gets one twin
-- (SELECT DISTINCT would not collapse them – gen_random_uuid() differs per row).
CREATE TEMP TABLE "label_twins" AS
SELECT l."id" AS "old_id", gen_random_uuid()::text AS "new_id", l."name", l."color"
FROM "labels" l
WHERE l."scope" = 'task'
  AND EXISTS (SELECT 1 FROM "project_labels" pl WHERE pl."label_id" = l."id");--> statement-breakpoint

INSERT INTO "labels" ("id", "name", "color", "scope")
SELECT "new_id", "name", "color", 'project' FROM "label_twins";--> statement-breakpoint

UPDATE "project_labels" pl
SET "label_id" = t."new_id"
FROM "label_twins" t
WHERE pl."label_id" = t."old_id";--> statement-breakpoint

DROP TABLE "label_twins";
