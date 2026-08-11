CREATE TABLE "lead_labels" (
	"lead_id" text NOT NULL,
	"label_id" text NOT NULL,
	CONSTRAINT "lead_labels_lead_id_label_id_pk" PRIMARY KEY("lead_id","label_id")
);
--> statement-breakpoint
ALTER TABLE "lead_labels" ADD CONSTRAINT "lead_labels_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_labels" ADD CONSTRAINT "lead_labels_label_id_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "public"."labels"("id") ON DELETE cascade ON UPDATE no action;