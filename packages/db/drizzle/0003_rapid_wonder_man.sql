ALTER TABLE "project_types" ADD COLUMN "requires_client" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "project_types" ADD COLUMN "revenue_source" text DEFAULT 'client_billing' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_types" ADD COLUMN "is_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "project_types" ADD COLUMN "position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
INSERT INTO "project_types" ("id", "name", "icon", "color", "requires_client", "revenue_source", "is_default", "position")
SELECT 'PTYPE0000000CLIENTWORK0000', 'Client work', 'briefcase', '#6366f1', true, 'client_billing', true, 0
WHERE NOT EXISTS (SELECT 1 FROM "project_types" WHERE "name" = 'Client work');--> statement-breakpoint
INSERT INTO "project_types" ("id", "name", "icon", "color", "requires_client", "revenue_source", "is_default", "position")
SELECT 'PTYPE0000000INTERNAL000000', 'Internal', 'wrench', '#64748b', false, 'none', false, 1
WHERE NOT EXISTS (SELECT 1 FROM "project_types" WHERE "name" = 'Internal');--> statement-breakpoint
INSERT INTO "project_types" ("id", "name", "icon", "color", "requires_client", "revenue_source", "is_default", "position")
SELECT 'PTYPE0000000PRODUCT0000000', 'Product', 'rocket', '#10b981', false, 'direct', false, 2
WHERE NOT EXISTS (SELECT 1 FROM "project_types" WHERE "name" = 'Product');--> statement-breakpoint
UPDATE "projects" SET "project_type_id" = (SELECT "id" FROM "project_types" WHERE "name" = 'Client work' LIMIT 1)
WHERE "project_type_id" IS NULL AND "kind" = 'client';--> statement-breakpoint
UPDATE "projects" SET "project_type_id" = (SELECT "id" FROM "project_types" WHERE "name" = 'Internal' LIMIT 1)
WHERE "project_type_id" IS NULL AND "kind" = 'internal';--> statement-breakpoint
UPDATE "projects" SET "project_type_id" = (SELECT "id" FROM "project_types" ORDER BY "position" LIMIT 1)
WHERE "project_type_id" IS NULL;--> statement-breakpoint
DROP INDEX "projects_kind_idx";--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "project_type_id" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "projects_type_idx" ON "projects" USING btree ("project_type_id");--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "kind";
