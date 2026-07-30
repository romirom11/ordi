-- The research-JSON import is gone: it froze one external tool's payload shape
-- into the schema. Drop the batch ledger and the columns that only ever carried
-- that payload. The lead's own qualification notes (score, signal, pain_signal,
-- evidence, why_fit, why_now, source_*, suggested_channel, opener, caution) stay
-- - they are editable by hand and shown on the lead page.
--
-- Ordering note: DROP TABLE ... CASCADE already removes the inbound FK from
-- leads, so every following statement is written to tolerate its absence.

ALTER TABLE "leads" DROP CONSTRAINT IF EXISTS "leads_research_batch_id_research_batches_id_fk";--> statement-breakpoint
DROP INDEX IF EXISTS "leads_research_batch_idx";--> statement-breakpoint
DROP TABLE IF EXISTS "research_batches" CASCADE;--> statement-breakpoint
ALTER TABLE "leads" DROP COLUMN IF EXISTS "research_batch_id";--> statement-breakpoint
ALTER TABLE "leads" DROP COLUMN IF EXISTS "dimensions";--> statement-breakpoint
ALTER TABLE "leads" DROP COLUMN IF EXISTS "secondary_sources";--> statement-breakpoint
ALTER TABLE "leads" DROP COLUMN IF EXISTS "raw_research";
