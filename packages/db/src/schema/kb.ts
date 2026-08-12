import { pgTable, text, boolean, integer, jsonb, timestamp, index, primaryKey } from 'drizzle-orm/pg-core';
import { pk, timestamps, createdBy, version, deletedAt, position } from './_shared';
import { users, attachments } from './core';
import { projects } from './projects';

export const kbSpaces = pgTable('kb_spaces', {
  id: pk(),
  name: text('name').notNull(),
  icon: text('icon').notNull().default('book'),
  projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  visibility: text('visibility').notNull().default('workspace'),
  position: integer('position').notNull().default(0),
  ...timestamps,
  version: version(),
  deletedAt: deletedAt(),
});

export const spaceMembers = pgTable('space_members', {
  spaceId: text('space_id').notNull().references(() => kbSpaces.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: text('role').notNull().default('editor'), // editor | viewer
}, (t) => ({
  pk: primaryKey({ columns: [t.spaceId, t.userId] }),
  userIdx: index('space_members_user_idx').on(t.userId),
}));

export const kbPages = pgTable('kb_pages', {
  id: pk(),
  spaceId: text('space_id').notNull().references(() => kbSpaces.id, { onDelete: 'cascade' }),
  parentId: text('parent_id'),
  title: text('title').notNull(),
  type: text('type').notNull().default('article'), // article | pdf
  body: jsonb('body').notNull().default({}),
  icon: text('icon'),
  // The uploaded document a non-article page displays instead of a body.
  fileId: text('file_id').references(() => attachments.id, { onDelete: 'set null' }),
  position: position(),
  isTemplate: boolean('is_template').notNull().default(false),
  published: boolean('published').notNull().default(true),
  visibility: text('visibility').notNull().default('public'), // public | private
  lockedBy: text('locked_by').references(() => users.id),
  lockedAt: timestamp('locked_at', { withTimezone: true }),
  createdBy: createdBy(),
  ...timestamps,
  version: version(),
  deletedAt: deletedAt(),
}, (t) => ({
  spaceIdx: index('kb_pages_space_idx').on(t.spaceId),
  parentIdx: index('kb_pages_parent_idx').on(t.parentId),
}));

export const kbPageVersions = pgTable('kb_page_versions', {
  id: pk(),
  pageId: text('page_id').notNull().references(() => kbPages.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  body: jsonb('body').notNull().default({}),
  versionNo: integer('version_no').notNull(),
  authorId: text('author_id').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pageIdx: index('kb_page_versions_page_idx').on(t.pageId),
}));

export const kbPageComments = pgTable('kb_page_comments', {
  id: pk(),
  pageId: text('page_id').notNull().references(() => kbPages.id, { onDelete: 'cascade' }),
  authorId: text('author_id').references(() => users.id),
  body: jsonb('body').notNull().default({}),
  ...timestamps,
  deletedAt: deletedAt(),
});

export const kbPageLinks = pgTable('kb_page_links', {
  id: pk(),
  pageId: text('page_id').notNull().references(() => kbPages.id, { onDelete: 'cascade' }),
  targetType: text('target_type').notNull(), // page | task | company
  targetId: text('target_id').notNull(),
  ...timestamps,
}, (t) => ({
  targetIdx: index('kb_page_links_target_idx').on(t.targetType, t.targetId),
}));
