CREATE TABLE "agent_connectors" (
	"agent_user_id" text NOT NULL,
	"connector_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_connectors_agent_user_id_connector_id_pk" PRIMARY KEY("agent_user_id","connector_id")
);
--> statement-breakpoint
CREATE TABLE "agent_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"secret" text NOT NULL,
	"slot" text,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone,
	"last_verified_at" timestamp with time zone,
	"last_verify_error" text,
	"connected_by" text,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_profiles" (
	"user_id" text PRIMARY KEY NOT NULL,
	"runtime" text DEFAULT 'claude_code' NOT NULL,
	"model" text,
	"instructions" text DEFAULT '' NOT NULL,
	"completion_category" text DEFAULT 'in_review' NOT NULL,
	"assign_policy" text DEFAULT 'project_members' NOT NULL,
	"max_run_minutes" integer DEFAULT 30 NOT NULL,
	"max_turns" integer DEFAULT 60 NOT NULL,
	"max_budget_usd" numeric(10, 2),
	"concurrency" integer DEFAULT 1 NOT NULL,
	"credential_id" text,
	"fallback_credential_id" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_run_events" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_user_id" text NOT NULL,
	"task_id" text NOT NULL,
	"project_id" text NOT NULL,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"runtime" text NOT NULL,
	"credential_id" text,
	"session_id" text,
	"parent_run_id" text,
	"requested_by" text,
	"comment_id" text,
	"prompt" text DEFAULT '' NOT NULL,
	"worker_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"token_id" text,
	"branch" text,
	"pr_url" text,
	"summary" text,
	"error" text,
	"usage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"claimed_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_workers" (
	"id" text PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"concurrency" integer DEFAULT 1 NOT NULL,
	"running" integer DEFAULT 0 NOT NULL,
	"runtime_available" boolean DEFAULT false NOT NULL,
	"version" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_connector_oauth" (
	"connector_id" text PRIMARY KEY NOT NULL,
	"resource_metadata_url" text,
	"authorization_server" text,
	"client_info" text,
	"tokens" text,
	"access_expires_at" timestamp with time zone,
	"pending_state" text,
	"pending_verifier" text,
	"pending_started_at" timestamp with time zone,
	"authorized_by" text,
	"authorized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_connectors" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"source" text NOT NULL,
	"library_key" text,
	"transport" text NOT NULL,
	"url" text,
	"command" text,
	"args" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"auth_mode" text DEFAULT 'none' NOT NULL,
	"secrets" text,
	"status" text DEFAULT 'active' NOT NULL,
	"tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_tested_at" timestamp with time zone,
	"last_error" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "mcp_connectors_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "agent_connectors" ADD CONSTRAINT "agent_connectors_agent_user_id_users_id_fk" FOREIGN KEY ("agent_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_connectors" ADD CONSTRAINT "agent_connectors_connector_id_mcp_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."mcp_connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_credential_id_agent_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."agent_credentials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_fallback_credential_id_agent_credentials_id_fk" FOREIGN KEY ("fallback_credential_id") REFERENCES "public"."agent_credentials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_events" ADD CONSTRAINT "agent_run_events_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_agent_user_id_users_id_fk" FOREIGN KEY ("agent_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_connector_oauth" ADD CONSTRAINT "mcp_connector_oauth_connector_id_mcp_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."mcp_connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_credentials_slot_idx" ON "agent_credentials" USING btree ("slot") WHERE slot is not null and status = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "agent_run_events_run_seq_idx" ON "agent_run_events" USING btree ("run_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_task_active_idx" ON "agent_runs" USING btree ("task_id") WHERE status in ('queued', 'claimed', 'running', 'waiting_quota');--> statement-breakpoint
CREATE INDEX "agent_runs_status_idx" ON "agent_runs" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "agent_runs_agent_idx" ON "agent_runs" USING btree ("agent_user_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_runs_task_idx" ON "agent_runs" USING btree ("task_id","created_at");--> statement-breakpoint
-- AI agents (plan 2026-09-05-001, R43): the new agents.manage permission goes
-- to the two system roles that already carry the whole catalogue. Custom
-- roles get it only when an admin grants it in the role matrix.
INSERT INTO role_permissions (role_id, permission)
SELECT id, 'agents.manage' FROM roles WHERE key IN ('owner', 'admin')
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- The Agent preset role (R46) for installs created before this release; a
-- fresh workspace gets it from the role seed.
INSERT INTO roles (id, key, name, description, is_system)
SELECT upper(substr(md5(random()::text), 1, 26)), 'agent', 'Agent',
  'AI agent: works tasks in its projects and reads the knowledge base.', false
WHERE NOT EXISTS (SELECT 1 FROM roles WHERE key = 'agent');--> statement-breakpoint
INSERT INTO role_permissions (role_id, permission)
SELECT id, p FROM roles, unnest(ARRAY['projects.read', 'projects.write', 'kb.read']) AS p
WHERE key = 'agent'
ON CONFLICT DO NOTHING;
