UPDATE "sales_activities"
SET "due_at" = COALESCE("updated_at", "created_at", now())
WHERE "due_at" IS NULL;--> statement-breakpoint
ALTER TABLE "sales_activities" ALTER COLUMN "due_at" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "companies_domain_idx" ON "companies" USING btree ("domain");--> statement-breakpoint
CREATE INDEX "sales_activities_lead_due_idx" ON "sales_activities" USING btree ("lead_id","status","due_at");--> statement-breakpoint
CREATE INDEX "sales_activities_deal_due_idx" ON "sales_activities" USING btree ("deal_id","status","due_at");
