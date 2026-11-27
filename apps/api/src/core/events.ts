/**
 * Event outbox (PRD §3.3). publishEvent writes to the `events` table in the same
 * transaction as the data change (atomic). A relay worker dispatches unpublished
 * events to idempotent consumers. Delivery is at-least-once.
 */
import { getDb, schema } from '@ordi/db';
import type { EventType, AggregateType } from '@ordi/shared';
import { ulid } from 'ulid';

export interface PublishInput {
  type: EventType;
  aggregateType: AggregateType;
  aggregateId: string;
  payload?: Record<string, unknown>;
  actorId?: string | null;
  actorType?: 'user' | 'agent' | 'system' | 'integration';
}

/** Insert an event into the outbox. Pass a tx to keep it atomic with the change. */
export async function publishEvent(dbOrTx: any, input: PublishInput): Promise<string> {
  const id = ulid();
  await dbOrTx.insert(schema.events).values({
    id,
    type: input.type,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    payload: input.payload ?? {},
    actorId: input.actorId ?? null,
    actorType: input.actorType ?? 'system',
  });
  return id;
}

/** Convenience for the default connection outside a transaction. */
export async function emit(input: PublishInput): Promise<string> {
  const { db } = getDb();
  return publishEvent(db, input);
}

// ─── In-process broadcaster for SSE (PRD §3.4). Redis pub/sub swaps in here later. ───
export interface SSEMessage {
  event: string;
  data: unknown;
  /** project ids this message is scoped to; empty => workspace-wide. */
  projectScope?: string[];
  /** KB space ids this message is scoped to; empty => workspace-wide. */
  spaceScope?: string[];
  /** user ids this message targets; empty => any authorized. */
  userScope?: string[];
  /**
   * Workspace news that belongs to no project (deals, finance, people): only an
   * actor holding one of these permissions hears it – or one of involvedUsers,
   * the people it is about.
   */
  permissionScope?: string[];
  involvedUsers?: string[];
  /**
   * A KB page's own visibility, for page events (with spaceScope): a draft is
   * for the space's editors, a private page for its author and the editors –
   * canSeePage, the rule the KB read routes apply.
   */
  page?: { published: boolean; visibility: string; createdBy: string | null };
  /**
   * Meant for every signed-in actor. A message with no scope at all and without
   * this goes nowhere: news nobody scoped must not default to everyone.
   */
  workspaceWide?: boolean;
}

type Subscriber = (msg: SSEMessage) => void;

class Broadcaster {
  private subs = new Set<Subscriber>();
  subscribe(fn: Subscriber): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }
  broadcast(msg: SSEMessage): void {
    for (const fn of this.subs) fn(msg);
  }
}

export const broadcaster = new Broadcaster();
