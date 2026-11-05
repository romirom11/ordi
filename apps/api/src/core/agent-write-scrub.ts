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

export const scrubAgentWrites: MiddlewareHandler<AppEnv> = async (c, next) => {
  const actor = c.get('actor');
  if (!actor || actor.actorType !== 'agent' || !actor.apiTokenId || !isMutatingMethod(c.req.method)) return next();
  if (!(c.req.header('content-type') ?? '').includes('application/json')) return next();

  const { db } = getDb();
  const [run] = await db.select({
    id: schema.agentRuns.id, status: schema.agentRuns.status, projectId: schema.agentRuns.projectId,
    agentUserId: schema.agentRuns.agentUserId, taskId: schema.agentRuns.taskId,
  }).from(schema.agentRuns).where(eq(schema.agentRuns.tokenId, actor.apiTokenId));
  if (!run || !(AGENT_RUN_ACTIVE_STATUSES as readonly string[]).includes(run.status)) return next();

  const fresh = (await resolveRunSecrets(run)).vars.map((v) => v.value);
  const values = [...new Set([...registeredRunSecrets(run.id), ...fresh])].filter((v) => v.length >= MIN_LENGTH);
  if (!values.length) return next();

  let body: unknown;
  try {
    body = JSON.parse(await c.req.raw.clone().text());
  } catch {
    return next(); // not JSON after all: the route will refuse it
  }
  const cleaned = scrub(body, values);
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
