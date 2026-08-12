/**
 * Event consumers (PRD §3.3 subscribers): notifications, SSE, automations,
 * outbound webhooks. All idempotent – dedup is handled by the relay via
 * processed_events, and each handler is safe to re-run.
 */
import { getDb, schema, eq, and, desc } from '@ordi/db';
import { ulid } from 'ulid';
import type { DomainEvent } from '@ordi/shared';
import { broadcaster } from '../core/events';
import { enqueueEmail, type QueuedEmailInput } from './email-delivery';
import { appLink, asLocale, loadBranding, renderEmail, tr, type Branding } from '../lib/email-templates';
import { hmacSha256, decrypt } from '../lib/crypto';
import { postSlackMessage } from '../domains/integrations/oauth';
import { writeActivity } from '../core/activity';
import { logger } from '../lib/logger';
import { env } from '../env';
import { salesWork, summarizeSalesWork } from '../domains/crm/work';

export interface Consumer {
  name: string;
  handle: (ev: DomainEvent) => Promise<void>;
}

async function notify(
  eventId: string,
  userIds: string[],
  type: string,
  entityRef: string | null,
  payload: Record<string, unknown>,
): Promise<void> {
  if (!userIds.length) return;
  const { db } = getDb();
  const unique = [...new Set(userIds)].filter(Boolean);
  let branding: Branding | null = null;

  for (const userId of unique) {
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
    if (!user) continue;
    const prefs = (user?.emailNotificationPrefs as Record<string, boolean>) ?? {};
    const dedupeKey = `${eventId}:notifications:${userId}:${type}`;
    let email: QueuedEmailInput | null = null;

    if (prefs[type] !== false && prefs.__all !== false) {
      branding ??= await loadBranding();
      const locale = asLocale(user.locale);
      const vars = {
        ref: (payload.ref as string) ?? entityRef ?? '',
        title: (payload.title as string) ?? '',
        status: (payload.statusName as string) ?? '',
        actor: (payload.actorName as string) ?? tr(locale, 'notify.someone'),
        decision: (payload.decision as string) ?? '',
        total: Number(payload.total ?? 0),
        overdue: Number(payload.overdue ?? 0),
        dueToday: Number(payload.dueToday ?? 0),
        upcoming: Number(payload.upcoming ?? 0),
        waitingReply: Number(payload.waitingReply ?? 0),
        nurtureDue: Number(payload.nurtureDue ?? 0),
        noNextAction: Number(payload.noNextAction ?? 0),
        workspace: branding.workspaceName,
      };
      const known = NOTIFY_KEYS.has(type) ? type : 'generic';
      const link = notificationLink(type, payload);
      const { html, text } = renderEmail({
        locale,
        branding,
        heading: tr(locale, `notify.${known}.heading`, vars),
        paragraphs: [tr(locale, `notify.${known}.body`, vars)],
        cta: link ? { label: tr(locale, 'notify.cta'), url: link } : undefined,
      });
      email = {
        idempotencyKey: `${eventId}:email:${userId}:${type}`,
        to: user.email,
        subject: tr(locale, `notify.${known}.subject`, vars),
        body: text,
        html,
      };
    }

    await db.transaction(async (tx) => {
      await tx.insert(schema.notifications).values({
        id: ulid(), userId, type, dedupeKey, entityRef, payload,
      }).onConflictDoNothing({ target: schema.notifications.dedupeKey });
      if (email) await enqueueEmail(email, tx);
    });
  }
}

const NOTIFY_KEYS = new Set([
  'task.assigned', 'comment.mentioned', 'task.status_changed',
  'invoice.paid', 'quote.accepted', 'leave.requested', 'leave.decided',
  'sales.work_digest',
]);

/** Deep link for a notification, mirroring the Slack consumer's targets. */
function notificationLink(type: string, payload: Record<string, unknown>): string | null {
  const projectId = payload.projectId as string | undefined;
  const taskId = (payload.taskId as string | undefined) ?? (payload.id as string | undefined);
  switch (type) {
    case 'task.assigned':
    case 'task.status_changed':
    case 'comment.mentioned':
      if (projectId && taskId) return appLink(`/projects/${projectId}/tasks/${taskId}`);
      // A KB page mention lands on the page, not on an unrelated task list.
      if (payload.pageId && payload.spaceId) {
        return appLink(`/kb/${payload.spaceId as string}/${payload.pageId as string}`);
      }
      return appLink('/my-tasks');
    case 'invoice.paid':
      return payload.invoiceId ? appLink(`/finance/invoices/${payload.invoiceId as string}`) : appLink('/finance');
    case 'quote.accepted':
      return appLink('/finance');
    case 'leave.requested':
    case 'leave.decided':
      return appLink('/people');
    case 'sales.work_digest':
      return appLink('/crm/work');
    default:
      return null;
  }
}

async function liveSalesDigest(userId: string, localDate: string): Promise<Record<string, unknown> | null> {
  const { db } = getDb();
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
  if (!user?.isActive) return null;
  const permissions = await db.select({ permission: schema.rolePermissions.permission })
    .from(schema.rolePermissions)
    .where(eq(schema.rolePermissions.roleId, user.roleId));
  const permissionSet = new Set(permissions.map((row) => row.permission));
  if (!permissionSet.has('crm.read')) return null;

  const work = await salesWork({
    userId,
    timezone: user.timezone,
    access: { permissions: permissionSet },
  }, { scope: 'mine', limit: 1 });
  const summary = summarizeSalesWork(work);
  return summary.total ? { userId, localDate, ...summary } : null;
}

/**
 * Fill the template vars an event's payload does not carry. Task events emit
 * lean payloads (ref/ids only), but the email says “{ref} «{title}» → {status}”
 * – without this the reader gets empty quotes and a subject that trails off.
 * Current DB state is the right answer here: the notification describes the
 * task as it stands when the worker runs.
 */
async function enrichNotifyPayload(ev: DomainEvent): Promise<Record<string, unknown>> {
  const { db } = getDb();
  const p = { ...(ev.payload as Record<string, unknown>) };
  const taskId = (p.taskId as string | undefined)
    ?? (ev.aggregateType === 'task' ? ev.aggregateId : undefined);
  if (taskId && (!p.title || !p.statusName)) {
    const [task] = await db.select({ title: schema.tasks.title, statusId: schema.tasks.statusId })
      .from(schema.tasks).where(eq(schema.tasks.id, taskId));
    if (task) {
      if (!p.title) p.title = task.title;
      if (!p.statusName && task.statusId) {
        const [st] = await db.select({ name: schema.taskStatuses.name })
          .from(schema.taskStatuses).where(eq(schema.taskStatuses.id, task.statusId));
        if (st?.name) p.statusName = st.name;
      }
    }
  }
  // A KB mention reuses the comment.mentioned template – give it the page title.
  if (!p.title && p.pageId) {
    const [page] = await db.select({ title: schema.kbPages.title })
      .from(schema.kbPages).where(eq(schema.kbPages.id, p.pageId as string));
    if (page?.title) p.title = page.title;
  }
  if (!p.actorName && ev.actorId && ev.actorType === 'user') {
    const [actor] = await db.select({ name: schema.users.name })
      .from(schema.users).where(eq(schema.users.id, ev.actorId));
    if (actor?.name) p.actorName = actor.name;
  }
  return p;
}

const notifications: Consumer = {
  name: 'notifications',
  async handle(ev) {
    const p = (await enrichNotifyPayload(ev)) as any;
    switch (ev.type) {
      case 'task.assigned':
        await notify(ev.id, p.assigneeIds ?? [], 'task.assigned', p.ref ?? null, p);
        break;
      case 'comment.mentioned':
        await notify(ev.id, p.mentions ?? [], 'comment.mentioned', p.ref ?? null, p);
        break;
      case 'task.status_changed':
        await notify(ev.id, [...(p.assigneeIds ?? []), p.createdBy].filter(Boolean), 'task.status_changed', p.ref ?? null, p);
        break;
      case 'page.mentioned':
        await notify(ev.id, p.mentions ?? [], 'comment.mentioned', p.ref ?? null, p);
        break;
      case 'payment.recorded':
      case 'invoice.paid':
        await notify(ev.id, [p.createdBy].filter(Boolean), 'invoice.paid', p.ref ?? null, p);
        break;
      case 'quote.accepted':
        await notify(ev.id, [p.ownerId, p.createdBy].filter(Boolean), 'quote.accepted', p.ref ?? null, p);
        break;
      case 'leave.requested':
        await notify(ev.id, [p.approverId].filter(Boolean), 'leave.requested', ev.aggregateId, p);
        break;
      case 'leave.decided':
        await notify(ev.id, [p.employeeUserId].filter(Boolean), 'leave.decided', ev.aggregateId, p);
        break;
      case 'git.pr_merged':
        await notify(ev.id, p.assigneeIds ?? [], 'task.status_changed', p.ref ?? null, p);
        break;
      case 'sales.work_digest_due': {
        const digest = await liveSalesDigest(p.userId, p.localDate);
        if (digest) await notify(ev.id, [p.userId], 'sales.work_digest', null, digest);
        break;
      }
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
      // actorId travels with the payload so clients can skip pings for their own actions.
      data: { aggregateType: ev.aggregateType, aggregateId: ev.aggregateId, actorId: ev.actorId, ...p },
      projectScope: p.projectId ? [p.projectId] : undefined,
      // KB events carry a spaceId – a private space's page titles must not
      // stream workspace-wide.
      spaceScope: !p.projectId && p.spaceId ? [p.spaceId] : undefined,
      userScope: ev.type === 'sales.work_digest_due' && p.userId ? [p.userId] : undefined,
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

/**
 * Slack notifications. For a subset of business events, post a human message to
 * Slack. Resolution order (Linear-style, webhooks kept as legacy fallback):
 *   1. project settings.slackChannelId + workspace bot token → chat.postMessage
 *   2. project settings.slackWebhookUrl (legacy incoming webhook)
 *   3. workspace_settings.integrations.slackWebhookUrl (legacy)
 *   4. skip silently
 * Delivery failures rethrow so the relay's retry/DLQ machinery applies.
 */
const SLACK_EVENTS = new Set([
  'task.created', 'task.status_changed', 'comment.mentioned',
  'deal.won', 'deal.lost', 'invoice.paid', 'project.completed',
]);

type SlackTarget =
  | { kind: 'bot'; channel: string; token: string }
  | { kind: 'webhook'; url: string }
  | null;

async function workspaceBotToken(): Promise<string | null> {
  const { db } = getDb();
  const [conn] = await db.select().from(schema.slackConnections)
    .orderBy(desc(schema.slackConnections.createdAt)).limit(1);
  if (!conn) return null;
  try { return decrypt(conn.botToken as string); } catch { return null; }
}

async function resolveSlackTarget(projectId: string | null): Promise<SlackTarget> {
  const { db } = getDb();
  if (projectId) {
    const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, projectId));
    const settings = (project?.settings as { slackChannelId?: string | null; slackWebhookUrl?: string | null } | undefined) ?? {};
    if (settings.slackChannelId) {
      const token = await workspaceBotToken();
      if (token) return { kind: 'bot', channel: settings.slackChannelId, token };
    }
    if (settings.slackWebhookUrl) return { kind: 'webhook', url: settings.slackWebhookUrl };
  }
  const [ws] = await db.select().from(schema.workspaceSettings).where(eq(schema.workspaceSettings.id, 'workspace'));
  const url = (ws?.integrations as { slackWebhookUrl?: string | null } | undefined)?.slackWebhookUrl;
  return url ? { kind: 'webhook', url } : null;
}

/** Build the Slack message + the project it belongs to (for webhook resolution). */
async function buildSlackMessage(ev: DomainEvent): Promise<{ text: string; projectId: string | null } | null> {
  const { db } = getDb();
  const p = ev.payload as any;
  const app = env.appUrl.replace(/\/$/, '');
  switch (ev.type) {
    case 'task.created':
    case 'task.status_changed': {
      const projectId: string | null = p.projectId ?? null;
      const taskId = ev.aggregateId;
      const [task] = await db.select({ title: schema.tasks.title, statusId: schema.tasks.statusId })
        .from(schema.tasks).where(eq(schema.tasks.id, taskId));
      const title = task?.title ?? '';
      const link = projectId ? `${app}/projects/${projectId}/tasks/${taskId}` : `${app}/my-tasks`;
      if (ev.type === 'task.created') {
        return { text: `:sparkles: New task *${p.ref ?? taskId}* – ${title}\n${link}`, projectId };
      }
      let statusName = '';
      if (task?.statusId) {
        const [st] = await db.select({ name: schema.taskStatuses.name })
          .from(schema.taskStatuses).where(eq(schema.taskStatuses.id, task.statusId));
        statusName = st?.name ?? '';
      }
      return { text: `:arrows_counterclockwise: Task *${p.ref ?? taskId}* → *${statusName}* – ${title}\n${link}`, projectId };
    }
    case 'comment.mentioned': {
      // aggregateId is the comment id; derive the task/project for the deep link.
      const [comment] = await db.select({ taskId: schema.comments.taskId })
        .from(schema.comments).where(eq(schema.comments.id, ev.aggregateId));
      let projectId: string | null = null;
      let link = app;
      if (comment?.taskId) {
        const [task] = await db.select({ projectId: schema.tasks.projectId })
          .from(schema.tasks).where(eq(schema.tasks.id, comment.taskId));
        projectId = task?.projectId ?? null;
        link = projectId ? `${app}/projects/${projectId}/tasks/${comment.taskId}` : app;
      }
      return { text: `:speech_balloon: You were mentioned in *${p.ref ?? 'a comment'}*\n${link}`, projectId };
    }
    case 'deal.won': {
      const amount = p.amount ? ` (${p.currency ?? ''} ${p.amount})` : '';
      return { text: `:tada: Deal won: *${p.title ?? ev.aggregateId}*${amount}\n${app}/deals`, projectId: null };
    }
    case 'deal.lost': {
      const [deal] = await db.select({ title: schema.deals.title })
        .from(schema.deals).where(eq(schema.deals.id, ev.aggregateId));
      const reason = p.lostReason ? ` – ${p.lostReason}` : '';
      return { text: `:disappointed: Deal lost: *${deal?.title ?? ev.aggregateId}*${reason}\n${app}/deals`, projectId: null };
    }
    case 'invoice.paid': {
      return { text: `:moneybag: Invoice *${p.number ?? ev.aggregateId}* was paid\n${app}/finance/invoices/${ev.aggregateId}`, projectId: null };
    }
    case 'project.completed': {
      const projectId = ev.aggregateId;
      const [project] = await db.select({ name: schema.projects.name })
        .from(schema.projects).where(eq(schema.projects.id, projectId));
      return { text: `:checkered_flag: Project *${p.key ?? project?.name ?? projectId}* completed\n${app}/projects/${projectId}`, projectId };
    }
    default:
      return null;
  }
}

const slack: Consumer = {
  name: 'slack',
  async handle(ev) {
    if (!SLACK_EVENTS.has(ev.type)) return;
    const msg = await buildSlackMessage(ev);
    if (!msg) return;
    const target = await resolveSlackTarget(msg.projectId);
    if (!target) return; // not configured – skip
    if (target.kind === 'bot') {
      await postSlackMessage(target.token, target.channel, msg.text); // throws → relay retries / DLQs
      return;
    }
    const res = await fetch(target.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: msg.text }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      const detail = `slack webhook responded ${res.status}`;
      logger.error({ event: ev.type, status: res.status }, detail);
      throw new Error(detail); // relay retries / DLQs
    }
  },
};

export const consumers: Consumer[] = [sse, notifications, automations, webhooks, slack];

export function logConsumers(): void {
  logger.info({ consumers: consumers.map((c) => c.name) }, 'event consumers registered');
}
