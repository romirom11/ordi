/**
 * Event consumers (PRD §3.3 subscribers): notifications, SSE, automations,
 * outbound webhooks. All idempotent — dedup is handled by the relay via
 * processed_events, and each handler is safe to re-run.
 */
import { getDb, schema, eq, and } from '@ordi/db';
import { ulid } from 'ulid';
import type { DomainEvent } from '@ordi/shared';
import { broadcaster } from '../core/events';
import { queueEmail } from '../lib/email';
import { hmacSha256 } from '../lib/crypto';
import { writeActivity } from '../core/activity';
import { logger } from '../lib/logger';

export interface Consumer {
  name: string;
  handle: (ev: DomainEvent) => Promise<void>;
}

async function notify(userIds: string[], type: string, entityRef: string | null, payload: Record<string, unknown>): Promise<void> {
  if (!userIds.length) return;
  const { db } = getDb();
  const unique = [...new Set(userIds)].filter(Boolean);
  for (const userId of unique) {
    await db.insert(schema.notifications).values({
      id: ulid(), userId, type, entityRef, payload,
    });
    // email dubbing per user prefs
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
    const prefs = (user?.emailNotificationPrefs as Record<string, boolean>) ?? {};
    if (user && prefs[type] !== false && prefs.__all !== false) {
      queueEmail({ to: user.email, subject: notificationSubject(type, payload), body: JSON.stringify(payload) }).catch(() => {});
    }
  }
}

function notificationSubject(type: string, payload: Record<string, unknown>): string {
  const ref = (payload.ref as string) ?? '';
  switch (type) {
    case 'task.assigned': return `Assigned to ${ref}`;
    case 'comment.mentioned': return `You were mentioned in ${ref}`;
    case 'task.status_changed': return `Status changed: ${ref}`;
    case 'invoice.paid': return `Invoice paid: ${ref}`;
    case 'quote.accepted': return `Quote accepted: ${ref}`;
    case 'leave.requested': return `Leave request pending`;
    case 'leave.decided': return `Leave request ${payload.decision}`;
    default: return `ordi notification`;
  }
}

const notifications: Consumer = {
  name: 'notifications',
  async handle(ev) {
    const p = ev.payload as any;
    switch (ev.type) {
      case 'task.assigned':
        await notify(p.assigneeIds ?? [], 'task.assigned', p.ref ?? null, p);
        break;
      case 'comment.mentioned':
        await notify(p.mentions ?? [], 'comment.mentioned', p.ref ?? null, p);
        break;
      case 'task.status_changed':
        await notify([...(p.assigneeIds ?? []), p.createdBy].filter(Boolean), 'task.status_changed', p.ref ?? null, p);
        break;
      case 'page.mentioned':
        await notify(p.mentions ?? [], 'comment.mentioned', p.ref ?? null, p);
        break;
      case 'payment.recorded':
      case 'invoice.paid':
        await notify([p.createdBy].filter(Boolean), 'invoice.paid', p.ref ?? null, p);
        break;
      case 'quote.accepted':
        await notify([p.ownerId, p.createdBy].filter(Boolean), 'quote.accepted', p.ref ?? null, p);
        break;
      case 'leave.requested':
        await notify([p.approverId].filter(Boolean), 'leave.requested', ev.aggregateId, p);
        break;
      case 'leave.decided':
        await notify([p.employeeUserId].filter(Boolean), 'leave.decided', ev.aggregateId, p);
        break;
      case 'git.pr_merged':
        await notify(p.assigneeIds ?? [], 'task.status_changed', p.ref ?? null, p);
        break;
      default:
        break;
    }
  },
};

const sse: Consumer = {
  name: 'sse',
  async handle(ev) {
    const p = ev.payload as any;
    broadcaster.broadcast({
      event: ev.type,
      data: { aggregateType: ev.aggregateType, aggregateId: ev.aggregateId, ...p },
      projectScope: p.projectId ? [p.projectId] : undefined,
    });
  },
};

/** Git status automations (PRD §13.1): pr_opened/merged/branch_created → status. */
const automations: Consumer = {
  name: 'automations',
  async handle(ev) {
    if (!ev.type.startsWith('git.')) return;
    const p = ev.payload as any;
    if (!p.taskId || !p.projectId) return;
    const trigger = ev.type.replace('git.', ''); // pr_opened | pr_merged | pr_closed | branch_created
    const { db } = getDb();
    const [rule] = await db.select().from(schema.gitAutomationRules)
      .where(and(eq(schema.gitAutomationRules.projectId, p.projectId), eq(schema.gitAutomationRules.trigger, trigger)));
    if (!rule) return;
    const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, p.taskId));
    if (!task || task.statusId === rule.targetStatusId) return;
    await db.update(schema.tasks).set({ statusId: rule.targetStatusId }).where(eq(schema.tasks.id, p.taskId));
    await writeActivity(db, {
      entityType: 'task', entityId: p.taskId, action: 'status_changed',
      before: { statusId: task.statusId }, after: { statusId: rule.targetStatusId },
      actorType: 'integration',
    });
  },
};

const webhooks: Consumer = {
  name: 'webhooks',
  async handle(ev) {
    const { db } = getDb();
    const subs = await db.select().from(schema.webhookSubscriptions).where(eq(schema.webhookSubscriptions.active, true));
    const matching = subs.filter((s) => (s.eventTypes as string[]).includes(ev.type));
    for (const sub of matching) {
      const body = JSON.stringify({ type: ev.type, aggregateType: ev.aggregateType, aggregateId: ev.aggregateId, payload: ev.payload, occurredAt: ev.occurredAt });
      const signature = hmacSha256(sub.secret, body);
      const deliveryId = ulid();
      try {
        const res = await fetch(sub.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Ordi-Signature': signature, 'X-Ordi-Event': ev.type },
          body,
          signal: AbortSignal.timeout(10_000),
        });
        await db.insert(schema.webhookDeliveries).values({
          id: deliveryId, subscriptionId: sub.id, eventId: ev.id, attempt: 1,
          status: res.ok ? 'delivered' : 'failed', responseCode: res.status,
        });
        if (!res.ok) throw new Error(`webhook ${sub.url} responded ${res.status}`);
      } catch (e) {
        await db.insert(schema.webhookDeliveries).values({
          id: deliveryId, subscriptionId: sub.id, eventId: ev.id, attempt: 1,
          status: 'failed', responseBody: e instanceof Error ? e.message : String(e),
        }).catch(() => {});
        throw e; // relay retries with backoff
      }
    }
  },
};

export const consumers: Consumer[] = [sse, notifications, automations, webhooks];

export function logConsumers(): void {
  logger.info({ consumers: consumers.map((c) => c.name) }, 'event consumers registered');
}
