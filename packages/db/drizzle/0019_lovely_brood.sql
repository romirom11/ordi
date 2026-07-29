CREATE TABLE "sales_message_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"activity_type" text NOT NULL,
	"channel" text,
	"subject" text,
	"body" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sales_sequence_enrollments" (
	"id" text PRIMARY KEY NOT NULL,
	"sequence_id" text NOT NULL,
	"lead_id" text,
	"deal_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"current_step_position" integer DEFAULT 0 NOT NULL,
	"owner_id" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"stopped_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "sales_sequence_enrollments_parent_check" CHECK (("sales_sequence_enrollments"."lead_id" is null) <> ("sales_sequence_enrollments"."deal_id" is null))
);
--> statement-breakpoint
CREATE TABLE "sales_sequence_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"sequence_id" text NOT NULL,
	"template_id" text,
	"position" integer NOT NULL,
	"delay_days" integer DEFAULT 0 NOT NULL,
	"activity_type" text NOT NULL,
	"channel" text,
	"subject" text,
	"context" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_sequences" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "sales_activities" ADD COLUMN "message_template_id" text;--> statement-breakpoint
ALTER TABLE "sales_activities" ADD COLUMN "sequence_enrollment_id" text;--> statement-breakpoint
ALTER TABLE "sales_activities" ADD COLUMN "sequence_step_id" text;--> statement-breakpoint
ALTER TABLE "sales_sequence_enrollments" ADD CONSTRAINT "sales_sequence_enrollments_sequence_id_sales_sequences_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "public"."sales_sequences"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_sequence_enrollments" ADD CONSTRAINT "sales_sequence_enrollments_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_sequence_enrollments" ADD CONSTRAINT "sales_sequence_enrollments_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_sequence_enrollments" ADD CONSTRAINT "sales_sequence_enrollments_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_sequence_steps" ADD CONSTRAINT "sales_sequence_steps_sequence_id_sales_sequences_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "public"."sales_sequences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_sequence_steps" ADD CONSTRAINT "sales_sequence_steps_template_id_sales_message_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."sales_message_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sales_message_templates_active_idx" ON "sales_message_templates" USING btree ("active","name");--> statement-breakpoint
CREATE INDEX "sales_sequence_enrollments_sequence_idx" ON "sales_sequence_enrollments" USING btree ("sequence_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_sequence_enrollments_active_lead_idx" ON "sales_sequence_enrollments" USING btree ("lead_id") WHERE "sales_sequence_enrollments"."status" = 'active' and "sales_sequence_enrollments"."lead_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "sales_sequence_enrollments_active_deal_idx" ON "sales_sequence_enrollments" USING btree ("deal_id") WHERE "sales_sequence_enrollments"."status" = 'active' and "sales_sequence_enrollments"."deal_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "sales_sequence_steps_position_idx" ON "sales_sequence_steps" USING btree ("sequence_id","position");--> statement-breakpoint
CREATE INDEX "sales_sequences_active_idx" ON "sales_sequences" USING btree ("active","name");--> statement-breakpoint
ALTER TABLE "sales_activities" ADD CONSTRAINT "sales_activities_message_template_id_sales_message_templates_id_fk" FOREIGN KEY ("message_template_id") REFERENCES "public"."sales_message_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_activities" ADD CONSTRAINT "sales_activities_sequence_enrollment_id_sales_sequence_enrollments_id_fk" FOREIGN KEY ("sequence_enrollment_id") REFERENCES "public"."sales_sequence_enrollments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_activities" ADD CONSTRAINT "sales_activities_sequence_step_id_sales_sequence_steps_id_fk" FOREIGN KEY ("sequence_step_id") REFERENCES "public"."sales_sequence_steps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sales_activities_enrollment_idx" ON "sales_activities" USING btree ("sequence_enrollment_id");