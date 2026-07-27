ALTER TABLE "deals" ADD COLUMN "project_id" text;--> statement-breakpoint
CREATE INDEX "deals_project_idx" ON "deals" USING btree ("project_id");--> statement-breakpoint
-- FK added by hand: the drizzle schema keeps deals.project_id reference-free to
-- avoid a crm<->projects module cycle (see packages/db/src/schema/crm.ts).
ALTER TABLE "deals" ADD CONSTRAINT "deals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE set null;