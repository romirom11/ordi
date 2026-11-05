/**
 * A project's resources: everything the team keeps "about" a project in one
 * ordered list – external links, uploaded files, knowledge-base pages and
 * secrets (schema/secrets.ts).
 *
 * A row owns only what is specific to its kind: a link carries its label and
 * url; a file points at its attachment (which keeps the name, size and bytes,
 * and which tasks use the same way); a page points at its KB page, whose title
 * is the label. Deleting the attachment or the page takes the row with it.
 */
import { pgTable, text, integer, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { pk, timestamps, createdBy } from './_shared';
import { attachments } from './core';
import { projects } from './projects';
import { kbPages } from './kb';
import { projectSecrets } from './secrets';

export const projectResources = pgTable('project_resources', {
  id: pk(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  /** link | file | kb_page */
  kind: text('kind').notNull(),
  /** A link's label. Files and pages take their name from what they point at. */
  label: text('label'),
  url: text('url'),
  attachmentId: text('attachment_id').references(() => attachments.id, { onDelete: 'cascade' }),
  kbPageId: text('kb_page_id').references(() => kbPages.id, { onDelete: 'cascade' }),
  secretId: text('secret_id').references(() => projectSecrets.id, { onDelete: 'cascade' }),
  position: integer('position').notNull().default(0),
  createdBy: createdBy(),
  ...timestamps,
}, (t) => ({
  projectIdx: index('project_resources_project_idx').on(t.projectId, t.position),
  /** A file is a resource of one project at most. */
  attachmentIdx: uniqueIndex('project_resources_attachment_idx').on(t.attachmentId),
  /** Pinning the same page twice adds nothing. */
  pageIdx: uniqueIndex('project_resources_page_idx').on(t.projectId, t.kbPageId),
  secretIdx: uniqueIndex('project_resources_secret_idx').on(t.secretId),
}));
