-- legacy_deal_id existed so migration 0020 could demote old "Lead"-stage deals
-- into leads idempotently. That migration has run; nothing in the application
-- ever reads or writes the column. The matching product rule - refusing to name
-- a pipeline stage "Lead" - is lifted in the same change: it was a one-off
-- migration guard promoted into permanent validation.

DROP INDEX IF EXISTS "leads_legacy_deal_idx";--> statement-breakpoint
ALTER TABLE "leads" DROP COLUMN IF EXISTS "legacy_deal_id";
