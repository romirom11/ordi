CREATE TABLE "custom_field_group_grants" (
	"group_id" text NOT NULL,
	"principal" text NOT NULL,
	"level" text NOT NULL,
	CONSTRAINT "custom_field_group_grants_group_id_principal_pk" PRIMARY KEY("group_id","principal")
);
--> statement-breakpoint
CREATE TABLE "custom_field_groups" (
	"id" text PRIMARY KEY NOT NULL,
	"entity_type" text NOT NULL,
	"name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "custom_field_definitions" ADD COLUMN "group_id" text;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "questionnaire_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "custom_field_group_grants" ADD CONSTRAINT "custom_field_group_grants_group_id_custom_field_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."custom_field_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cfg_entity_idx" ON "custom_field_groups" USING btree ("entity_type");--> statement-breakpoint
ALTER TABLE "custom_field_definitions" ADD CONSTRAINT "custom_field_definitions_group_id_custom_field_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."custom_field_groups"("id") ON DELETE set null ON UPDATE no action;