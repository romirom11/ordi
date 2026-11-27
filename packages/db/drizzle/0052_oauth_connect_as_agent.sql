ALTER TABLE "api_tokens" ADD COLUMN "oauth_client_id" text;--> statement-breakpoint
ALTER TABLE "oauth_auth_codes" ADD COLUMN "agent_user_id" text;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_oauth_client_id_oauth_clients_id_fk" FOREIGN KEY ("oauth_client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_auth_codes" ADD CONSTRAINT "oauth_auth_codes_agent_user_id_users_id_fk" FOREIGN KEY ("agent_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Tokens issued through OAuth before the client was recorded carry the name
-- the exchange gave them, "<client> (OAuth)": tie each to a client of that
-- name so the next consent for it replaces them instead of adding another.
-- The name alone could be a hand-made token's, so a token counts only when
-- its owner approved that client in the ten minutes (a code's lifetime)
-- before it was created: every approval has been logged as oauth.authorize.
UPDATE "api_tokens" AS t SET "oauth_client_id" = (
  SELECT c."id" FROM "oauth_clients" AS c WHERE t."name" = c."name" || ' (OAuth)' ORDER BY c."created_at" DESC LIMIT 1
) WHERE t."oauth_client_id" IS NULL AND t."name" LIKE '% (OAuth)' AND EXISTS (
  SELECT 1 FROM "activity_log" AS a
  WHERE a."entity_type" = 'user' AND a."entity_id" = t."user_id" AND a."action" = 'oauth.authorize'
    AND t."name" = (a."diff"->>'client') || ' (OAuth)'
    AND a."created_at" <= t."created_at" AND a."created_at" >= t."created_at" - interval '10 minutes'
);
