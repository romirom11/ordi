CREATE TABLE "invoice_source_projects" (
	"invoice_id" text NOT NULL,
	"project_id" text NOT NULL,
	CONSTRAINT "invoice_source_projects_invoice_id_project_id_pk" PRIMARY KEY("invoice_id","project_id")
);
--> statement-breakpoint
ALTER TABLE "invoice_source_projects" ADD CONSTRAINT "invoice_source_projects_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Existing invoices from time: the projects of the time entries still on
-- their lines, and the project an invoice from one project's time is filed
-- under.
INSERT INTO "invoice_source_projects" ("invoice_id", "project_id")
SELECT DISTINCT ii.invoice_id, te.project_id
FROM "invoice_items" ii
JOIN "time_entries" te ON te.invoice_item_id = ii.id
UNION
SELECT i.id, i.project_id
FROM "invoices" i
WHERE i.source = 'time' AND i.project_id IS NOT NULL
ON CONFLICT DO NOTHING;
