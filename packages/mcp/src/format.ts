/**
 * What every tool response passes through on its way to the model: the scrub
 * of keys that carry nothing actionable (or must never leak), the decode of
 * HTML entities on the way in, and the failure text. Shared by the catalog in
 * server.ts and the project/task tools in tasks.ts.
 */
import { OrdiApiError } from './client';

/**
 * Keys stripped from every tool response before it reaches the model.
 * Optimistic-locking counters and soft-delete markers carry nothing a model
 * can act on, and portalToken is a capability URL secret that must never end
 * up in an agent's context window.
 *
 * `version` is the exception a tool can ask back: an agent that edits a task
 * has to send the version it read, or it cannot be told apart from one writing
 * over somebody's hand edit (see `keep`).
 */
const NOISE_KEYS = new Set([
  'version', 'deletedAt', 'deleted_at', 'templateSourceId', 'template_source_id',
  'portalToken', 'portal_token', 'searchVector', 'search_vector',
]);

const NOTHING: ReadonlySet<string> = new Set();

export function scrub(value: unknown, keep: ReadonlySet<string> = NOTHING): unknown {
  if (Array.isArray(value)) return value.map((v) => scrub(v, keep));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([k]) => keep.has(k) || !NOISE_KEYS.has(k))
      .map(([k, v]) => [k, scrub(v, keep)]));
  }
  return value;
}

/**
 * Agents frequently paste HTML-escaped text ("Co-founder &amp; CEO") scraped
 * from web pages. Stored verbatim it renders escaped in the UI, so every
 * string argument of the write tools is decoded once at this boundary.
 * Applied recursively to plain objects/arrays; non-strings pass through.
 */
export function decodeEntities<T>(value: T): T {
  if (typeof value === 'string') {
    return value
      .replace(/&(amp|lt|gt|quot|#0?39|apos|nbsp);/g, (m) => (
        { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#039;': "'", '&apos;': "'", '&nbsp;': ' ' }[m] ?? m
      )) as unknown as T;
  }
  if (Array.isArray(value)) return value.map(decodeEntities) as unknown as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => [k, decodeEntities(v)])) as unknown as T;
  }
  return value;
}

export interface TextOptions {
  /** Response keys to keep despite being scrubbed by default, e.g. `version`. */
  keep?: readonly string[];
}

export function text(data: unknown, opts?: TextOptions) {
  const keep = opts?.keep?.length ? new Set(opts.keep) : NOTHING;
  return { content: [{ type: 'text' as const, text: JSON.stringify(scrub(data, keep), null, 2) }] };
}

/**
 * What each API error code means for the caller and what to do about it. The
 * model only ever sees the tool text, so the recovery has to be in it: a
 * version conflict that reads "409" gets retried verbatim, one that names the
 * re-read does not.
 */
const HINTS: Record<string, string> = {
  version_conflict: 'The record was changed in ordi after you read it – read it again (get_task) and re-apply your change on top of the current version instead of overwriting it.',
  forbidden: 'The API token lacks the permission this call needs; the token scope (or the project role of its owner) has to be widened in ordi.',
  not_found: 'The id does not exist, was deleted, or the token cannot see it – list_projects / list_tasks show what is reachable.',
  validation_error: 'The arguments did not pass validation; fix the field named above and call again.',
};

export function toolErrorText(e: unknown): string {
  if (e instanceof OrdiApiError) {
    const hint = HINTS[e.code];
    const current = (e.details as { version?: unknown } | undefined)?.version;
    const version = e.code === 'version_conflict' && typeof current === 'number' ? ` Current version: ${current}.` : '';
    return `[${e.code}] ${e.message}.${version}${hint ? ` ${hint}` : ''}`;
  }
  return e instanceof Error ? e.message : String(e);
}

export function wrap<T>(fn: () => Promise<T>, opts?: TextOptions) {
  return fn()
    .then((data) => text(data, opts))
    .catch((e: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: toolErrorText(e) }] }));
}
