ALTER TABLE "custom_field_definitions" ADD COLUMN "icon" text;--> statement-breakpoint
ALTER TABLE "custom_field_groups" ADD COLUMN "icon" text;--> statement-breakpoint
-- v1.24.0 shipped an employees.telegram column that was replaced by custom
-- fields before anyone stored data in it; upgraded databases drop the orphan,
-- fresh ones no-op.
ALTER TABLE "employees" DROP COLUMN IF EXISTS "telegram";