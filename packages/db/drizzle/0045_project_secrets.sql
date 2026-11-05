CREATE TABLE "project_secret_audience" (
	"secret_id" text NOT NULL,
	"principal_type" text NOT NULL,
	"principal_id" text DEFAULT '' NOT NULL,
	CONSTRAINT "project_secret_audience_secret_id_principal_type_principal_id_pk" PRIMARY KEY("secret_id","principal_type","principal_id")
);
--> statement-breakpoint
CREATE TABLE "project_secret_payloads" (
	"secret_id" text PRIMARY KEY NOT NULL,
	"ciphertext" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_secrets" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"environment" text NOT NULL,
	"source" text DEFAULT 'ordi' NOT NULL,
	"expires_at" text,
	"available_to_agents" boolean DEFAULT false NOT NULL,
	"fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_revealed_at" timestamp with time zone,
	"last_revealed_by" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_resources" ADD COLUMN "secret_id" text;--> statement-breakpoint
ALTER TABLE "project_secret_audience" ADD CONSTRAINT "project_secret_audience_secret_id_project_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."project_secrets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_secret_payloads" ADD CONSTRAINT "project_secret_payloads_secret_id_project_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."project_secrets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_secrets" ADD CONSTRAINT "project_secrets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_secrets" ADD CONSTRAINT "project_secrets_last_revealed_by_users_id_fk" FOREIGN KEY ("last_revealed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_secret_audience_principal_idx" ON "project_secret_audience" USING btree ("principal_type","principal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_secrets_name_idx" ON "project_secrets" USING btree ("project_id","name");--> statement-breakpoint
ALTER TABLE "project_resources" ADD CONSTRAINT "project_resources_secret_id_project_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."project_secrets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_resources_secret_idx" ON "project_resources" USING btree ("secret_id");--> statement-breakpoint
-- A secret is the fourth resource kind; each kind still fills only its own columns.
ALTER TABLE "project_resources" DROP CONSTRAINT "project_resources_kind_check";--> statement-breakpoint
ALTER TABLE "project_resources" ADD CONSTRAINT "project_resources_kind_check" CHECK (
  ("kind" = 'link' AND "url" IS NOT NULL AND "url" ~* '^https?://' AND "attachment_id" IS NULL AND "kb_page_id" IS NULL AND "secret_id" IS NULL)
  OR ("kind" = 'file' AND "attachment_id" IS NOT NULL AND "url" IS NULL AND "kb_page_id" IS NULL AND "secret_id" IS NULL)
  OR ("kind" = 'kb_page' AND "kb_page_id" IS NOT NULL AND "url" IS NULL AND "attachment_id" IS NULL AND "secret_id" IS NULL)
  OR ("kind" = 'secret' AND "secret_id" IS NOT NULL AND "url" IS NULL AND "attachment_id" IS NULL AND "kb_page_id" IS NULL)
);--> statement-breakpoint
ALTER TABLE "project_secrets" ADD CONSTRAINT "project_secrets_environment_check"
  CHECK ("environment" IN ('test', 'staging', 'production', 'other'));--> statement-breakpoint
ALTER TABLE "project_secret_audience" ADD CONSTRAINT "project_secret_audience_principal_check"
  CHECK (("principal_type" = 'project' AND "principal_id" = '') OR ("principal_type" IN ('user', 'department') AND "principal_id" <> ''));--> statement-breakpoint
-- The secrets permissions (plan 2026-11-05-001, R44) for installs created
-- before this release; a fresh workspace gets them from the role seed. The
-- Owner holds all four; secrets.manage – changing who reaches any secret –
-- stays with the Owner until someone grants it on purpose.
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission FROM roles r
CROSS JOIN (VALUES ('secrets.read'), ('secrets.reveal'), ('secrets.write'), ('secrets.manage')) AS p(permission)
WHERE r.key = 'owner'
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission FROM roles r
CROSS JOIN (VALUES ('secrets.read'), ('secrets.reveal'), ('secrets.write')) AS p(permission)
WHERE r.key IN ('admin', 'manager')
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission FROM roles r
CROSS JOIN (VALUES ('secrets.read'), ('secrets.reveal')) AS p(permission)
WHERE r.key = 'member'
ON CONFLICT DO NOTHING;
