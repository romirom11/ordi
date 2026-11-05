ALTER TABLE "intake_items" ADD COLUMN "answers" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "intake_items" ADD COLUMN "submitter_key" text;--> statement-breakpoint
ALTER TABLE "intake_settings" ADD COLUMN "form_config" jsonb;--> statement-breakpoint
CREATE INDEX "intake_submitter_idx" ON "intake_items" USING btree ("submitter_key","created_at");