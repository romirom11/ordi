/**
 * Run event log (plan 2026-09-05-001, R33, R41, KTD7). Rows in
 * agent_run_events with a per-run sequence, mirrored to SSE so the task page
 * shows the run live. Known secret values are scrubbed before storage.
 */
import { getDb, schema, sql } from '@ordi/db';
import { ulid } from 'ulid';
import { broadcaster } from '../../core/events';

const { agentRunEvents } = schema;

export type RunEventType =
  | 'status' | 'init' | 'assistant' | 'tool_use' | 'tool_result' | 'connector_call' | 'rate_limit' | 'result' | 'error' | 'log';

/** Values that must never reach the log: registered per run by the worker. */
const secretsByRun = new Map<string, string[]>();

export function registerRunSecrets(runId: string, values: string[]): void {
  secretsByRun.set(runId, values.filter((v) => v && v.length >= 8));
}

export function forgetRunSecrets(runId: string): void {
  secretsByRun.delete(runId);
}

export function scrub(value: unknown, secrets: string[]): unknown {
  if (!secrets.length) return value;
  if (typeof value === 'string') {
    let out = value;
    for (const s of secrets) out = out.split(s).join('[redacted]');
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => scrub(v, secrets));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = scrub(v, secrets);
    return out;
  }
  return value;
}

interface RunScope { projectId: string; taskId: string }
const scopeByRun = new Map<string, RunScope>();

export function registerRunScope(runId: string, scope: RunScope): void {
  scopeByRun.set(runId, scope);
}

export function forgetRunScope(runId: string): void {
  scopeByRun.delete(runId);
}

/**
 * Append one event. The sequence is assigned in SQL; the worker and the
 * gateway write concurrently, so a collision on (run_id, seq) is retried
 * rather than surfacing as a failed tool call.
 */
export async function recordRunEvent(runId: string, type: RunEventType, payload: Record<string, unknown>): Promise<void> {
  const { db } = getDb();
  const clean = scrub(payload, secretsByRun.get(runId) ?? []) as Record<string, unknown>;
  let row: { seq: number; created_at: string } | undefined;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      [row] = await db.execute(sql`
        insert into agent_run_events (id, run_id, seq, type, payload)
        values (${ulid()}, ${runId}, (select coalesce(max(seq), 0) + 1 from agent_run_events where run_id = ${runId}), ${type}, ${JSON.stringify(clean)}::jsonb)
        returning seq, created_at
      `) as unknown as { seq: number; created_at: string }[];
      break;
    } catch (e) {
      if ((e as { code?: string }).code !== '23505' || attempt === 4) throw e;
    }
  }
  const scope = scopeByRun.get(runId);
  broadcaster.broadcast({
    event: 'agent.run_event',
    data: { runId, taskId: scope?.taskId, projectId: scope?.projectId, seq: Number(row?.seq ?? 0), eventType: type, payload: clean, createdAt: row?.created_at ?? new Date().toISOString() },
    projectScope: scope ? [scope.projectId] : undefined,
  });
}

export async function listRunEvents(runId: string, afterSeq = 0, limit = 500) {
  const { db } = getDb();
  const rows = await db.select().from(agentRunEvents)
    .where(sql`${agentRunEvents.runId} = ${runId} and ${agentRunEvents.seq} > ${afterSeq}`)
    .orderBy(agentRunEvents.seq).limit(limit);
  return rows.map((r) => ({ id: r.id, seq: r.seq, type: r.type, payload: r.payload, createdAt: r.createdAt.toISOString() }));
}
