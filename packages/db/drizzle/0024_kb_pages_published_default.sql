ALTER TABLE "kb_pages" ALTER COLUMN "published" SET DEFAULT true;--> statement-breakpoint
-- Pages were born as drafts by a silent default, and the only publish control
-- lived in a context menu: in practice "draft" recorded nobody's intent, it
-- recorded that nobody found the button, while every kb.read viewer saw an
-- empty knowledge base. Draft is opt-in from here on; a page meant as one can
-- be unpublished again.
UPDATE "kb_pages" SET "published" = true WHERE "published" = false;
