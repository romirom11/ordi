CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"currency" text,
	"parent_id" text,
	"is_system" boolean DEFAULT false NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_postings" (
	"id" text PRIMARY KEY NOT NULL,
	"transaction_id" text NOT NULL,
	"account_id" text NOT NULL,
	"direction" text NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"exchange_rate" numeric DEFAULT '1' NOT NULL,
	"amount_base" numeric(14, 2) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"date" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'posted' NOT NULL,
	"source_type" text,
	"source_id" text,
	"project_id" text,
	"company_id" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "expense_categories" ADD COLUMN "account_id" text;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_parent_id_accounts_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_postings" ADD CONSTRAINT "ledger_postings_transaction_id_ledger_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_postings" ADD CONSTRAINT "ledger_postings_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_type_idx" ON "accounts" USING btree ("type");--> statement-breakpoint
CREATE INDEX "accounts_parent_idx" ON "accounts" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "ledger_postings_tx_idx" ON "ledger_postings" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "ledger_postings_account_idx" ON "ledger_postings" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "ledger_transactions_date_idx" ON "ledger_transactions" USING btree ("date");--> statement-breakpoint
CREATE INDEX "ledger_transactions_source_idx" ON "ledger_transactions" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "ledger_transactions_project_idx" ON "ledger_transactions" USING btree ("project_id");--> statement-breakpoint
ALTER TABLE "expense_categories" ADD CONSTRAINT "expense_categories_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
INSERT INTO "accounts" ("id", "code", "name", "type", "is_system", "position")
SELECT v.id, v.code, v.name, v.type, true, v.position FROM (VALUES
  ('ACC000000000BANK0000000000', '1000', 'Bank', 'asset', 0),
  ('ACC000000000RECEIVABLE0000', '1100', 'Accounts receivable', 'asset', 1),
  ('ACC000000000OPENING0000000', '3000', 'Opening balance', 'equity', 0),
  ('ACC000000000CLIENTBILLING0', '4000', 'Client billing', 'revenue', 0),
  ('ACC000000000PRODUCTREV0000', '4100', 'Product revenue', 'revenue', 1),
  ('ACC000000000OTHERINCOME000', '4900', 'Other income', 'revenue', 2),
  ('ACC000000000PAYROLL0000000', '5000', 'Payroll', 'expense', 0),
  ('ACC000000000SOFTWARE000000', '5100', 'Software & subscriptions', 'expense', 1),
  ('ACC000000000CONTRACTORS000', '5200', 'Contractors', 'expense', 2),
  ('ACC000000000OTHEREXPENSES0', '5900', 'Other expenses', 'expense', 3)
) AS v(id, code, name, type, position)
WHERE NOT EXISTS (SELECT 1 FROM "accounts" a WHERE a."code" = v.code);--> statement-breakpoint
INSERT INTO "ledger_transactions" ("id", "date", "description", "status", "source_type", "source_id", "project_id", "company_id", "created_by")
SELECT 'LTXINV' || i."id", i."issue_date", 'Invoice ' || i."number", 'posted', 'invoice', i."id", i."project_id", i."company_id", i."created_by"
FROM "invoices" i
WHERE i."deleted_at" IS NULL AND i."status" <> 'draft' AND (i."status" <> 'canceled' OR i."sent_at" IS NOT NULL) AND i."total" > 0
  AND NOT EXISTS (SELECT 1 FROM "ledger_transactions" t WHERE t."source_type" = 'invoice' AND t."source_id" = i."id");--> statement-breakpoint
INSERT INTO "ledger_postings" ("id", "transaction_id", "account_id", "direction", "amount", "currency", "exchange_rate", "amount_base")
SELECT 'LPINVD' || i."id", 'LTXINV' || i."id", 'ACC000000000RECEIVABLE0000', 'debit', i."total", i."currency", '1', i."total"
FROM "invoices" i
WHERE EXISTS (SELECT 1 FROM "ledger_transactions" t WHERE t."id" = 'LTXINV' || i."id")
  AND NOT EXISTS (SELECT 1 FROM "ledger_postings" p WHERE p."id" = 'LPINVD' || i."id");--> statement-breakpoint
INSERT INTO "ledger_postings" ("id", "transaction_id", "account_id", "direction", "amount", "currency", "exchange_rate", "amount_base")
SELECT 'LPINVC' || i."id", 'LTXINV' || i."id", 'ACC000000000CLIENTBILLING0', 'credit', i."total", i."currency", '1', i."total"
FROM "invoices" i
WHERE EXISTS (SELECT 1 FROM "ledger_transactions" t WHERE t."id" = 'LTXINV' || i."id")
  AND NOT EXISTS (SELECT 1 FROM "ledger_postings" p WHERE p."id" = 'LPINVC' || i."id");--> statement-breakpoint
INSERT INTO "ledger_transactions" ("id", "date", "description", "status", "source_type", "source_id", "project_id", "company_id", "created_by")
SELECT 'LTXRVI' || i."id", i."issue_date", 'Reversal — invoice ' || i."number" || ' canceled', 'posted', 'reversal', 'LTXINV' || i."id", i."project_id", i."company_id", i."created_by"
FROM "invoices" i
WHERE i."deleted_at" IS NULL AND i."status" = 'canceled' AND i."sent_at" IS NOT NULL AND i."total" > 0
  AND NOT EXISTS (SELECT 1 FROM "ledger_transactions" t WHERE t."source_type" = 'reversal' AND t."source_id" = 'LTXINV' || i."id");--> statement-breakpoint
INSERT INTO "ledger_postings" ("id", "transaction_id", "account_id", "direction", "amount", "currency", "exchange_rate", "amount_base")
SELECT 'LPRVIC' || i."id", 'LTXRVI' || i."id", 'ACC000000000RECEIVABLE0000', 'credit', i."total", i."currency", '1', i."total"
FROM "invoices" i
WHERE EXISTS (SELECT 1 FROM "ledger_transactions" t WHERE t."id" = 'LTXRVI' || i."id")
  AND NOT EXISTS (SELECT 1 FROM "ledger_postings" p WHERE p."id" = 'LPRVIC' || i."id");--> statement-breakpoint
INSERT INTO "ledger_postings" ("id", "transaction_id", "account_id", "direction", "amount", "currency", "exchange_rate", "amount_base")
SELECT 'LPRVID' || i."id", 'LTXRVI' || i."id", 'ACC000000000CLIENTBILLING0', 'debit', i."total", i."currency", '1', i."total"
FROM "invoices" i
WHERE EXISTS (SELECT 1 FROM "ledger_transactions" t WHERE t."id" = 'LTXRVI' || i."id")
  AND NOT EXISTS (SELECT 1 FROM "ledger_postings" p WHERE p."id" = 'LPRVID' || i."id");--> statement-breakpoint
INSERT INTO "ledger_transactions" ("id", "date", "description", "status", "source_type", "source_id", "project_id", "company_id", "created_by")
SELECT 'LTXPAY' || p."id", p."date", 'Payment — invoice ' || i."number", 'posted', 'payment', p."id", i."project_id", i."company_id", p."created_by"
FROM "payments" p JOIN "invoices" i ON i."id" = p."invoice_id"
WHERE i."deleted_at" IS NULL AND p."amount" > 0
  AND NOT EXISTS (SELECT 1 FROM "ledger_transactions" t WHERE t."source_type" = 'payment' AND t."source_id" = p."id");--> statement-breakpoint
INSERT INTO "ledger_postings" ("id", "transaction_id", "account_id", "direction", "amount", "currency", "exchange_rate", "amount_base")
SELECT 'LPPAYD' || p."id", 'LTXPAY' || p."id", 'ACC000000000BANK0000000000', 'debit', p."amount", p."currency", '1', p."amount"
FROM "payments" p
WHERE EXISTS (SELECT 1 FROM "ledger_transactions" t WHERE t."id" = 'LTXPAY' || p."id")
  AND NOT EXISTS (SELECT 1 FROM "ledger_postings" x WHERE x."id" = 'LPPAYD' || p."id");--> statement-breakpoint
INSERT INTO "ledger_postings" ("id", "transaction_id", "account_id", "direction", "amount", "currency", "exchange_rate", "amount_base")
SELECT 'LPPAYC' || p."id", 'LTXPAY' || p."id", 'ACC000000000RECEIVABLE0000', 'credit', p."amount", p."currency", '1', p."amount"
FROM "payments" p
WHERE EXISTS (SELECT 1 FROM "ledger_transactions" t WHERE t."id" = 'LTXPAY' || p."id")
  AND NOT EXISTS (SELECT 1 FROM "ledger_postings" x WHERE x."id" = 'LPPAYC' || p."id");--> statement-breakpoint
INSERT INTO "ledger_transactions" ("id", "date", "description", "status", "source_type", "source_id", "project_id", "company_id", "created_by")
SELECT 'LTXEXP' || e."id", e."date", CASE WHEN e."description" <> '' THEN e."description" ELSE 'Expense' END, 'posted', 'expense', e."id", e."project_id", e."company_id", e."created_by"
FROM "expenses" e
WHERE e."deleted_at" IS NULL AND e."amount" > 0
  AND NOT EXISTS (SELECT 1 FROM "ledger_transactions" t WHERE t."source_type" = 'expense' AND t."source_id" = e."id");--> statement-breakpoint
INSERT INTO "ledger_postings" ("id", "transaction_id", "account_id", "direction", "amount", "currency", "exchange_rate", "amount_base")
SELECT 'LPEXPD' || e."id", 'LTXEXP' || e."id",
  coalesce((SELECT c."account_id" FROM "expense_categories" c WHERE c."id" = e."category_id"), 'ACC000000000OTHEREXPENSES0'),
  'debit', e."amount", e."currency", '1', e."amount"
FROM "expenses" e
WHERE EXISTS (SELECT 1 FROM "ledger_transactions" t WHERE t."id" = 'LTXEXP' || e."id")
  AND NOT EXISTS (SELECT 1 FROM "ledger_postings" x WHERE x."id" = 'LPEXPD' || e."id");--> statement-breakpoint
INSERT INTO "ledger_postings" ("id", "transaction_id", "account_id", "direction", "amount", "currency", "exchange_rate", "amount_base")
SELECT 'LPEXPC' || e."id", 'LTXEXP' || e."id", 'ACC000000000BANK0000000000', 'credit', e."amount", e."currency", '1', e."amount"
FROM "expenses" e
WHERE EXISTS (SELECT 1 FROM "ledger_transactions" t WHERE t."id" = 'LTXEXP' || e."id")
  AND NOT EXISTS (SELECT 1 FROM "ledger_postings" x WHERE x."id" = 'LPEXPC' || e."id");
