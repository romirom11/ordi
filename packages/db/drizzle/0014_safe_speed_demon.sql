CREATE TABLE "leads" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"contact_id" text,
	"research_batch_id" text,
	"legacy_deal_id" text,
	"title" text NOT NULL,
	"product" text,
	"status" text DEFAULT 'new' NOT NULL,
	"score" integer,
	"signal" text,
	"pain_signal" text,
	"evidence" text,
	"why_fit" text,
	"why_now" text,
	"source_title" text,
	"source_url" text,
	"source_type" text,
	"signal_date" text,
	"source_checked_at" timestamp with time zone,
	"suggested_channel" text,
	"opener" text,
	"caution" text,
	"dimensions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secondary_sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"raw_research" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"nurture_until" text,
	"disqualified_reason" text,
	"owner_id" text,
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "research_batches" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"product" text,
	"product_url" text,
	"target_customer" text,
	"search_scope" text,
	"generated_at" text,
	"verdict" text,
	"patterns" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"outreach_plan" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"limits" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"excluded_candidates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"raw_payload" jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sales_activities" (
	"id" text PRIMARY KEY NOT NULL,
	"lead_id" text,
	"deal_id" text,
	"company_id" text NOT NULL,
	"contact_id" text,
	"type" text NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"channel" text,
	"subject" text,
	"context" text,
	"outcome" text,
	"due_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"owner_id" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "deals" ALTER COLUMN "amount" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "deals" ALTER COLUMN "amount" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "source_lead_id" text;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "lead_id" text;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_research_batch_id_research_batches_id_fk" FOREIGN KEY ("research_batch_id") REFERENCES "public"."research_batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_activities" ADD CONSTRAINT "sales_activities_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_activities" ADD CONSTRAINT "sales_activities_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_activities" ADD CONSTRAINT "sales_activities_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_activities" ADD CONSTRAINT "sales_activities_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_activities" ADD CONSTRAINT "sales_activities_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "leads_company_idx" ON "leads" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "leads_contact_idx" ON "leads" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "leads_owner_idx" ON "leads" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "leads_status_idx" ON "leads" USING btree ("status");--> statement-breakpoint
CREATE INDEX "leads_research_batch_idx" ON "leads" USING btree ("research_batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "leads_legacy_deal_idx" ON "leads" USING btree ("legacy_deal_id");--> statement-breakpoint
CREATE INDEX "sales_activities_lead_idx" ON "sales_activities" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "sales_activities_deal_idx" ON "sales_activities" USING btree ("deal_id");--> statement-breakpoint
CREATE INDEX "sales_activities_company_idx" ON "sales_activities" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "sales_activities_owner_idx" ON "sales_activities" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "sales_activities_due_idx" ON "sales_activities" USING btree ("status","due_at");--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_source_lead_id_leads_id_fk" FOREIGN KEY ("source_lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "deals_source_lead_idx" ON "deals" USING btree ("source_lead_id");--> statement-breakpoint
CREATE INDEX "notes_lead_idx" ON "notes" USING btree ("lead_id");