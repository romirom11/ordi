CREATE TABLE "desktop_auth_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"code_challenge" text NOT NULL,
	"device_label" text DEFAULT '' NOT NULL,
	"user_id" text,
	"code" text,
	"approved_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "desktop_auth_requests_state_unique" UNIQUE("state"),
	CONSTRAINT "desktop_auth_requests_code_unique" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "desktop_auth_requests" ADD CONSTRAINT "desktop_auth_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "desktop_auth_expires_idx" ON "desktop_auth_requests" USING btree ("expires_at");