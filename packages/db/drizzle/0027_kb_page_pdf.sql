ALTER TABLE "kb_pages" ADD COLUMN "type" text DEFAULT 'article' NOT NULL;--> statement-breakpoint
ALTER TABLE "kb_pages" ADD COLUMN "file_id" text;--> statement-breakpoint
ALTER TABLE "kb_pages" ADD CONSTRAINT "kb_pages_file_id_attachments_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."attachments"("id") ON DELETE set null ON UPDATE no action;