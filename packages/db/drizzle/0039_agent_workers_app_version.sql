-- agent_workers.version holds the ordi version string the worker runs ("1.33.0"),
-- not the optimistic-locking counter - but the bump trigger attaches to every
-- column named `version`, and `'1.33.0' + 1` failed every heartbeat after the
-- first. Rename the column and drop the trigger that a previous start attached;
-- triggers.sql no longer visits this table once the column is gone.
ALTER TABLE "agent_workers" RENAME COLUMN "version" TO "app_version";--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_bump_version" ON "agent_workers";
