CREATE TABLE "recurring_payments" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"vendor" text,
	"company_id" text,
	"amount" numeric(14, 2) NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"interval" text NOT NULL,
	"next_date" text NOT NULL,
	"category" text,
	"notes" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"auto_create_expense" boolean DEFAULT false NOT NULL,
	"last_created_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "slack_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"team_name" text DEFAULT '' NOT NULL,
	"bot_token" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"scope" text DEFAULT '' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD COLUMN "invoice_settings" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "recurring_payments" ADD CONSTRAINT "recurring_payments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recurring_payments_active_idx" ON "recurring_payments" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "recurring_payments_next_date_idx" ON "recurring_payments" USING btree ("next_date");