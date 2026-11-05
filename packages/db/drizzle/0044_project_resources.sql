CREATE TABLE "project_resources" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"kind" text NOT NULL,
	"label" text,
	"url" text,
	"attachment_id" text,
	"kb_page_id" text,
	"position" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_resources" ADD CONSTRAINT "project_resources_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_resources" ADD CONSTRAINT "project_resources_attachment_id_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_resources" ADD CONSTRAINT "project_resources_kb_page_id_kb_pages_id_fk" FOREIGN KEY ("kb_page_id") REFERENCES "public"."kb_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_resources_project_idx" ON "project_resources" USING btree ("project_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "project_resources_attachment_idx" ON "project_resources" USING btree ("attachment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_resources_page_idx" ON "project_resources" USING btree ("project_id","kb_page_id");--> statement-breakpoint
-- Each kind fills its own columns and nothing else.
ALTER TABLE "project_resources" ADD CONSTRAINT "project_resources_kind_check" CHECK (
  ("kind" = 'link' AND "url" IS NOT NULL AND "url" ~* '^https?://' AND "attachment_id" IS NULL AND "kb_page_id" IS NULL)
  OR ("kind" = 'file' AND "attachment_id" IS NOT NULL AND "url" IS NULL AND "kb_page_id" IS NULL)
  OR ("kind" = 'kb_page' AND "kb_page_id" IS NOT NULL AND "url" IS NULL AND "attachment_id" IS NULL)
);--> statement-breakpoint
-- The links a project kept in its jsonb column move over in their order. The
-- old API took any URL scheme; only http(s) links come across (a `javascript:`
-- or `file:` one is dropped), which the check above enforces from here on.
INSERT INTO "project_resources" ("id", "project_id", "kind", "label", "url", "position", "created_at", "updated_at")
SELECT
  substring(md5('project-link:' || p."id" || ':' || l.ord), 1, 26),
  p."id", 'link', coalesce(nullif(l.item->>'label', ''), l.item->>'url'), l.item->>'url',
  (l.ord - 1)::int, p."updated_at", p."updated_at"
FROM "projects" p
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(p."links") = 'array' THEN p."links" ELSE '[]'::jsonb END
) WITH ORDINALITY AS l(item, ord)
WHERE coalesce(l.item->>'url', '') ~* '^https?://';--> statement-breakpoint
-- The project's files follow its links, oldest first: new resources are appended.
INSERT INTO "project_resources" ("id", "project_id", "kind", "attachment_id", "position", "created_by", "created_at", "updated_at")
SELECT
  substring(md5('project-file:' || a."id"), 1, 26),
  a."entity_id", 'file', a."id",
  (SELECT count(*) FROM "project_resources" r WHERE r."project_id" = a."entity_id")::int
    + (row_number() OVER (PARTITION BY a."entity_id" ORDER BY a."created_at", a."id") - 1)::int,
  a."created_by", a."created_at", a."created_at"
FROM "attachments" a
JOIN "projects" p ON p."id" = a."entity_id"
WHERE a."entity_type" = 'project';--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "links";