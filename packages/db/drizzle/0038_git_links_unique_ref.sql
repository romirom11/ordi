DELETE FROM "git_links" a USING "git_links" b WHERE a."task_id" = b."task_id" AND a."type" = b."type" AND a."external_ref" = b."external_ref" AND a."id" > b."id";--> statement-breakpoint
DROP INDEX "git_links_task_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "git_links_task_ref_idx" ON "git_links" USING btree ("task_id","type","external_ref");
