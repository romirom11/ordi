ALTER TABLE "invoices" ADD COLUMN "payment_account_id" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "payment_details" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "payment_currency" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "exchange_rate" numeric;--> statement-breakpoint
-- Custom: an invoice paid in another currency names that currency and a
-- positive rate together, and never its own currency.
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_payment_currency_check" CHECK (
  ("payment_currency" IS NULL AND "exchange_rate" IS NULL)
  OR ("payment_currency" IS NOT NULL AND "exchange_rate" > 0 AND "payment_currency" <> "currency")
);
