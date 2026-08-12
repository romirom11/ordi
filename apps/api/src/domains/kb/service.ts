/**
 * Knowledge Base domain service (PRD §9). Spaces, page tree, versions, soft-lock,
 * mentions/backlinks, comments, templates, Markdown export. Access is resource-gated
 * via assertSpace (workspace visibility + kb.read, membership, or inherited project
 * membership); workspace space create/delete is capability-gated (kb.manage_spaces).
 */
import { getDb, schema, eq, and, isNull, desc, inArray } from '@ordi/db';
import { ulid } from 'ulid';
import { appendPosition, canAccessSpace, canSeePage as canSeePageRow, hasPermission } from '@ordi/shared';
import type { Actor } from '../../context';
import { err } from '../../lib/errors';
import { writeActivity } from '../../core/activity';
import { emit } from '../../core/events';
import { assertVersion } from '../../core/locking';
import { assertSpace, assertProject, effectiveProjectRole, accessibleSpaceIds, editableSpaceIds } from '../../core/access';
import { fileSrc } from '../../lib/file-tokens';

const SOFT_LOCK_TTL_MS = 120 * 1000; // SOFT_LOCK_TTL_SECONDS

type SpaceRow = typeof schema.kbSpaces.$inferSelect;
type PageRow = typeof schema.kbPages.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────
// Mentions & Markdown (pure helpers)
// ─────────────────────────────────────────────────────────────────────────────

export interface ExtractedMentions {
  /** user ids referenced via tiptap mention nodes (@user). */
  users: string[];
  /** task keys referenced via #KEY-42 (unresolved, best-effort). */
  tasks: string[];
  /** page titles referenced via [[title]]. */
  pageTitles: string[];
}

/**
 * Walk a tiptap-JSON document collecting mentions:
 *  - nodes of type 'mention' with attrs.id  → user mentions
 *  - text matching /#([A-Z]+-\d+)/           → task refs
 *  - text matching /\[\[([^\]]+)\]\]/        → page-title links
 */
export function extractMentions(body: unknown): ExtractedMentions {
  const users = new Set<string>();
  const tasks = new Set<string>();
  const pageTitles = new Set<string>();

  const walk = (node: any): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (node.type === 'mention' && node.attrs && node.attrs.id) {
      users.add(String(node.attrs.id));
    }
    if (node.type === 'text' && typeof node.text === 'string') {
      for (const m of node.text.matchAll(/#([A-Z]+-\d+)/g)) if (m[1]) tasks.add(m[1]);
      for (const m of node.text.matchAll(/\[\[([^\]]+)\]\]/g)) if (m[1]) pageTitles.add(m[1].trim());
    }
    if (Array.isArray(node.content)) walk(node.content);
  };
  walk(body);
  return { users: [...users], tasks: [...tasks], pageTitles: [...pageTitles] };
}

function renderInline(nodes: any[]): string {
  return nodes.map(renderInlineNode).join('');
}

function renderInlineNode(node: any): string {
  if (!node || typeof node !== 'object') return '';
  if (node.type === 'text') {
    let text = typeof node.text === 'string' ? node.text : '';
    const marks: any[] = Array.isArray(node.marks) ? node.marks : [];
    for (const mark of marks) {
      switch (mark?.type) {
        case 'bold': text = `**${text}**`; break;
        case 'italic': text = `*${text}*`; break;
        case 'code': text = `\`${text}\``; break;
        case 'strike': text = `~~${text}~~`; break;
        case 'link': text = `[${text}](${mark.attrs?.href ?? ''})`; break;
        default: break;
      }
    }
    return text;
  }
  if (node.type === 'hardBreak') return '  \n';
  if (node.type === 'mention') return `@${node.attrs?.label ?? node.attrs?.id ?? ''}`;
  if (Array.isArray(node.content)) return renderInline(node.content);
  return '';
}

function renderListItem(li: any, depth: number, marker: string): string {
  const content: any[] = Array.isArray(li?.content) ? li.content : [];
  const indent = '  '.repeat(depth);
  const inlineParts: string[] = [];
  const nestedParts: string[] = [];
  for (const child of content) {
    if (child?.type === 'bulletList' || child?.type === 'orderedList' || child?.type === 'taskList') {
      nestedParts.push(renderBlock(child, depth + 1));
    } else {
      inlineParts.push(renderBlock(child, depth));
    }
  }
  const head = `${indent}${marker}${inlineParts.join(' ').trim()}`;
  return nestedParts.length ? [head, ...nestedParts].join('\n') : head;
}

function renderBlock(node: any, depth = 0): string {
  if (!node || typeof node !== 'object') return '';
  const content: any[] = Array.isArray(node.content) ? node.content : [];
  switch (node.type) {
    case 'heading': {
      const level = Math.min(Math.max(Number(node.attrs?.level ?? 1), 1), 6);
      return `${'#'.repeat(level)} ${renderInline(content)}`;
    }
    case 'paragraph':
      return renderInline(content);
    case 'bulletList':
      return content.map((li) => renderListItem(li, depth, '- ')).join('\n');
    case 'orderedList': {
      let i = Number(node.attrs?.start ?? 1);
      return content.map((li) => renderListItem(li, depth, `${i++}. `)).join('\n');
    }
    case 'taskList':
      return content
        .map((li) => renderListItem(li, depth, `- [${li?.attrs?.checked ? 'x' : ' '}] `))
        .join('\n');
    case 'codeBlock': {
      const lang = node.attrs?.language ?? '';
      const text = content.map((t) => (typeof t?.text === 'string' ? t.text : '')).join('');
      return '```' + lang + '\n' + text + '\n```';
    }
    case 'blockquote':
      return content
        .map((b) => renderBlock(b, depth))
        .join('\n\n')
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n');
    case 'horizontalRule':
      return '---';
    default: {
      const hasInline = content.some(
        (ch) => ch?.type === 'text' || ch?.type === 'mention' || ch?.type === 'hardBreak',
      );
      if (hasInline) return renderInline(content);
      if (content.length) return content.map((b) => renderBlock(b, depth)).filter(Boolean).join('\n\n');
      return '';
    }
  }
}

/** Convert a tiptap-JSON document to Markdown; falls back to plain text. */
export function tiptapToMarkdown(doc: unknown): string {
  const root = doc as any;
  if (!root || typeof root !== 'object') return '';
  const content: any[] = Array.isArray(root.content) ? root.content : [];
  if (!content.length) return '';
  return content.map((n) => renderBlock(n)).filter((s) => s !== '').join('\n\n').trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal access & data helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The uploaded document a 'pdf' page displays. The upload endpoint accepts any
 * mime, so the pdf-ness is enforced here – where the page commits to rendering
 * the file inline.
 */
async function assertPdfAttachment(fileId: string) {
  const { db } = getDb();
  const [att] = await db
    .select()
    .from(schema.attachments)
    .where(eq(schema.attachments.id, fileId))
    .limit(1);
  if (!att) throw err.validation('Uploaded file not found');
  if (att.mime !== 'application/pdf') throw err.validation('The file must be a PDF');
  return att;
}

/** File payload the client renders the inline viewer from. */
function pageFile(att: { id: string; filename: string; size: number; mime: string }) {
  return { id: att.id, filename: att.filename, size: att.size, mime: att.mime, src: fileSrc(att.id) };
}

async function loadSpace(id: string): Promise<SpaceRow> {
  const { db } = getDb();
  const [space] = await db
    .select()
    .from(schema.kbSpaces)
    .where(and(eq(schema.kbSpaces.id, id), isNull(schema.kbSpaces.deletedAt)));
  if (!space) throw err.notFound('Space not found');
  return space;
}

async function loadPage(id: string): Promise<PageRow> {
  const { db } = getDb();
  const [pg] = await db
    .select()
    .from(schema.kbPages)
    .where(and(eq(schema.kbPages.id, id), isNull(schema.kbPages.deletedAt)));
  if (!pg) throw err.notFound('Page not found');
  return pg;
}

/** True if the actor can edit the given space (membership/inheritance). */
async function isSpaceEditor(actor: Actor, spaceId: string): Promise<boolean> {
  try {
    await assertSpace(actor, spaceId, 'editor');
    return true;
  } catch {
    return false;
  }
}

/** Page-level visibility (PRD §9.3): draft => editors only; private => author or editor. */
function canSeePage(pg: PageRow, actor: Actor, isEditor: boolean): boolean {
  return canSeePageRow(pg, actor.userId, isEditor);
}

/**
 * Replicate canAccessSpace against a loaded row (avoids a query per space).
 * `projectRoles` carries the effective role per linked project, since that role
 * is no longer just the membership row (see access.effectiveProjectRole).
 */
function canAccessSpaceRow(
  actor: Actor,
  space: SpaceRow,
  projectRoles: Map<string, 'admin' | 'member' | 'viewer' | null>,
  minRole: 'viewer' | 'editor' = 'viewer',
): boolean {
  const inheritedProjectRole = space.projectId ? projectRoles.get(space.projectId) ?? null : null;
  return canAccessSpace(actor.access, {
    visibility: space.visibility as 'workspace' | 'private',
    spaceId: space.id,
    minRole,
    inheritedProjectRole,
  });
}

/** Effective project role for every project the given spaces hang off. */
async function projectRolesFor(actor: Actor, spaces: SpaceRow[]): Promise<Map<string, 'admin' | 'member' | 'viewer' | null>> {
  const ids = [...new Set(spaces.map((s) => s.projectId).filter((id): id is string => !!id))];
  const roles = new Map<string, 'admin' | 'member' | 'viewer' | null>();
  if (!ids.length) return roles;
  const { db } = getDb();
  const rows = await db
    .select({ id: schema.projects.id, visibility: schema.projects.visibility })
    .from(schema.projects)
    .where(and(inArray(schema.projects.id, ids), isNull(schema.projects.deletedAt)));
  for (const p of rows) {
    roles.set(p.id, effectiveProjectRole(actor, { id: p.id, visibility: p.visibility as 'workspace' | 'private' }));
  }
  return roles;
}

async function nextVersionNo(pageId: string): Promise<number> {
  const { db } = getDb();
  const rows = await db
    .select({ versionNo: schema.kbPageVersions.versionNo })
    .from(schema.kbPageVersions)
    .where(eq(schema.kbPageVersions.pageId, pageId))
    .orderBy(desc(schema.kbPageVersions.versionNo))
    .limit(1);
  return (rows[0]?.versionNo ?? 0) + 1;
}

async function createVersion(pageId: string, title: string, body: unknown, authorId: string): Promise<void> {
  const { db } = getDb();
  await db.insert(schema.kbPageVersions).values({
    id: ulid(),
    pageId,
    title,
    body: (body ?? {}) as any,
    versionNo: await nextVersionNo(pageId),
    authorId,
  });
}

/**
 * Recompute outgoing kb_page_links for a page from its body. Task refs (#KEY-N)
 * are stored unresolved; [[title]] links are best-effort resolved within the space.
 * Returns the parsed mentions so callers can emit page.mentioned.
 */
async function syncPageLinks(pg: PageRow, body: unknown): Promise<ExtractedMentions> {
  const { db } = getDb();
  const mentions = extractMentions(body);

  await db.delete(schema.kbPageLinks).where(eq(schema.kbPageLinks.pageId, pg.id));

  const values: { id: string; pageId: string; targetType: string; targetId: string }[] = [];
  for (const key of mentions.tasks) {
    values.push({ id: ulid(), pageId: pg.id, targetType: 'task', targetId: key });
  }
  if (mentions.pageTitles.length) {
    const targets = await db
      .select({ id: schema.kbPages.id, title: schema.kbPages.title })
      .from(schema.kbPages)
      .where(
        and(
          eq(schema.kbPages.spaceId, pg.spaceId),
          inArray(schema.kbPages.title, mentions.pageTitles),
          isNull(schema.kbPages.deletedAt),
        ),
      );
    for (const t of targets) {
      if (t.id !== pg.id) values.push({ id: ulid(), pageId: pg.id, targetType: 'page', targetId: t.id });
    }
  }
  if (values.length) await db.insert(schema.kbPageLinks).values(values);
  return mentions;
}

// ─────────────────────────────────────────────────────────────────────────────
// Spaces
// ─────────────────────────────────────────────────────────────────────────────

export async function listSpaces(actor: Actor): Promise<SpaceRow[]> {
  const { db } = getDb();
  const rows = await db
    .select()
    .from(schema.kbSpaces)
    .where(isNull(schema.kbSpaces.deletedAt))
    .orderBy(schema.kbSpaces.position, desc(schema.kbSpaces.createdAt));
  const projectRoles = await projectRolesFor(actor, rows);
  return rows.filter((s) => canAccessSpaceRow(actor, s, projectRoles));
}

export async function createSpace(actor: Actor, input: any): Promise<string> {
  const { db } = getDb();
  if (input.projectId) {
    // Project space: creation gated on project admin membership.
    await assertProject(actor, input.projectId, 'admin');
  } else if (!hasPermission(actor.access, 'kb.manage_spaces')) {
    throw err.forbidden('Missing permission kb.manage_spaces', 'kb.manage_spaces');
  }
  const id = ulid();
  await db.insert(schema.kbSpaces).values({
    id,
    name: input.name,
    icon: input.icon ?? 'book',
    projectId: input.projectId ?? null,
    visibility: input.visibility ?? 'workspace',
    position: input.position ?? 0,
  });
  // Creator becomes an editor of the space (workspace spaces need explicit membership).
  await db
    .insert(schema.spaceMembers)
    .values({ spaceId: id, userId: actor.userId, role: 'editor' })
    .onConflictDoNothing();
  await writeActivity(db, {
    entityType: 'kb_space',
    entityId: id,
    action: 'created',
    after: input,
    actorId: actor.userId,
    actorType: actor.actorType,
  });
  return id;
}

export async function getSpace(actor: Actor, id: string): Promise<SpaceRow> {
  await assertSpace(actor, id, 'viewer');
  return loadSpace(id);
}

/**
 * Space editor, or a workspace admin holding kb.manage_spaces – the same fallback
 * deleteSpace uses, so admins can manage orphaned spaces they are not members of.
 */
async function assertSpaceEditorOrManager(actor: Actor, spaceId: string): Promise<void> {
  if (hasPermission(actor.access, 'kb.manage_spaces')) return;
  await assertSpace(actor, spaceId, 'editor');
}

export async function updateSpace(actor: Actor, id: string, input: any): Promise<SpaceRow> {
  const { db } = getDb();
  await assertSpaceEditorOrManager(actor, id);
  const before = await loadSpace(id);
  assertVersion(before, input.version, before);
  const patch: Record<string, unknown> = {};
  for (const k of ['name', 'icon', 'visibility', 'position', 'projectId']) {
    if (input[k] !== undefined) patch[k] = input[k];
  }
  await db
    .update(schema.kbSpaces)
    .set(patch)
    .where(and(eq(schema.kbSpaces.id, id), eq(schema.kbSpaces.version, before.version)));
  await writeActivity(db, {
    entityType: 'kb_space',
    entityId: id,
    action: 'updated',
    before,
    after: patch,
    actorId: actor.userId,
    actorType: actor.actorType,
  });
  return loadSpace(id);
}

export async function deleteSpace(actor: Actor, id: string): Promise<void> {
  const { db } = getDb();
  const space = await loadSpace(id);
  if (space.projectId) {
    await assertProject(actor, space.projectId, 'admin');
  } else if (!hasPermission(actor.access, 'kb.manage_spaces')) {
    throw err.forbidden('Missing permission kb.manage_spaces', 'kb.manage_spaces');
  }
  await db.update(schema.kbSpaces).set({ deletedAt: new Date() }).where(eq(schema.kbSpaces.id, id));
  await writeActivity(db, {
    entityType: 'kb_space',
    entityId: id,
    action: 'deleted',
    actorId: actor.userId,
    actorType: actor.actorType,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Space members
// ─────────────────────────────────────────────────────────────────────────────

export async function listMembers(actor: Actor, spaceId: string) {
  const { db } = getDb();
  await assertSpaceEditorOrManager(actor, spaceId);
  return db
    .select({
      userId: schema.spaceMembers.userId,
      role: schema.spaceMembers.role,
      name: schema.users.name,
      email: schema.users.email,
      avatar: schema.users.avatar,
    })
    .from(schema.spaceMembers)
    .innerJoin(schema.users, eq(schema.users.id, schema.spaceMembers.userId))
    .where(eq(schema.spaceMembers.spaceId, spaceId));
}

export async function addMember(actor: Actor, spaceId: string, input: any): Promise<void> {
  const { db } = getDb();
  await assertSpaceEditorOrManager(actor, spaceId);
  await db
    .insert(schema.spaceMembers)
    .values({ spaceId, userId: input.userId, role: input.role ?? 'editor' })
    .onConflictDoUpdate({
      target: [schema.spaceMembers.spaceId, schema.spaceMembers.userId],
      set: { role: input.role ?? 'editor' },
    });
  await writeActivity(db, {
    entityType: 'kb_space',
    entityId: spaceId,
    action: 'member_added',
    after: { userId: input.userId, role: input.role ?? 'editor' },
    actorId: actor.userId,
    actorType: actor.actorType,
  });
}

export async function removeMember(actor: Actor, spaceId: string, userId: string): Promise<void> {
  const { db } = getDb();
  await assertSpaceEditorOrManager(actor, spaceId);
  await db
    .delete(schema.spaceMembers)
    .where(and(eq(schema.spaceMembers.spaceId, spaceId), eq(schema.spaceMembers.userId, userId)));
  await writeActivity(db, {
    entityType: 'kb_space',
    entityId: spaceId,
    action: 'member_removed',
    after: { userId },
    actorId: actor.userId,
    actorType: actor.actorType,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Pages (tree + CRUD)
// ─────────────────────────────────────────────────────────────────────────────

/** Flat page list for a space, filtered by page-level visibility (client builds tree). */
export async function listPages(actor: Actor, spaceId: string): Promise<PageRow[]> {
  const { db } = getDb();
  await assertSpace(actor, spaceId, 'viewer');
  const isEditor = await isSpaceEditor(actor, spaceId);
  const rows = await db
    .select()
    .from(schema.kbPages)
    .where(and(eq(schema.kbPages.spaceId, spaceId), isNull(schema.kbPages.deletedAt)))
    .orderBy(schema.kbPages.position);
  return rows.filter((p) => canSeePage(p, actor, isEditor));
}

export async function createPage(actor: Actor, input: any): Promise<string> {
  const { db } = getDb();
  await assertSpace(actor, input.spaceId, 'editor');
  const parentId = input.parentId ?? null;
  const [last] = await db
    .select({ position: schema.kbPages.position })
    .from(schema.kbPages)
    .where(
      and(
        eq(schema.kbPages.spaceId, input.spaceId),
        parentId ? eq(schema.kbPages.parentId, parentId) : isNull(schema.kbPages.parentId),
        isNull(schema.kbPages.deletedAt),
      ),
    )
    .orderBy(desc(schema.kbPages.position))
    .limit(1);
  const position = appendPosition(last?.position != null ? Number(last.position) : null);

  const type = input.type ?? 'article';
  const fileId = input.fileId ?? null;
  if (type === 'pdf') {
    if (!fileId) throw err.validation('A PDF page needs an uploaded file');
    await assertPdfAttachment(fileId);
  }

  const id = ulid();
  const body = input.body ?? {};
  await db.insert(schema.kbPages).values({
    id,
    spaceId: input.spaceId,
    parentId,
    title: input.title,
    type,
    fileId,
    body,
    icon: input.icon ?? null,
    position: String(position),
    isTemplate: input.isTemplate ?? false,
    published: input.published ?? true,
    visibility: input.visibility ?? 'public',
    createdBy: actor.userId,
  });
  const created = await loadPage(id);
  await createVersion(id, input.title, body, actor.userId);
  const mentions = await syncPageLinks(created, body);
  if (mentions.users.length) {
    await emit({
      type: 'page.mentioned',
      aggregateType: 'page',
      aggregateId: id,
      payload: { pageId: id, spaceId: input.spaceId, mentions: mentions.users },
      actorId: actor.userId,
      actorType: actor.actorType,
    });
  }
  await writeActivity(db, {
    entityType: 'kb_page',
    entityId: id,
    action: 'created',
    after: { title: input.title, spaceId: input.spaceId },
    actorId: actor.userId,
    actorType: actor.actorType,
  });
  return id;
}

export async function getPage(actor: Actor, id: string, includeBacklinks: boolean) {
  const { db } = getDb();
  const pg = await loadPage(id);
  await assertSpace(actor, pg.spaceId, 'viewer');
  const isEditor = await isSpaceEditor(actor, pg.spaceId);
  if (!canSeePage(pg, actor, isEditor)) throw err.notFound('Page not found');

  const mentions = extractMentions(pg.body);
  const links = await db
    .select()
    .from(schema.kbPageLinks)
    .where(eq(schema.kbPageLinks.pageId, id));

  const out: Record<string, unknown> = { ...pg, mentions, links, canEdit: isEditor };

  if (pg.fileId) {
    const [att] = await db
      .select()
      .from(schema.attachments)
      .where(eq(schema.attachments.id, pg.fileId))
      .limit(1);
    if (att) out.file = pageFile(att);
  }

  if (includeBacklinks) {
    // A backlink names the page that links here – filter by what the actor may
    // see of *that* page, or a private space's titles surface on public ones.
    const rows = await db
      .select({
        pageId: schema.kbPageLinks.pageId,
        title: schema.kbPages.title,
        spaceId: schema.kbPages.spaceId,
        published: schema.kbPages.published,
        visibility: schema.kbPages.visibility,
        createdBy: schema.kbPages.createdBy,
      })
      .from(schema.kbPageLinks)
      .innerJoin(schema.kbPages, eq(schema.kbPages.id, schema.kbPageLinks.pageId))
      .where(
        and(
          eq(schema.kbPageLinks.targetType, 'page'),
          eq(schema.kbPageLinks.targetId, id),
          isNull(schema.kbPages.deletedAt),
        ),
      );
    const visibleSpaces = new Set(await accessibleSpaceIds(actor));
    const editorSpaces = new Set(await editableSpaceIds(actor));
    out.backlinks = rows
      .filter((b) => visibleSpaces.has(b.spaceId) && canSeePageRow(b, actor.userId, editorSpaces.has(b.spaceId)))
      .map((b) => ({ pageId: b.pageId, title: b.title, spaceId: b.spaceId }));
  }
  return out;
}

export async function updatePage(actor: Actor, id: string, input: any) {
  const { db } = getDb();
  const before = await loadPage(id);
  await assertSpace(actor, before.spaceId, 'editor');
  assertVersion(before, input.version, before);
  // Moving to another space requires editor on the destination too.
  if (input.spaceId && input.spaceId !== before.spaceId) {
    await assertSpace(actor, input.spaceId, 'editor');
  }

  const patch: Record<string, unknown> = {};
  for (const k of ['title', 'body', 'icon', 'fileId', 'parentId', 'spaceId', 'published', 'visibility']) {
    if (input[k] !== undefined) patch[k] = input[k];
  }
  // Only a pdf page has a document to swap – and swapping must keep it a
  // working viewer, so the replacement is validated like the original.
  if (input.fileId !== undefined) {
    if (before.type !== 'pdf') delete patch.fileId;
    else if (!input.fileId) throw err.validation('A PDF page needs an uploaded file');
    else await assertPdfAttachment(input.fileId);
  }
  await db
    .update(schema.kbPages)
    .set(patch)
    .where(and(eq(schema.kbPages.id, id), eq(schema.kbPages.version, before.version)));

  const after = await loadPage(id);
  const contentChanged = input.title !== undefined || input.body !== undefined;
  if (contentChanged) {
    await createVersion(id, after.title, after.body, actor.userId);
  }
  if (input.body !== undefined) {
    const mentions = await syncPageLinks(after, after.body);
    if (mentions.users.length) {
      await emit({
        type: 'page.mentioned',
        aggregateType: 'page',
        aggregateId: id,
        payload: { pageId: id, spaceId: after.spaceId, mentions: mentions.users },
        actorId: actor.userId,
        actorType: actor.actorType,
      });
    }
  }
  if (input.published === true && !before.published) {
    await emit({
      type: 'page.published',
      aggregateType: 'page',
      aggregateId: id,
      payload: { pageId: id, spaceId: after.spaceId, title: after.title },
      actorId: actor.userId,
      actorType: actor.actorType,
    });
  }
  await writeActivity(db, {
    entityType: 'kb_page',
    entityId: id,
    action: 'updated',
    before: { title: before.title, published: before.published, visibility: before.visibility },
    after: patch,
    actorId: actor.userId,
    actorType: actor.actorType,
  });
  return after;
}

export async function deletePage(actor: Actor, id: string): Promise<void> {
  const { db } = getDb();
  const pg = await loadPage(id);
  await assertSpace(actor, pg.spaceId, 'editor');
  await db.update(schema.kbPages).set({ deletedAt: new Date() }).where(eq(schema.kbPages.id, id));
  await writeActivity(db, {
    entityType: 'kb_page',
    entityId: id,
    action: 'deleted',
    actorId: actor.userId,
    actorType: actor.actorType,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Versions
// ─────────────────────────────────────────────────────────────────────────────

export async function listVersions(actor: Actor, pageId: string) {
  const { db } = getDb();
  const pg = await loadPage(pageId);
  await assertSpace(actor, pg.spaceId, 'viewer');
  // Versions carry full bodies – a page the actor cannot open must not
  // narrate its history either.
  const isEditor = await isSpaceEditor(actor, pg.spaceId);
  if (!canSeePage(pg, actor, isEditor)) throw err.notFound('Page not found');
  return db
    .select()
    .from(schema.kbPageVersions)
    .where(eq(schema.kbPageVersions.pageId, pageId))
    .orderBy(desc(schema.kbPageVersions.versionNo));
}

/** Redo-safe restore: copy an old version's content into the page as a NEW version. */
export async function restoreVersion(actor: Actor, pageId: string, versionNo: number) {
  const { db } = getDb();
  const pg = await loadPage(pageId);
  await assertSpace(actor, pg.spaceId, 'editor');
  const [snapshot] = await db
    .select()
    .from(schema.kbPageVersions)
    .where(and(eq(schema.kbPageVersions.pageId, pageId), eq(schema.kbPageVersions.versionNo, versionNo)));
  if (!snapshot) throw err.notFound('Version not found');

  await db
    .update(schema.kbPages)
    .set({ title: snapshot.title, body: snapshot.body })
    .where(eq(schema.kbPages.id, pageId));
  await createVersion(pageId, snapshot.title, snapshot.body, actor.userId);
  const after = await loadPage(pageId);
  await syncPageLinks(after, after.body);
  await writeActivity(db, {
    entityType: 'kb_page',
    entityId: pageId,
    action: 'restored',
    after: { restoredFrom: versionNo },
    actorId: actor.userId,
    actorType: actor.actorType,
  });
  return after;
}

// ─────────────────────────────────────────────────────────────────────────────
// Soft-lock (PRD §9.3)
// ─────────────────────────────────────────────────────────────────────────────

function lockIsHeldByOther(pg: PageRow, actor: Actor): boolean {
  if (!pg.lockedBy || pg.lockedBy === actor.userId || !pg.lockedAt) return false;
  return Date.now() - new Date(pg.lockedAt).getTime() < SOFT_LOCK_TTL_MS;
}

export async function lockPage(actor: Actor, id: string) {
  const { db } = getDb();
  const pg = await loadPage(id);
  await assertSpace(actor, pg.spaceId, 'editor');
  if (lockIsHeldByOther(pg, actor)) {
    throw err.conflict('Page is being edited by someone else', {
      lockedBy: pg.lockedBy,
      lockedAt: pg.lockedAt,
    });
  }
  const now = new Date();
  await db.update(schema.kbPages).set({ lockedBy: actor.userId, lockedAt: now }).where(eq(schema.kbPages.id, id));
  return { lockedBy: actor.userId, lockedAt: now };
}

export async function unlockPage(actor: Actor, id: string) {
  const { db } = getDb();
  const pg = await loadPage(id);
  await assertSpace(actor, pg.spaceId, 'editor');
  await db.update(schema.kbPages).set({ lockedBy: null, lockedAt: null }).where(eq(schema.kbPages.id, id));
  return { ok: true };
}

export async function heartbeatLock(actor: Actor, id: string) {
  const { db } = getDb();
  const pg = await loadPage(id);
  await assertSpace(actor, pg.spaceId, 'editor');
  if (lockIsHeldByOther(pg, actor)) {
    throw err.conflict('Page is being edited by someone else', {
      lockedBy: pg.lockedBy,
      lockedAt: pg.lockedAt,
    });
  }
  const now = new Date();
  await db.update(schema.kbPages).set({ lockedBy: actor.userId, lockedAt: now }).where(eq(schema.kbPages.id, id));
  return { lockedBy: actor.userId, lockedAt: now };
}

// ─────────────────────────────────────────────────────────────────────────────
// Export
// ─────────────────────────────────────────────────────────────────────────────

export async function exportPage(actor: Actor, id: string): Promise<{ markdown: string }> {
  const pg = await loadPage(id);
  await assertSpace(actor, pg.spaceId, 'viewer');
  const isEditor = await isSpaceEditor(actor, pg.spaceId);
  if (!canSeePage(pg, actor, isEditor)) throw err.notFound('Page not found');
  // A pdf page has no rich-text body – export the (signed) link to the document.
  if (pg.type === 'pdf' && pg.fileId) {
    const [att] = await getDb().db
      .select()
      .from(schema.attachments)
      .where(eq(schema.attachments.id, pg.fileId))
      .limit(1);
    const link = att ? `[${att.filename}](${fileSrc(att.id)})` : '';
    return { markdown: `# ${pg.title}\n\n${link}`.trim() + '\n' };
  }
  const body = tiptapToMarkdown(pg.body);
  const markdown = `# ${pg.title}\n\n${body}`.trim() + '\n';
  return { markdown };
}

// ─────────────────────────────────────────────────────────────────────────────
// Comments
// ─────────────────────────────────────────────────────────────────────────────

export async function listComments(actor: Actor, pageId: string) {
  const { db } = getDb();
  const pg = await loadPage(pageId);
  await assertSpace(actor, pg.spaceId, 'viewer');
  const isEditor = await isSpaceEditor(actor, pg.spaceId);
  if (!canSeePage(pg, actor, isEditor)) throw err.notFound('Page not found');
  return db
    .select()
    .from(schema.kbPageComments)
    .where(and(eq(schema.kbPageComments.pageId, pageId), isNull(schema.kbPageComments.deletedAt)))
    .orderBy(schema.kbPageComments.createdAt);
}

export async function addComment(actor: Actor, pageId: string, input: any): Promise<string> {
  const { db } = getDb();
  const pg = await loadPage(pageId);
  await assertSpace(actor, pg.spaceId, 'viewer');
  const isEditor = await isSpaceEditor(actor, pg.spaceId);
  if (!canSeePage(pg, actor, isEditor)) throw err.notFound('Page not found');

  const id = ulid();
  await db.insert(schema.kbPageComments).values({
    id,
    pageId,
    authorId: actor.userId,
    body: (input.body ?? {}) as any,
  });
  // Mentions come from the explicit list plus any parsed from the comment body.
  const parsed = extractMentions(input.body);
  const mentions = [...new Set([...(input.mentions ?? []), ...parsed.users])];
  if (mentions.length) {
    await emit({
      type: 'page.mentioned',
      aggregateType: 'page',
      aggregateId: pageId,
      payload: { pageId, commentId: id, spaceId: pg.spaceId, mentions },
      actorId: actor.userId,
      actorType: actor.actorType,
    });
  }
  await writeActivity(db, {
    entityType: 'kb_page_comment',
    entityId: id,
    action: 'created',
    after: { pageId },
    actorId: actor.userId,
    actorType: actor.actorType,
  });
  return id;
}

export async function deleteComment(actor: Actor, commentId: string): Promise<void> {
  const { db } = getDb();
  const [comment] = await db
    .select()
    .from(schema.kbPageComments)
    .where(and(eq(schema.kbPageComments.id, commentId), isNull(schema.kbPageComments.deletedAt)));
  if (!comment) throw err.notFound('Comment not found');
  const pg = await loadPage(comment.pageId);
  const isEditor = await isSpaceEditor(actor, pg.spaceId);
  if (comment.authorId !== actor.userId && !isEditor) {
    // No membership even to view => 404; otherwise not allowed to delete others' comments.
    await assertSpace(actor, pg.spaceId, 'viewer');
    throw err.forbidden('Cannot delete another user’s comment');
  }
  await db
    .update(schema.kbPageComments)
    .set({ deletedAt: new Date() })
    .where(eq(schema.kbPageComments.id, commentId));
  await writeActivity(db, {
    entityType: 'kb_page_comment',
    entityId: commentId,
    action: 'deleted',
    actorId: actor.userId,
    actorType: actor.actorType,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Templates & duplication
// ─────────────────────────────────────────────────────────────────────────────

export async function listTemplates(actor: Actor, spaceId?: string): Promise<PageRow[]> {
  const { db } = getDb();
  if (spaceId) {
    await assertSpace(actor, spaceId, 'viewer');
    const isEditor = await isSpaceEditor(actor, spaceId);
    const rows = await db
      .select()
      .from(schema.kbPages)
      .where(
        and(
          eq(schema.kbPages.spaceId, spaceId),
          eq(schema.kbPages.isTemplate, true),
          isNull(schema.kbPages.deletedAt),
        ),
      )
      .orderBy(schema.kbPages.position);
    return rows.filter((p) => canSeePage(p, actor, isEditor));
  }
  // No space filter: templates across every space the actor can access.
  const spaces = await listSpaces(actor);
  const spaceIds = spaces.map((s) => s.id);
  if (!spaceIds.length) return [];
  const projectRoles = await projectRolesFor(actor, spaces);
  const editorFlags = new Map<string, boolean>();
  for (const s of spaces) editorFlags.set(s.id, canAccessSpaceRow(actor, s, projectRoles, 'editor'));
  const rows = await db
    .select()
    .from(schema.kbPages)
    .where(
      and(
        inArray(schema.kbPages.spaceId, spaceIds),
        eq(schema.kbPages.isTemplate, true),
        isNull(schema.kbPages.deletedAt),
      ),
    )
    .orderBy(schema.kbPages.position);
  return rows.filter((p) => canSeePage(p, actor, editorFlags.get(p.spaceId) ?? false));
}

/** Create a new page from an existing (template) page. */
export async function duplicatePage(actor: Actor, id: string, input: any): Promise<string> {
  const { db } = getDb();
  const source = await loadPage(id);
  await assertSpace(actor, source.spaceId, 'viewer');
  // Duplicating copies the body – a draft or private page the actor cannot
  // read must not become readable via a copy into a space they edit.
  if (!canSeePage(source, actor, await isSpaceEditor(actor, source.spaceId))) {
    throw err.notFound('Page not found');
  }
  const targetSpaceId = input.spaceId ?? source.spaceId;
  await assertSpace(actor, targetSpaceId, 'editor');

  const parentId = input.parentId ?? null;
  const [last] = await db
    .select({ position: schema.kbPages.position })
    .from(schema.kbPages)
    .where(
      and(
        eq(schema.kbPages.spaceId, targetSpaceId),
        parentId ? eq(schema.kbPages.parentId, parentId) : isNull(schema.kbPages.parentId),
        isNull(schema.kbPages.deletedAt),
      ),
    )
    .orderBy(desc(schema.kbPages.position))
    .limit(1);
  const position = appendPosition(last?.position != null ? Number(last.position) : null);

  const newId = ulid();
  const title = input.title ?? `Copy of ${source.title}`;
  await db.insert(schema.kbPages).values({
    id: newId,
    spaceId: targetSpaceId,
    parentId,
    title,
    type: source.type,
    fileId: source.fileId,
    body: source.body,
    icon: source.icon,
    position: String(position),
    isTemplate: false,
    visibility: source.visibility,
    createdBy: actor.userId,
  });
  const created = await loadPage(newId);
  await createVersion(newId, title, source.body, actor.userId);
  await syncPageLinks(created, source.body);
  await writeActivity(db, {
    entityType: 'kb_page',
    entityId: newId,
    action: 'created',
    after: { title, fromTemplate: id },
    actorId: actor.userId,
    actorType: actor.actorType,
  });
  return newId;
}

// ─────────────────────────────────────────────────────────────────────────────
// Convert to task (PRD §9.3) – returns a prefilled payload, no cross-domain write.
// ─────────────────────────────────────────────────────────────────────────────

export async function pageToTask(actor: Actor, id: string, input: any) {
  const pg = await loadPage(id);
  await assertSpace(actor, pg.spaceId, 'viewer');
  const isEditor = await isSpaceEditor(actor, pg.spaceId);
  if (!canSeePage(pg, actor, isEditor)) throw err.notFound('Page not found');
  if (!input.projectId) throw err.validation('projectId is required');
  return {
    projectId: input.projectId,
    statusId: input.statusId ?? null,
    title: input.title ?? pg.title,
    description: input.description ?? null,
    backlink: { type: 'page', pageId: pg.id, title: pg.title },
  };
}
