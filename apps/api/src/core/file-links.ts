/**
 * File paths in what the API reads and writes (lib/file-tokens).
 *
 * Documents store file paths – an image in a task description, a screenshot
 * an agent put in a comment, a link in a KB page – and a path opens its file
 * for about an hour. Two things keep those documents working without letting
 * a path outlive its holder's access:
 *
 * - **Out.** Every response re-signs the paths it carries for the reader it
 *   answers, after the route has decided that reader may see what it returns.
 *   A file hanging off a record is signed only for a reader of that record
 *   (core/file-access); a loose one – the kind documents embed – for every
 *   reader of the document, since it lives there. A path the reader may not
 *   open goes out dead.
 *
 * - **In.** A path coming in is kept as it is only when it proves the sender
 *   was handed the file recently (a link that lapsed less than a day ago), or
 *   the sender may open the file on their own. Any other path is stored dead:
 *   it still names the file, so readers with a right of their own still see
 *   it, but it no longer opens for everyone who reads the document. Without
 *   this, a path kept after losing access could be pasted into one's own note
 *   and read back, signed afresh, for good.
 *
 * Every request to the authenticated API, and every public route that stores
 * what a visitor sends, passes the incoming check – its url included, read
 * every way a route might decode it; JSON as the route will read it (escapes
 * resolved). A path that only comes back in the answer (a refresh, a reflected
 * query) is re-signed only for a reader with a right of their own, so no
 * route can renew a link without the file living anywhere. Signed webhooks
 * (Slack, git) are not rewritten: that would break their signatures.
 */
import type { Context, MiddlewareHandler } from 'hono';
import { getDb, schema, inArray } from '@ordi/db';
import type { Actor, AppEnv } from '../context';
import { FILE_PATH_PATTERN, deadFileToken, isRecentFileToken, readFileToken, signFileToken } from '../lib/file-tokens';
import { canReadAttachment, type AttachmentRef } from './file-access';

const MARKER = '/api/v1/files/';

/** The attachment ids of every genuine path in a text. */
function genuineIds(text: string): string[] {
  const ids = new Set<string>();
  for (const m of text.matchAll(FILE_PATH_PATTERN)) {
    if (readFileToken(m[1]!, m[2]!)) ids.add(m[1]!);
  }
  return [...ids];
}

async function loadAttachments(ids: string[]): Promise<Map<string, AttachmentRef>> {
  if (!ids.length) return new Map();
  const { db } = getDb();
  const rows = await db.select({
    id: schema.attachments.id, entityType: schema.attachments.entityType,
    entityId: schema.attachments.entityId, createdBy: schema.attachments.createdBy,
  }).from(schema.attachments).where(inArray(schema.attachments.id, ids));
  return new Map(rows.map((r) => [r.id, r]));
}

/** canReadAttachment, asked once per file per request. */
function readChecker(actor: Actor | undefined) {
  const memo = new Map<string, Promise<boolean>>();
  return (att: AttachmentRef): Promise<boolean> => {
    if (!actor) return Promise.resolve(false);
    let answer = memo.get(att.id);
    if (!answer) {
      answer = canReadAttachment(actor, att);
      memo.set(att.id, answer);
    }
    return answer;
  };
}

/** Decide every distinct genuine path once, then substitute in one pass. null keeps it. */
async function replacePaths(
  text: string,
  decide: (id: string, token: string, att: AttachmentRef | undefined) => Promise<string | null>,
): Promise<string> {
  const atts = await loadAttachments(genuineIds(text));
  const decisions = new Map<string, string | null>();
  for (const m of text.matchAll(FILE_PATH_PATTERN)) {
    const key = `${m[1]}/${m[2]}`;
    if (decisions.has(key)) continue;
    // A forged token opens nothing and is left as it is.
    decisions.set(key, readFileToken(m[1]!, m[2]!) ? await decide(m[1]!, m[2]!, atts.get(m[1]!)) : null);
  }
  return text.replace(FILE_PATH_PATTERN, (whole, id: string, token: string) => {
    const next = decisions.get(`${id}/${token}`);
    return next ? `${MARKER}${id}/${next}` : whole;
  });
}

/** The incoming side: keep a path its sender may hold, store any other dead. */
export async function vetFilePaths(text: string, actor: Actor | undefined): Promise<string> {
  const canRead = readChecker(actor);
  return replacePaths(text, async (id, token, att) => {
    if (isRecentFileToken(id, token)) return null;
    if (!att) return null; // the file is gone: the path opens nothing anyway
    if (await canRead(att)) return null;
    const dead = deadFileToken(id);
    return token === dead ? null : dead;
  });
}

/**
 * The outgoing side: a fresh link for a reader who may open the file, a dead
 * one otherwise. `echoed` holds the paths the request itself carried: a path
 * the route merely hands back (a refresh, a query reflected in the answer) is
 * not one it read from a document, so it is signed afresh only for a reader
 * with a right of their own – or a recent link could be renewed forever
 * without ever living anywhere.
 */
export async function signFilePaths(text: string, actor: Actor | undefined, echoed: ReadonlySet<string> = new Set()): Promise<string> {
  const canRead = readChecker(actor);
  return replacePaths(text, async (id, token, att) => {
    if (!att) return null;
    if (await canRead(att)) return signFileToken(id);
    // A loose file lives in the document that carries it – unless it came in
    // unvetted (dead), and then only those with a right of their own see it.
    if (att.entityType || token === deadFileToken(id)) return deadFileToken(id);
    // Handed back as it came in: it keeps the expiry it had.
    if (echoed.has(`${id}/${token}`)) return null;
    return signFileToken(id);
  });
}

/** The `id/token` of every path in a text, as signFilePaths' `echoed` wants them. */
function pathKeys(text: string, into: Set<string>): void {
  for (const m of text.matchAll(FILE_PATH_PATTERN)) into.add(`${m[1]}/${m[2]}`);
}

function refuse(c: Context<AppEnv>) {
  return c.json({
    error: { code: 'validation_error', message: 'This request carries a file link that has expired. Reload the page and try again.' },
  }, 400);
}

/**
 * Every way a consumer might decode a url or form: as is, strictly, and run by
 * run the lenient way (Hono's own decoding keeps an undecodable run and
 * decodes the rest). A path hidden from one reading must not reach a route
 * through another.
 */
function decodings(s: string): string[] {
  const plus = s.replace(/\+/g, ' ');
  const lenient = (v: string) => v.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try { return decodeURIComponent(run); } catch { return run; }
  });
  const out = [s, lenient(s), lenient(plus), lenient(lenient(s))];
  try { out.push(decodeURIComponent(s), decodeURIComponent(plus)); } catch { /* lenient readings cover it */ }
  try { for (const [k, v] of new URLSearchParams(s.includes('?') ? s.slice(s.indexOf('?')) : s)) out.push(k, v); } catch { /* not a query */ }
  return [...new Set(out)];
}

/** Whether any reading carries a path the sender may not keep; otherwise collect them. */
async function anyUnvetted(readings: string[], actor: Actor | undefined, echoed: Set<string>): Promise<boolean> {
  for (const r of readings) {
    if (!r.includes(MARKER)) continue;
    if ((await vetFilePaths(r, actor)) !== r) return true;
    pathKeys(r, echoed);
  }
  return false;
}

/** Response types that carry what a route read back; a stream is left alone. */
const SIGNABLE = /^(application\/([\w.+-]*\+)?json|text\/(?!event-stream))/i;

async function signResponse(c: Context<AppEnv>, actor: Actor | undefined, echoed: ReadonlySet<string>): Promise<void> {
  const res = c.res;
  const type = res.headers.get('content-type') ?? '';
  if (!res.body || !SIGNABLE.test(type)) return;
  const text = await res.clone().text();
  if (!text.includes(MARKER)) return;
  const signed = await signFilePaths(text, actor, echoed);
  if (signed === text) return;
  const headers = new Headers(res.headers);
  headers.delete('content-length');
  // Cleared first: assigning over a set response merges the old headers in,
  // and an old content-length would cut the new body short.
  c.res = undefined;
  c.res = new Response(signed, { status: res.status, statusText: res.statusText, headers });
}

/**
 * The incoming side of one request: the url (a route may echo a query), then
 * the body. A JSON body is rewritten with unvetted paths dead; any other body
 * cannot be rewritten in place and is refused instead. Returns the refusal, or
 * the paths the request carried once vetted.
 */
async function vetRequest(c: Context<AppEnv>, actor: Actor | undefined): Promise<{ refused: Response } | { echoed: Set<string> }> {
  const echoed = new Set<string>();
  if (await anyUnvetted(decodings(c.req.url), actor, echoed)) return { refused: refuse(c) };

  if (c.req.method === 'GET' || c.req.method === 'HEAD' || !c.req.raw.body) return { echoed };
  const raw = await c.req.raw.clone().arrayBuffer();
  const text = new TextDecoder().decode(raw);
  let parsed: { ok: true; value: unknown } | { ok: false } = { ok: false };
  // Routes parse JSON whatever the content type says, so a body that parses
  // is checked as what they will read: `\/` and `\u002f` resolved.
  try { parsed = { ok: true, value: JSON.parse(text) }; } catch { /* not JSON */ }
  if (parsed.ok) {
    const canonical = JSON.stringify(parsed.value);
    if (canonical.includes(MARKER)) {
      const vetted = await vetFilePaths(canonical, actor);
      if (vetted !== canonical) {
        const headers = new Headers(c.req.raw.headers);
        headers.delete('content-length');
        c.req.raw = new Request(c.req.raw.url, { method: c.req.raw.method, headers, body: vetted });
      }
      pathKeys(vetted, echoed);
    }
    return { echoed };
  }
  // A form, an upload, plain text: checked as bytes and as a decoded form,
  // never rewritten in place – an unvetted path refuses the write.
  const bytes = Buffer.from(raw);
  // Nothing that is or decodes to a path: the common upload, left unread.
  if (!bytes.includes(MARKER) && !/%2f/i.test(bytes.toString('latin1'))) return { echoed };
  const latin = bytes.toString('latin1');
  // A form is read every way it can be decoded; anything else (an upload's
  // parts) as is and with percent-runs decoded.
  const form = /x-www-form-urlencoded/i.test(c.req.header('content-type') ?? '');
  const readings = form ? decodings(latin) : [latin, latin.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try { return decodeURIComponent(run); } catch { return run; }
  })];
  if (await anyUnvetted(readings, actor, echoed)) return { refused: refuse(c) };
  return { echoed };
}

/**
 * Mounted on the authenticated API, after the actor is resolved. The public
 * /files route sits outside it on purpose: a file's own bytes are served as
 * they were uploaded, never rewritten.
 */
export const fileLinks: MiddlewareHandler<AppEnv> = async (c, next) => {
  const vetted = await vetRequest(c, c.get('actor'));
  if ('refused' in vetted) return vetted.refused;
  await next();
  // ── Out: re-sign what the route answered with. ──
  await signResponse(c, c.get('actor'), vetted.echoed);
};

/**
 * For a public route that stores what a visitor sends (an intake form, a
 * careers application, a quote decline): the visitor has no rights of their
 * own, so only a recent link is kept, and the triage queue's readers never get
 * an old path signed afresh because a visitor pasted it.
 */
export const vetFileLinksIn: MiddlewareHandler<AppEnv> = async (c, next) => {
  const vetted = await vetRequest(c, undefined);
  if ('refused' in vetted) return vetted.refused;
  await next();
};

/** For a public route whose JSON may carry a document (a careers page's job description). */
export const signFileLinksOut: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  await signResponse(c, undefined, new Set());
};
