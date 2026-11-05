CREATE TABLE "project_secret_provider_links" (
	"project_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_secret_provider_links_project_id_connection_id_pk" PRIMARY KEY("project_id","connection_id")
);
--> statement-breakpoint
CREATE TABLE "secret_provider_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"credentials" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'ok' NOT NULL,
	"last_error" text,
	"checked_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_secrets" ADD COLUMN "provider_connection_id" text;--> statement-breakpoint
ALTER TABLE "project_secret_provider_links" ADD CONSTRAINT "project_secret_provider_links_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_secret_provider_links" ADD CONSTRAINT "project_secret_provider_links_connection_id_secret_provider_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."secret_provider_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_secret_provider_links_connection_idx" ON "project_secret_provider_links" USING btree ("connection_id");--> statement-breakpoint
ALTER TABLE "project_secrets" ADD CONSTRAINT "project_secrets_provider_connection_id_secret_provider_connections_id_fk" FOREIGN KEY ("provider_connection_id") REFERENCES "public"."secret_provider_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Custom: what the columns may hold. A provider secret names its connection
-- until the connection is removed (then it is disconnected, kept for its metadata).
ALTER TABLE "secret_provider_connections" ADD CONSTRAINT "secret_provider_connections_kind_check" CHECK ("kind" IN ('doppler'));--> statement-breakpoint
ALTER TABLE "secret_provider_connections" ADD CONSTRAINT "secret_provider_connections_status_check" CHECK ("status" IN ('ok', 'error'));--> statement-breakpoint
ALTER TABLE "project_secrets" ADD CONSTRAINT "project_secrets_source_check" CHECK ("source" IN ('ordi', 'provider'));--> statement-breakpoint
ALTER TABLE "project_secrets" ADD CONSTRAINT "project_secrets_provider_check" CHECK ("source" = 'provider' OR "provider_connection_id" IS NULL);
