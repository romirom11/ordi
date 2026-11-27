ALTER TABLE "comments" ADD COLUMN "via" text;--> statement-breakpoint
ALTER TABLE "external_agents" ADD COLUMN "kind" text DEFAULT 'team' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "external_agents_one_personal_idx" ON "external_agents" USING btree ("owner_user_id") WHERE "external_agents"."kind" = 'personal';