-- Ledger descriptions written by the 0004 backfill used an em dash. Replace it
-- with an en dash so already-deployed instances match the rest of the product.
UPDATE "ledger_transactions"
SET "description" = replace("description", '—', '–')
WHERE "description" LIKE '%—%';
