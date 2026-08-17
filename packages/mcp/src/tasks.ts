/**
 * Project structure and task tools: what an agent needs to run a planning
 * board – a content calendar, a release plan – out of ordi without inventing
 * its own storage. Everything here is the existing model: projects, task
 * statuses, task types, labels, custom fields, the task's due date as the
 * calendar date, comments and external links.
 *
 * Three properties the plain REST wrappers did not have, and that a repeated
 * agent run needs:
 *
 * - names instead of ids. Statuses, types and labels can be passed the way
 *   they read in the UI ("Scheduled", "LinkedIn"); the tools resolve them
 *   against the project and refuse an unknown one by listing what exists.
 * - one task per key. `externalKey` is stored in a custom field, and
 *   `upsert_task` looks it up before writing, so re-running the same
 *   generation updates the post instead of filing a second one.
 * - hand edits survive. Every write carries the version it read (optimistic
 *   locking), and `upsert_task` additionally fingerprints the content it
 *   wrote: if the text, date, title or status changed in ordi since, it
 *   refuses rather than overwriting a person's edit with stale generated text.
 */
import { createHash } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { TASK_PRIORITIES, docToText, textToDoc } from '@ordi/shared';
import { OrdiApiError, type OrdiClient } from './client';
import { absolutizeImageSrcs, relativizeImageSrcs, wrap } from './format';

type Row = Record<string, any>;

/** Custom field holding the caller's own identifier for a task (PRD §8.3 customFields). */
const DEFAULT_KEY_FIELD = 'external_key';
/** Custom field holding the fingerprint of the content as MCP last wrote it. */
const HASH_FIELD = 'mcp_content_hash';
/** One scan window when the key field has no definition to filter on. */
const SCAN_LIMIT = 500;

/**
 * Task responses keep `version` (the scrub drops it everywhere else): it is
 * what update_task sends back as expectedVersion, so withholding it would make
 * the safe write impossible to perform.
 */
const VERSIONED = { keep: ['version'] } as const;

const isId = (v: string): boolean => /^[0-9a-hjkmnp-tv-z]{26}$/i.test(v.trim());

const linkSchema = z.object({
  url: z.string().url(),
  title: z.string().optional().describe('Defaults to the host name'),
});

// ── Resolution: keys and names in, ids out ──

interface Project { id: string; key: string; name: string; status?: string }

/** A project by id or by key ("CONTENT"), with the reachable keys in the error. */
async function resolveProject(client: OrdiClient, ref: string): Promise<Project> {
  const wanted = ref.trim();
  if (isId(wanted)) return client.get<Project>(`/projects/${wanted}`);
  const res = await client.get<{ data: Project[] }>('/projects');
  const hit = res.data.find((p) => String(p.key ?? '').toUpperCase() === wanted.toUpperCase());
  if (!hit) {
    const keys = res.data.map((p) => p.key).filter(Boolean).join(', ');
    throw new Error(`Project "${ref}" not found, or this token cannot see it. Projects it can reach: ${keys || '(none)'}.`);
  }
  return hit;
}

/** The same, for callers that only need the id – an id passed as an id costs no request. */
async function resolveProjectId(client: OrdiClient, ref: string): Promise<string> {
  const wanted = ref.trim();
  return isId(wanted) ? wanted : (await resolveProject(client, wanted)).id;
}

interface Vocab { statuses: Row[]; types: Row[]; labels: Row[] }

/** The project's writable vocabulary, loaded once per tool call. */
function vocabLoader(client: OrdiClient, projectId: string): () => Promise<Vocab> {
  let pending: Promise<Vocab> | null = null;
  return () => {
    pending ??= Promise.all([
      client.get<{ data: Row[] }>(`/projects/${projectId}/task-statuses`),
      client.get<{ data: Row[] }>(`/task-types?projectId=${projectId}`),
      client.get<{ data: Row[] }>('/labels?scope=task'),
    ]).then(([statuses, types, labels]) => ({ statuses: statuses.data, types: types.data, labels: labels.data }));
    return pending;
  };
}

function resolveStatus(vocab: Vocab, ref: string): string {
  const wanted = ref.trim().toLowerCase();
  const hit = vocab.statuses.find((s) => s.id === ref.trim())
    ?? vocab.statuses.find((s) => String(s.name).toLowerCase() === wanted)
    ?? vocab.statuses.find((s) => String(s.category).toLowerCase() === wanted);
  if (!hit) {
    const known = vocab.statuses.map((s) => `${s.name} (${s.category})`).join(', ');
    throw new Error(`Unknown status "${ref}". This project has: ${known || '(none)'} – see get_project_schema.`);
  }
  return hit.id;
}

function resolveType(vocab: Vocab, ref: string): string {
  const wanted = ref.trim().toLowerCase();
  const hit = vocab.types.find((t) => t.id === ref.trim())
    ?? vocab.types.find((t) => String(t.name).toLowerCase() === wanted);
  if (!hit) {
    const known = vocab.types.map((t) => t.name).join(', ');
    throw new Error(`Unknown task type "${ref}". Available: ${known || '(none)'} – see get_project_schema.`);
  }
  return hit.id;
}

function resolveLabels(vocab: Vocab, refs: string[]): string[] {
  const unknown: string[] = [];
  const ids = refs.map((ref) => {
    const wanted = ref.trim().toLowerCase();
    const hit = vocab.labels.find((l) => l.id === ref.trim())
      ?? vocab.labels.find((l) => String(l.name).toLowerCase() === wanted);
    if (!hit) unknown.push(ref);
    return hit?.id ?? '';
  }).filter(Boolean);
  if (unknown.length) {
    const known = vocab.labels.map((l) => l.name).join(', ');
    throw new Error(`Unknown task labels: ${unknown.join(', ')}. Labels are workspace-wide and are created in ordi, not here. Existing: ${known || '(none)'}.`);
  }
  return ids;
}

// ── Shapes ──

function nameOf(rows: Row[], id: unknown): string | null {
  return rows.find((r) => r.id === id)?.name ?? null;
}

/** The row shape every task-writing tool answers with. */
function compact(task: Row, vocab: Vocab | null, labelIds?: string[]) {
  const ids = labelIds ?? (task.labelIds as string[] | undefined) ?? [];
  return {
    id: task.id,
    ref: task.ref ?? null,
    projectId: task.projectId,
    title: task.title,
    statusId: task.statusId,
    status: vocab ? nameOf(vocab.statuses, task.statusId) : undefined,
    typeId: task.typeId ?? null,
    type: vocab && task.typeId ? nameOf(vocab.types, task.typeId) : undefined,
    priority: task.priority,
    dueDate: task.dueDate ?? null,
    startDate: task.startDate ?? null,
    labelIds: ids,
    labels: vocab ? ids.map((id) => nameOf(vocab.labels, id) ?? id) : undefined,
    customFields: task.customFields ?? {},
    updatedAt: task.updatedAt,
    version: task.version,
  };
}

const normalizeText = (value: string): string => docToText(textToDoc(value));

/**
 * The four fields a person edits by hand – title, body, date, status – hashed
 * together. Written with every upsert and compared on the next one: equal means
 * the card still says what MCP put there, different means somebody changed it.
 */
function fingerprint(parts: { title?: unknown; text?: unknown; dueDate?: unknown; statusId?: unknown }): string {
  const flat = [parts.title, parts.text, parts.dueDate, parts.statusId].map((p) => (p == null ? '' : String(p))).join('\u0000');
  return createHash('sha256').update(flat).digest('hex').slice(0, 16);
}

/** The fingerprint of a task as it currently stands in ordi. */
function taskFingerprint(task: Row): string {
  return fingerprint({
    title: task.title,
    text: task.description ? docToText(task.description) : '',
    dueDate: task.dueDate,
    statusId: task.statusId,
  });
}

// ── Links ──

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'Link'; }
}

const sameUrl = (a: string, b: string): boolean => {
  const norm = (u: string) => String(u).trim().replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
};

/**
 * Append links, skipping the ones the task already carries. Re-running an
 * import that lists the same three sources must not leave nine rows on the
 * card, and the API deliberately has no unique index there (a link may
 * legitimately be added twice by two people).
 */
async function appendLinks(
  client: OrdiClient,
  taskId: string,
  links: { url: string; title?: string }[],
  existing: Row[],
): Promise<{ url: string; title: string; added: boolean }[]> {
  const known = [...existing];
  const out: { url: string; title: string; added: boolean }[] = [];
  for (const link of links) {
    const dupe = known.find((e) => sameUrl(e.url, link.url));
    if (dupe) { out.push({ url: dupe.url, title: dupe.title, added: false }); continue; }
    const title = link.title?.trim() || hostOf(link.url);
    await client.post(`/tasks/${taskId}/links`, { url: link.url, title });
    known.push({ url: link.url, title });
    out.push({ url: link.url, title, added: true });
  }
  return out;
}

async function loadLinks(client: OrdiClient, taskId: string): Promise<Row[]> {
  const task = await client.get<Row>(`/tasks/${taskId}?include=links`);
  return (task.links as Row[] | undefined) ?? [];
}

/**
 * The card as ordi actually holds it after a write. A create/update response
 * carries the columns but not the joins, and a tool that answered with the
 * labels it *sent* would report a set the server may have stored differently.
 */
async function readBack(client: OrdiClient, taskId: string, vocab: () => Promise<Vocab>) {
  const task = await client.get<Row>(`/tasks/${taskId}?include=labels`);
  const labels = (task.labels as Row[] | undefined) ?? [];
  return compact(task, await vocab(), labels.map((l) => l.id));
}

// ── Lookup by the caller's own key ──

async function findByKey(
  client: OrdiClient,
  projectId: string,
  keyField: string,
  key: string,
): Promise<Row | null> {
  const match = (rows: Row[]) => rows.find((t) => String(t.customFields?.[keyField] ?? '') === key) ?? null;
  const cf = encodeURIComponent(JSON.stringify([{ field_key: keyField, op: 'eq', value: key }]));
  try {
    const res = await client.get<{ data: Row[] }>(`/tasks?projectId=${projectId}&limit=200&cf=${cf}`);
    return match(res.data);
  } catch (e) {
    // No definition for the key field means the API cannot filter on it (the
    // value is still stored – customFields is a free blob). Scan one window
    // instead, and say so rather than reporting a false "not found" when the
    // project is larger than the window.
    if (!(e instanceof OrdiApiError) || e.code !== 'validation_error') throw e;
    const res = await client.get<{ data: Row[]; nextCursor: string | null }>(`/tasks?projectId=${projectId}&limit=${SCAN_LIMIT}`);
    const hit = match(res.data);
    if (!hit && res.nextCursor) {
      throw new Error(`Cannot tell whether ${keyField}="${key}" already exists: the project holds more than ${SCAN_LIMIT} tasks and "${keyField}" is not a defined custom field, so the API cannot filter on it. Define it once with create_custom_field { entityType: "tasks", key: "${keyField}", type: "text" } and call again.`);
    }
    return hit;
  }
}

// ── Write bodies ──

interface WriteArgs {
  title?: string;
  text?: string;
  status?: string;
  type?: string;
  priority?: string;
  dueDate?: string | null;
  startDate?: string | null;
  labels?: string[];
  assigneeIds?: string[];
  customFields?: Record<string, unknown>;
}

/** Shared translation of the friendly write arguments into an API body. */
async function writeBody(args: WriteArgs, vocab: () => Promise<Vocab>): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {};
  if (args.title !== undefined) body.title = args.title;
  if (args.text !== undefined) body.description = textToDoc(args.text);
  if (args.priority !== undefined) body.priority = args.priority;
  if (args.dueDate !== undefined) body.dueDate = args.dueDate;
  if (args.startDate !== undefined) body.startDate = args.startDate;
  if (args.customFields !== undefined) body.customFields = args.customFields;
  if (args.assigneeIds !== undefined) body.assigneeIds = args.assigneeIds;
  if (args.status !== undefined) body.statusId = resolveStatus(await vocab(), args.status);
  if (args.type !== undefined) body.typeId = resolveType(await vocab(), args.type);
  if (args.labels !== undefined) body.labelIds = resolveLabels(await vocab(), args.labels);
  return body;
}

const writeSchema = {
  text: z.string().optional().describe('Full body as plain text; blank line = new paragraph. Replaces the whole body. An `![name](url)` line read from get_task stays an embedded image – keep such lines when rewriting.'),
  status: z.string().optional().describe('Status id, name ("Scheduled") or category (backlog|todo|in_progress|done|canceled)'),
  type: z.string().optional().describe('Task type id or name (see get_project_schema)'),
  priority: z.enum(TASK_PRIORITIES).optional(),
  dueDate: z.string().nullable().optional().describe('YYYY-MM-DD – the date the task sits on in the calendar, i.e. the publication date of a post'),
  startDate: z.string().nullable().optional().describe('YYYY-MM-DD'),
  labels: z.array(z.string()).optional().describe('Label ids or names; replaces the label set'),
  assigneeIds: z.array(z.string()).optional().describe('User ids (see list_users)'),
  customFields: z.record(z.string(), z.unknown()).optional().describe('Keyed by custom field key, e.g. { platform: "linkedin", rubric: "case-study" } (see list_custom_fields); merged by key on update, null clears one'),
};

export function registerTaskTools(server: McpServer, client: OrdiClient): void {
  // Bodies cross the tool boundary with image markers resolved to fetchable
  // urls, and come back relative before anything is stored or fingerprinted –
  // fingerprints always compare the stored (relative) form.
  const toAgent = (text: string): string => absolutizeImageSrcs(text, client.publicUrl);
  const fromAgent = (text: string): string => relativizeImageSrcs(text, client.publicUrl);

  server.tool('get_project_schema', 'The writable structure of one project: its statuses, task types, task labels and task custom fields – everything create_task / update_task / list_tasks accept as a name. Takes a project key ("CONTENT") or id, so this is also how a project is looked up by key.', {
    project: z.string().describe('Project key (e.g. CONTENT) or id'),
  }, ({ project }) => wrap(async () => {
    const p = await resolveProject(client, project);
    const vocab = await vocabLoader(client, p.id)();
    const fields = await client.get<{ data: Row[] }>('/custom-fields?entityType=tasks');
    return {
      project: { id: p.id, key: p.key, name: p.name, status: p.status },
      statuses: vocab.statuses.map((s) => ({ id: s.id, name: s.name, category: s.category, isDefault: s.isDefault, position: s.position })),
      taskTypes: vocab.types.map((t) => ({ id: t.id, name: t.name, scope: t.projectId ? 'project' : 'workspace' })),
      labels: vocab.labels.map((l) => ({ id: l.id, name: l.name, color: l.color })),
      customFields: fields.data
        .filter((f) => !f.deprecated)
        .map((f) => ({ key: f.key, label: f.label, type: f.type, options: f.options, required: f.required })),
    };
  }));

  server.tool('list_tasks', 'List tasks of a project – the calendar view an agent plans from. Filters by due-date window (the publication date), status, labels, type, title text and custom fields (e.g. platform). Statuses, labels and types may be passed by name.', {
    project: z.string().optional().describe('Project key or id; omit to search every project the token can reach (then statuses/labels must be ids)'),
    status: z.string().optional().describe('Status id, name or category'),
    labels: z.array(z.string()).optional().describe('Label ids or names – a task must carry all of them'),
    type: z.string().optional().describe('Task type id or name'),
    dueFrom: z.string().optional().describe('YYYY-MM-DD, inclusive'),
    dueTo: z.string().optional().describe('YYYY-MM-DD, inclusive'),
    q: z.string().optional().describe('Substring of the title'),
    customFields: z.record(z.string(), z.unknown()).optional().describe('Exact match per key, e.g. { platform: "linkedin" }; an array value matches any of its members'),
    limit: z.number().int().min(1).max(200).optional().describe('Defaults to 50'),
  }, ({ project, status, labels, type, dueFrom, dueTo, q, customFields, limit }) => wrap(async () => {
    const projectId = project ? await resolveProjectId(client, project) : null;
    const vocab = projectId ? vocabLoader(client, projectId) : async (): Promise<Vocab> => {
      throw new Error('Statuses, labels and types can only be resolved by name inside one project – pass `project`, or pass ids.');
    };

    const qs = new URLSearchParams();
    if (projectId) qs.set('projectId', projectId);
    if (status) qs.set('status', resolveStatus(await vocab(), status));
    if (type) qs.set('type', resolveType(await vocab(), type));
    if (labels?.length) qs.set('label', resolveLabels(await vocab(), labels).join(','));
    if (dueFrom) qs.set('dueFrom', dueFrom);
    if (dueTo) qs.set('dueTo', dueTo);
    if (q) qs.set('q', q);
    qs.set('limit', String(limit ?? 50));
    const cf = Object.entries(customFields ?? {}).map(([field_key, value]) => (
      Array.isArray(value) ? { field_key, op: 'in', value } : { field_key, op: 'eq', value }
    ));
    if (cf.length) qs.set('cf', JSON.stringify(cf));

    const res = await client.get<{ data: Row[]; nextCursor: string | null }>(`/tasks?${qs}`);
    const known = projectId ? await vocab() : null;
    // Planning reads by date, so the calendar order is the useful one; the API
    // pages newest-created first.
    const rows = [...res.data].sort((a, b) => String(a.dueDate ?? '9999').localeCompare(String(b.dueDate ?? '9999')));
    return {
      data: rows.map((t) => compact(t, known)),
      hasMore: res.nextCursor != null,
    };
  }, VERSIONED));

  server.tool('get_task', 'One task card in full: body text, calendar date, status, labels, custom fields, assignees, external links (sources, published permalink), comments and the version to send back with update_task. Images embedded in the body or comments appear as `![name](url)` lines in place – the url is signed and can be fetched without signing in.', {
    taskId: z.string(),
  }, ({ taskId }) => wrap(async () => {
    const task = await client.get<Row>(`/tasks/${taskId}?include=labels,assignees,links,comments`);
    const vocab = await vocabLoader(client, task.projectId)();
    const users = await client.get<{ data: Row[] }>('/users/lookup').catch(() => ({ data: [] as Row[] }));
    const userName = (id: unknown) => users.data.find((u) => u.id === id)?.name ?? null;
    const labels = (task.labels as Row[] | undefined) ?? [];
    return {
      ...compact(task, vocab, labels.map((l) => l.id)),
      text: task.description ? toAgent(docToText(task.description)) : '',
      statusCategory: vocab.statuses.find((s) => s.id === task.statusId)?.category ?? null,
      assignees: ((task.assignees as Row[] | undefined) ?? []).map((a) => ({ userId: a.userId, name: a.name })),
      links: ((task.links as Row[] | undefined) ?? []).map((l) => ({ id: l.id, url: l.url, title: l.title })),
      comments: ((task.comments as Row[] | undefined) ?? []).map((c) => ({
        id: c.id, authorId: c.authorId, author: userName(c.authorId),
        createdAt: c.createdAt, editedAt: c.editedAt, text: toAgent(docToText(c.body)),
      })),
      createdAt: task.createdAt,
    };
  }, VERSIONED));

  server.tool('create_task', 'Create a task with everything a planned item needs: title, body text, calendar date, status, type, labels, custom fields (platform, rubric …) and source links. Pass externalKey to keep re-runs identifiable – the tool then refuses to file a second task under the same key. Use upsert_task when the run is meant to be repeatable.', {
    projectId: z.string().describe('Project id or key (see list_projects)'),
    title: z.string(),
    ...writeSchema,
    links: z.array(linkSchema).optional().describe('External links: trend sources, references, the published post'),
    externalKey: z.string().optional().describe('Your own unique id for this item, stored in a custom field'),
    keyField: z.string().optional().describe(`Custom field key holding externalKey; defaults to ${DEFAULT_KEY_FIELD}`),
  }, ({ projectId, title, links, externalKey, keyField, ...args }) => wrap(async () => {
    if (args.text !== undefined) args.text = fromAgent(args.text);
    const project = await resolveProjectId(client, projectId);
    const vocab = vocabLoader(client, project);
    const field = keyField ?? DEFAULT_KEY_FIELD;

    if (externalKey) {
      const dupe = await findByKey(client, project, field, externalKey);
      if (dupe) {
        throw new Error(`Task with ${field}="${externalKey}" already exists: ${dupe.ref ?? dupe.id} "${dupe.title}" (id ${dupe.id}). Update it with update_task, or use upsert_task to make this call repeatable.`);
      }
    }

    const body = await writeBody(args, vocab);
    const customFields = {
      ...(args.customFields ?? {}),
      ...(externalKey
        ? { [field]: externalKey, [HASH_FIELD]: fingerprint({
          title,
          text: args.text === undefined ? '' : normalizeText(args.text),
          dueDate: args.dueDate ?? null,
          statusId: body.statusId ?? null,
        }) }
        : {}),
    };
    const created = await client.post<Row>('/tasks', {
      ...body,
      projectId: project,
      title,
      priority: args.priority ?? 'none',
      assigneeIds: args.assigneeIds ?? [],
      labelIds: body.labelIds ?? [],
      ...(Object.keys(customFields).length ? { customFields } : {}),
    });
    const added = links?.length ? await appendLinks(client, created.id, links, []) : [];
    return { action: 'created', task: await readBack(client, created.id, vocab), links: added };
  }, VERSIONED));

  server.tool('update_task', 'Rewrite a task: text, calendar date, status, type, labels, priority, custom fields, plus links to append. Send the version you read with get_task as expectedVersion and the call refuses instead of overwriting an edit someone made in ordi meanwhile.', {
    taskId: z.string(),
    title: z.string().optional(),
    ...writeSchema,
    addLinks: z.array(linkSchema).optional().describe('Links to append – sources, or the permalink of the published post. Already-present urls are skipped.'),
    expectedVersion: z.number().int().optional().describe('The version get_task returned; omit only for a blind write'),
  }, ({ taskId, addLinks, expectedVersion, ...args }) => wrap(async () => {
    if (args.text !== undefined) args.text = fromAgent(args.text);
    const before = await client.get<Row>(`/tasks/${taskId}?include=links`);
    const vocab = vocabLoader(client, before.projectId);
    const body = await writeBody(args, vocab);
    if (!Object.keys(body).length && !addLinks?.length) throw new Error('Nothing to update – pass at least one field or addLinks.');

    // Always lock: with no expectedVersion the read above is the baseline, so a
    // concurrent edit still loses to nobody.
    if (Object.keys(body).length) {
      await client.patch<Row>(`/tasks/${taskId}`, { ...body, version: expectedVersion ?? before.version });
    }
    const added = addLinks?.length
      ? await appendLinks(client, taskId, addLinks, (before.links as Row[] | undefined) ?? [])
      : [];
    return { action: 'updated', task: await readBack(client, taskId, vocab), links: added };
  }, VERSIONED));

  server.tool('add_task_link', 'Attach an external link to a task – a trend source before writing, the published post permalink after. Adding a url the task already has is a no-op, so this is safe to re-run.', {
    taskId: z.string(),
    url: z.string().url(),
    title: z.string().optional().describe('Defaults to the host name, e.g. linkedin.com'),
  }, ({ taskId, url, title }) => wrap(async () => {
    const [link] = await appendLinks(client, taskId, [{ url, title }], await loadLinks(client, taskId));
    return {
      added: link?.added ?? false,
      links: (await loadLinks(client, taskId)).map((l) => ({ id: l.id, url: l.url, title: l.title })),
    };
  }));

  server.tool('upsert_task', 'Create or update a task by your own unique key – the repeatable write. The key is stored in a custom field, so running the same generation twice updates the one task instead of filing a duplicate. If the title, text, date or status changed in ordi since the last upsert, the call refuses (pass force to overwrite) so a person’s edit is never replaced with stale generated content.', {
    project: z.string().describe('Project key or id'),
    key: z.string().describe('Your unique id for this item, e.g. 2026-08-03-linkedin-ai-agents'),
    title: z.string(),
    ...writeSchema,
    links: z.array(linkSchema).optional().describe('Links to append (existing urls are skipped)'),
    keyField: z.string().optional().describe(`Custom field key holding the key; defaults to ${DEFAULT_KEY_FIELD}`),
    ifExists: z.enum(['update', 'skip']).optional().describe('What to do when the key is already there; defaults to update'),
    force: z.boolean().optional().describe('Overwrite even when the task was edited in ordi after the last upsert'),
  }, ({ project, key, title, links, keyField, ifExists, force, ...args }) => wrap(async () => {
    if (args.text !== undefined) args.text = fromAgent(args.text);
    const projectId = await resolveProjectId(client, project);
    const vocab = vocabLoader(client, projectId);
    const field = keyField ?? DEFAULT_KEY_FIELD;
    const existing = await findByKey(client, projectId, field, key);
    const body = await writeBody(args, vocab);

    if (!existing) {
      const customFields = {
        ...(args.customFields ?? {}),
        [field]: key,
        [HASH_FIELD]: fingerprint({
          title,
          text: args.text === undefined ? '' : normalizeText(args.text),
          dueDate: args.dueDate ?? null,
          statusId: body.statusId ?? null,
        }),
      };
      const created = await client.post<Row>('/tasks', {
        ...body,
        projectId,
        title,
        priority: args.priority ?? 'none',
        assigneeIds: args.assigneeIds ?? [],
        labelIds: body.labelIds ?? [],
        customFields,
      });
      const added = links?.length ? await appendLinks(client, created.id, links, []) : [];
      return { action: 'created', task: await readBack(client, created.id, vocab), links: added };
    }

    if (ifExists === 'skip') {
      return { action: 'skipped', reason: `${field}="${key}" already exists`, task: compact(existing, await vocab()) };
    }

    const storedHash = existing.customFields?.[HASH_FIELD];
    if (storedHash && storedHash !== taskFingerprint(existing) && !force) {
      throw new Error(`${existing.ref ?? existing.id} was edited in ordi after the last upsert (title, text, date or status differs from what was written then). Read it with get_task and merge your change into it with update_task, or call again with force: true to replace it.`);
    }

    // The fingerprint describes the row as it will stand after this write, so
    // the next run compares against what was actually stored.
    const nextText = args.text === undefined
      ? (existing.description ? docToText(existing.description) : '')
      : normalizeText(args.text);
    const customFields = {
      ...(args.customFields ?? {}),
      [field]: key,
      [HASH_FIELD]: fingerprint({
        title,
        text: nextText,
        dueDate: args.dueDate === undefined ? existing.dueDate ?? null : args.dueDate,
        statusId: body.statusId ?? existing.statusId,
      }),
    };
    await client.patch<Row>(`/tasks/${existing.id}`, {
      ...body,
      title,
      customFields,
      version: existing.version,
    });
    const added = links?.length
      ? await appendLinks(client, existing.id, links, await loadLinks(client, existing.id))
      : [];
    return { action: 'updated', task: await readBack(client, existing.id, vocab), links: added };
  }, VERSIONED));
}
