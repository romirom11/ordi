/**
 * Activity log (PRD §14.4). Every mutation writes an immutable record with a
 * redacted diff. Redaction is centralised (one serializer + registry): sensitive
 * values recorded as fact-only, secrets excluded entirely.
 */
import { getDb, schema } from '@ordi/db';
import { buildRedactedDiff } from '@ordi/shared';
import { ulid } from 'ulid';
import type { Actor } from '../context';

export interface ActivityInput {
  entityType: string;
  entityId: string;
  action: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  actorId?: string | null;
  actorType?: 'user' | 'agent' | 'system' | 'integration';
  /** force sensitivity (e.g. a read-access record on compensation). */
  sensitivity?: 'normal' | 'sensitive';
  /** pre-built diff (e.g. for read-access markers). */
  diff?: Record<string, unknown>;
}

export async function writeActivity(dbOrTx: any, input: ActivityInput): Promise<void> {
  let diff: Record<string, unknown> = input.diff ?? {};
  let sensitivity: 'normal' | 'sensitive' = input.sensitivity ?? 'normal';
  if (!input.diff) {
    const redacted = buildRedactedDiff(input.before ?? null, input.after ?? null, input.entityType);
    diff = redacted.diff;
    sensitivity = input.sensitivity ?? redacted.sensitivity;
  }
  await dbOrTx.insert(schema.activityLog).values({
    id: ulid(),
    entityType: input.entityType,
    entityId: input.entityId,
    actorId: input.actorId ?? null,
    actorType: input.actorType ?? 'user',
    action: input.action,
    diff,
    sensitivity,
  });
}

/** Records that someone *viewed* compensation/sensitive data (PRD §12.8, §14.4). */
export async function recordSensitiveAccess(actor: Actor, entityType: string, entityId: string): Promise<void> {
  const { db } = getDb();
  await writeActivity(db, {
    entityType,
    entityId,
    action: 'viewed',
    actorId: actor.userId,
    actorType: actor.actorType,
    sensitivity: 'sensitive',
    diff: { access: { action: 'viewed' } },
  });
}

export function actorFields(actor: Actor): { actorId: string; actorType: 'user' | 'agent' | 'system' | 'integration' } {
  return { actorId: actor.userId, actorType: actor.actorType };
}
