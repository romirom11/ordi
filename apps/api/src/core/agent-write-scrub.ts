/**
 * Plan R26: what an agent run writes back to ordi never carries a secret.
 *
 * An agent run holds project secrets in its environment and reaches ordi
 * with its own run token (through the ordi MCP server, which calls this
 * API). For every write made with a run token – a comment, a task field, a
 * KB page, a project update, a resource label – the JSON body is cleaned of
 * the run's secret values before any route reads it, and the run's log
 * notes that it happened. Values come from what this process registered at
 * the run's start (credential, repository token, secrets) and, so that a
 * replica which did not start the run still cleans, from the project's
 * agent secrets resolved again.
 *
 * A value that cannot be replaced in place – split across strings, or in a
 * body that is not JSON (an upload) – makes the write fail instead.
 *
 * Shorter than 8 characters is not cleaned (registerRunSecrets' rule): too
 * short to tell from ordinary text.
 */
import type { MiddlewareHandler } from 'hono';
import { getDb, schema, eq } from '@ordi/db';
import { AGENT_RUN_ACTIVE_STATUSES } from '@ordi/shared';
import type { AppEnv } from '../context';
import { isMutatingMethod } from './rbac';
import { recordRunEvent, registeredRunSecrets, scrub } from '../domains/agents/run-events';
import { resolveRunSecrets } from '../domains/secrets/service';

const MIN_LENGTH = 8;

/** Replace values in keys as well as in string leaves. */
function scrubDeep(value: unknown, secrets: string[]): unknown {
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, secrets));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[scrub(k, secrets) as string] = scrubDeep(v, secrets);
    return out;
  }
  return scrub(value, secrets);
}

/**
 * The ways a value could be spread over several strings and still read as
 * one: every string in document order, every key, and – for rich-text
 * documents – the `text` nodes alone, which is what a reader sees.
 */
function readings(value: unknown): string[] {
  const all: string[] = [];
  const keys: string[] = [];
  const text: string[] = [];
  const walk = (v: unknown, key: string | null) => {
    if (typeof v === 'string') {
      all.push(v);
      if (key === 'text') text.push(v);
    } else if (Array.isArray(v)) {
      v.forEach((x) => walk(x, null));
    } else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) { keys.push(k); walk(x, k); }
    }
  };
  walk(value, null);
  return [all.join(''), keys.join(''), text.join('')];
}

async function refuse(c: Parameters<MiddlewareHandler<AppEnv>>[0], runId: string) {
  await recordRunEvent(runId, 'error', { message: `A write to ${c.req.method} ${c.req.path} was refused: it carried a project secret's value.` });
  return c.json({ error: { code: 'domain_rule', message: 'This write contains the value of a project secret. Read secrets from the environment and never write them to ordi.' } }, 422);
}

export const scrubAgentWrites: MiddlewareHandler<AppEnv> = async (c, next) => {
  const actor = c.get('actor');
  if (!actor || actor.actorType !== 'agent' || !actor.apiTokenId || !isMutatingMethod(c.req.method)) return next();

  const { db } = getDb();
  const [run] = await db.select({
    id: schema.agentRuns.id, status: schema.agentRuns.status, projectId: schema.agentRuns.projectId,
    agentUserId: schema.agentRuns.agentUserId, taskId: schema.agentRuns.taskId, requestedBy: schema.agentRuns.requestedBy,
  }).from(schema.agentRuns).where(eq(schema.agentRuns.tokenId, actor.apiTokenId));
  if (!run || !(AGENT_RUN_ACTIVE_STATUSES as readonly string[]).includes(run.status)) return next();

  const fresh = (await resolveRunSecrets(run)).vars.map((v) => v.value);
  const values = [...new Set([...registeredRunSecrets(run.id), ...fresh])].filter((v) => v.length >= MIN_LENGTH);
  if (!values.length) return next();

  const isJson = /json/i.test(c.req.header('content-type') ?? '');
  if (!isJson) {
    // Uploads and other bodies cannot be rewritten safely: refused whole when
    // a value is anywhere in the bytes.
    const bytes = Buffer.from(await c.req.raw.clone().arrayBuffer());
    if (values.some((v) => bytes.includes(Buffer.from(v, 'utf8')))) return refuse(c, run.id);
    return next();
  }

  let body: unknown;
  try {
    body = JSON.parse(await c.req.raw.clone().text());
  } catch {
    return next(); // not JSON after all: the route will refuse it
  }
  const cleaned = scrubDeep(body, values);
  // A value split across strings – sibling text nodes of a rich-text document,
  // a key and its value – survives per-string replacement: refuse the write.
  const joined = readings(cleaned);
  if (values.some((v) => joined.some((r) => r.includes(v)))) return refuse(c, run.id);
  const text = JSON.stringify(cleaned);
  if (text === JSON.stringify(body)) return next();

  const headers = new Headers(c.req.raw.headers);
  headers.delete('content-length');
  c.req.raw = new Request(c.req.raw.url, { method: c.req.raw.method, headers, body: text });
  await recordRunEvent(run.id, 'log', {
    message: `A write to ${c.req.method} ${c.req.path} contained a secret value; it was stored as [redacted].`,
  });
  return next();
};
