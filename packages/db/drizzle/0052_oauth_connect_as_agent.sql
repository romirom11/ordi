ALTER TABLE "api_tokens" ADD COLUMN "oauth_client_id" text;--> statement-breakpoint
ALTER TABLE "oauth_auth_codes" ADD COLUMN "agent_user_id" text;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_oauth_client_id_oauth_clients_id_fk" FOREIGN KEY ("oauth_client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_auth_codes" ADD CONSTRAINT "oauth_auth_codes_agent_user_id_users_id_fk" FOREIGN KEY ("agent_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Tokens issued through OAuth before the client was recorded carry the name
-- the exchange gave them, "<client> (OAuth)": tie each to a client of that
-- name so the next consent for it replaces them instead of adding another.
UPDATE "api_tokens" AS t SET "oauth_client_id" = (
  SELECT c."id" FROM "oauth_clients" AS c WHERE t."name" = c."name" || ' (OAuth)' ORDER BY c."created_at" DESC LIMIT 1
) WHERE t."oauth_client_id" IS NULL AND t."name" LIKE '% (OAuth)';
