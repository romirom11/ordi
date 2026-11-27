/**
 * Event consumers (PRD §3.3 subscribers): notifications, SSE, automations,
 * outbound webhooks. All idempotent – dedup is handled by the relay via
 * processed_events, and each handler is safe to re-run.
 */
import { getDb, schema, eq, and, desc, isNull } from '@ordi/db';
import { ulid } from 'ulid';
import type { DomainEvent } from '@ordi/shared';
import { broadcaster, type SSEMessage } from '../core/events';
import { enqueueEmail, type QueuedEmailInput } from './email-delivery';
import { appLink, asLocale, loadBranding, renderEmail, tr, type Branding } from '../lib/email-templates';
import { hmacSha256, decrypt } from '../lib/crypto';
import { postSlackMessage } from '../domains/integrations/oauth';
import { writeActivity } from '../core/activity';
import { logger } from '../lib/logger';
import { env } from '../env';
import { salesWork, summarizeSalesWork } from '../domains/crm/work';
import { queueRun, activeRunForTask } from '../domains/agents/runs';
import { agentProfilesAmong } from '../domains/agents/profiles';
import { userCanOpenProject } from '../core/access';

export interface Consumer {
  name: string;
  handle: (ev: DomainEvent) => Promise<void>;
}

interface NotifyOptions {
  /**
   * Whoever caused the event. They already know what they did, so they are
   * dropped from the audience – assigning a task to yourself or moving your
   * own task used to notify you about your own click.
   */
  actorId?: string | null;
  /**
   * The project the news is about. Recipients who cannot open it now – moved
   * out, removed, a private project – are skipped: a task title and status
   * must not reach someone the project is closed to.
   */
  projectId?: string | null;
  /**
   * The owner of the person's own agent that caused the event. Its routine
   * work (comments, status moves) is theirs already and would bury them;
   * only a question put to them – an @-mention – reaches them.
   */
  quietFor?: string | null;
}

/**
 * Types that reach a personal agent's owner even though the agent caused
 * them: a question put to them, on a task or on a knowledge-base page.
 */
const REACHES_OWNER = new Set(['comment.mentioned', 'page.mentioned']);

async function notify(
  eventId: string,
  userIds: (string | null | undefined)[],
  type: string,
  entityRef: string | null,
  payload: Record<string, unknown>,
  options: NotifyOptions = {},
): Promise<void> {
  const unique = [...new Set(userIds)].filter((id): id is string => Boolean(id) && id !== options.actorId
    && !(options.quietFor && id === options.quietFor && !REACHES_OWNER.has(type)));
  if (!unique.length) return;
  const { db } = getDb();
  let branding: Branding | null = null;

  for (const userId of unique) {
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
    // A deactivated account has no one reading it, and an agent has no bell:
    // both only added rows nobody would ever open.
    if (!user || !user.isActive || user.actorType !== 'user') continue;
    if (options.projectId && !(await userCanOpenProject(userId, options.projectId))) continue;
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
        outcome: (payload.outcome as string) ?? '',
        summary: (payload.summary as string) ?? '',
        label: (payload.label as string) ?? '',
        expiresAt: (payload.expiresAt as string) ?? '',
        workspace: branding.workspaceName,
      };
      const known = templateFor(type);
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

    const [inserted] = await db.transaction(async (tx) => {
      const rows = await tx.insert(schema.notifications).values({
        id: ulid(), userId, type, dedupeKey, entityRef, payload,
      }).onConflictDoNothing({ target: schema.notifications.dedupeKey })
        .returning({ id: schema.notifications.id });
      if (email) await enqueueEmail(email, tx);
      return rows;
    });

    /**
     * Tell that one person about the row that now exists, rather than letting
     * every client guess from the business event whether it was addressed to
     * them. A task event streams to the whole project, so the guess turned one
     * person's assignment into a notification for everyone; and the guess ran
     * before this consumer had written anything, so the bell refreshed too
     * early and looked empty. A replay that deduped inserts nothing and stays
     * silent.
     */
    if (inserted) {
      broadcaster.broadcast({
        event: 'notification.created',
        data: { id: inserted.id, type, entityRef, payload },
        userScope: [userId],
      });
    }
  }
}

/**
 * Notification types with copy of their own. A type that is not here falls
 * back to `generic`, which says "there is an update" and nothing more.
 */
const NOTIFY_KEYS = new Set([
  'task.assigned', 'comment.mentioned', 'comment.created', 'task.status_changed',
  'invoice.paid', 'payment.recorded', 'quote.accepted', 'quote.declined',
  'leave.requested', 'leave.decided',
  'sales.work_digest', 'agent.run_finished', 'agent.needs_input',
]);

/**
 * Types that borrow another type's copy. The stored type is what happened – it
 * is what the bell labels the row and what the deep link is built from – while
 * the email reads the same as its next of kin.
 */
const NOTIFY_TEMPLATE_ALIASES: Record<string, string> = {
  'page.mentioned': 'comment.mentioned',
  'git.pr_merged': 'task.status_changed',
};

function templateFor(type: string): string {
  const alias = NOTIFY_TEMPLATE_ALIASES[type];
  if (alias) return alias;
  return NOTIFY_KEYS.has(type) ? type : 'generic';
}

/**
 * In-app path a notification opens. Mirrored by notifLink() in
 * apps/web/src/lib/notifications.ts: the email button and the bell row must
 * land the reader in the same place.
 */
export function notificationPath(type: string, payload: Record<string, unknown>): string | null {
  const projectId = payload.projectId as string | undefined;
  const taskId = (payload.taskId as string | undefined) ?? (payload.id as string | undefined);
  const pageId = payload.pageId as string | undefined;
  const spaceId = payload.spaceId as string | undefined;
  // A KB mention lands on the page, not on an unrelated task list.
  if (pageId && spaceId) return `/kb/${spaceId}/${pageId}`;
  if (type.startsWith('task.') || type.startsWith('comment.') || type.startsWith('git.')
    || type === 'agent.run_finished' || type === 'agent.needs_input') {
    return projectId && taskId ? `/projects/${projectId}/tasks/${taskId}` : '/my-tasks';
  }
  if (type === 'invoice.paid' || type === 'payment.recorded') {
    return payload.invoiceId ? `/finance/invoices/${payload.invoiceId as string}` : '/finance';
  }
  if (type.startsWith('quote.')) return '/finance';
  if (type.startsWith('leave.')) return '/people';
  if (type === 'sales.work_digest') return '/crm/work';
  if (type.startsWith('agent.credential_')) return '/settings/agents';
  return null;
}

function notificationLink(type: string, payload: Record<string, unknown>): string | null {
  const path = notificationPath(type, payload);
  return path ? appLink(path) : null;
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

/** Who looks after the client a document belongs to. */
async function companyOwnerId(companyId: string): Promise<string | null> {
  const { db } = getDb();
  const [company] = await db.select({ ownerId: schema.companies.ownerId })
    .from(schema.companies).where(eq(schema.companies.id, companyId));
  return company?.ownerId ?? null;
}

/**
 * The people a task's updates concern: whoever raised it, whoever is assigned
 * to it and – for events on the comment thread – whoever has already answered
 * on it. Read from current state rather than from the event, because the
 * things that move a task furthest (a webhook, an automation, an agent) know
 * the task and not its people.
 */
async function taskAudience(taskId: string, opts: { commenters?: boolean } = {}): Promise<string[]> {
  const { db } = getDb();
  const [task] = await db.select({ reporterId: schema.tasks.reporterId })
    .from(schema.tasks).where(eq(schema.tasks.id, taskId));
  const assignees = await db.select({ userId: schema.taskAssignees.userId })
    .from(schema.taskAssignees).where(eq(schema.taskAssignees.taskId, taskId));
  const audience = [task?.reporterId, ...assignees.map((a) => a.userId)];
  if (opts.commenters) {
    const commenters = await db.selectDistinct({ authorId: schema.comments.authorId })
      .from(schema.comments)
      .where(and(eq(schema.comments.taskId, taskId), isNull(schema.comments.deletedAt)));
    audience.push(...commenters.map((c) => c.authorId));
  }
  return audience.filter((id): id is string => Boolean(id));
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
  if (taskId && ev.aggregateType === 'agent_run') {
    const [task] = await db.select({ number: schema.tasks.number, createdBy: schema.tasks.createdBy, reporterId: schema.tasks.reporterId, projectId: schema.tasks.projectId })
      .from(schema.tasks).where(eq(schema.tasks.id, taskId));
    if (task) {
      const [project] = await db.select({ key: schema.projects.key }).from(schema.projects).where(eq(schema.projects.id, task.projectId));
      if (!p.ref && project) p.ref = `${project.key}-${task.number}`;
      if (!p.createdBy) p.createdBy = task.createdBy;
      if (!('reporterId' in p)) p.reporterId = task.reporterId;
    }
    if (ev.actorId) {
      const [agent] = await db.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, ev.actorId));
      if (agent?.name) p.actorName = agent.name;
    }
  }
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
  /**
   * Finance events name the document, never the people: without this an
   * invoice or quote notification had no recipient at all, and its email said
   * “Invoice  was paid” with a link to the finance index rather than the
   * document. Whoever raised it and whoever owns the client both want to know.
   */
  if (ev.type === 'invoice.paid' || ev.type === 'payment.recorded') {
    const invoiceId = (p.invoiceId as string | undefined)
      ?? (ev.aggregateType === 'invoice' ? ev.aggregateId : undefined);
    if (invoiceId) {
      p.invoiceId = invoiceId;
      const [inv] = await db.select({ number: schema.invoices.number, createdBy: schema.invoices.createdBy, companyId: schema.invoices.companyId })
        .from(schema.invoices).where(eq(schema.invoices.id, invoiceId));
      if (inv) {
        if (!p.ref) p.ref = inv.number;
        if (!p.createdBy) p.createdBy = inv.createdBy;
        if (!p.ownerId) p.ownerId = await companyOwnerId(inv.companyId);
      }
    }
  }
  if (ev.type === 'quote.accepted' || ev.type === 'quote.declined') {
    const [quote] = await db.select({ number: schema.quotes.number, createdBy: schema.quotes.createdBy, companyId: schema.quotes.companyId })
      .from(schema.quotes).where(eq(schema.quotes.id, ev.aggregateId));
    if (quote) {
      if (!p.ref) p.ref = quote.number;
      if (!p.createdBy) p.createdBy = quote.createdBy;
      if (!p.ownerId) p.ownerId = await companyOwnerId(quote.companyId);
    }
  }
  // People and agents alike: "someone commented" says nothing about who.
  if (!p.actorName && ev.actorId && (ev.actorType === 'user' || ev.actorType === 'agent')) {
    const [actor] = await db.select({ name: schema.users.name })
      .from(schema.users).where(eq(schema.users.id, ev.actorId));
    if (actor?.name) p.actorName = actor.name;
  }
  return p;
}

/**
 * The person who set the task: its reporter. Events written before tasks had
 * one carry only createdBy, which is what the reporter was backfilled from.
 */
const reporterOf = (p: { reporterId?: string | null; createdBy?: string | null }): string | null | undefined =>
  ('reporterId' in p ? p.reporterId : p.createdBy);

const notifications: Consumer = {
  name: 'notifications',
  async handle(ev) {
    const p = (await enrichNotifyPayload(ev)) as any;
    // Nobody hears about their own action, and nobody about a project closed
    // to them; every case below passes this on.
    // Only news about a project's work is gated by the project: an invoice or a
    // leave request may name a project its finance or HR audience cannot open.
    const aboutProjectWork = /^(task|comment|agent|git)\./.test(ev.type);
    let quietFor: string | null = null;
    if (ev.actorType === 'agent' && ev.actorId) {
      const [ext] = await getDb().db.select({ kind: schema.externalAgents.kind, ownerUserId: schema.externalAgents.ownerUserId })
        .from(schema.externalAgents).where(eq(schema.externalAgents.userId, ev.actorId));
      if (ext?.kind === 'personal') quietFor = ext.ownerUserId;
    }
    const self = { actorId: ev.actorId, projectId: aboutProjectWork ? (p.projectId as string | undefined) ?? null : null, quietFor };
    switch (ev.type) {
      case 'task.assigned':
        await notify(ev.id, p.assigneeIds ?? [], 'task.assigned', p.ref ?? null, p, self);
        break;
      case 'comment.mentioned':
        await notify(ev.id, p.mentions ?? [], 'comment.mentioned', p.ref ?? null, p, self);
        break;
      case 'comment.created': {
        if (!p.taskId) break;
        // An ordi agent's comments are announced by its run events instead
        // (agent.needs_input, agent.run_finished): one run must not fill the
        // bell twice with the same news. An external agent has no runs, so
        // its comments are the only news there is and go out like a person's.
        if (ev.actorType === 'agent' && ev.actorId && (await agentProfilesAmong([ev.actorId])).size) break;
        // Everyone with a stake in the thread, not only the @-mentioned: the
        // author of a task heard nothing when someone answered on it, which is
        // the whole point of having raised it. The mentioned people are served
        // by comment.mentioned and would otherwise get the comment twice.
        const mentioned = new Set<string>(p.mentions ?? []);
        const audience = (await taskAudience(p.taskId, { commenters: true }))
          .filter((userId) => !mentioned.has(userId));
        await notify(ev.id, audience, 'comment.created', p.ref ?? null, p, self);
        break;
      }
      case 'task.status_changed':
        await notify(ev.id, [...(p.assigneeIds ?? []), reporterOf(p)], 'task.status_changed', p.ref ?? null, p, self);
        break;
      case 'page.mentioned':
        await notify(ev.id, p.mentions ?? [], 'page.mentioned', p.ref ?? null, p, self);
        break;
      case 'payment.recorded':
        await notify(ev.id, [p.createdBy, p.ownerId], 'payment.recorded', p.ref ?? null, p, self);
        break;
      case 'invoice.paid':
        await notify(ev.id, [p.createdBy, p.ownerId], 'invoice.paid', p.ref ?? null, p, self);
        break;
      case 'quote.accepted':
        await notify(ev.id, [p.ownerId, p.createdBy], 'quote.accepted', p.ref ?? null, p, self);
        break;
      // A declined quote is news too: the acceptance was notified and the
      // refusal went nowhere, so a quote could go quiet without anyone knowing.
      case 'quote.declined':
        await notify(ev.id, [p.ownerId, p.createdBy], 'quote.declined', p.ref ?? null, p, self);
        break;
      case 'leave.requested':
        await notify(ev.id, [p.approverId], 'leave.requested', ev.aggregateId, p, self);
        break;
      case 'leave.decided':
        await notify(ev.id, [p.employeeUserId], 'leave.decided', ev.aggregateId, p, self);
        break;
      case 'git.pr_merged':
        // The webhook knows the task, not its people – ask the task itself.
        await notify(ev.id, await taskAudience(p.taskId ?? ev.aggregateId), 'git.pr_merged', p.ref ?? null, p, self);
        break;
      case 'agent.run_finished': {
        // The person who assigned or commented hears how the run ended;
        // the task's reporter, if someone else, gets it too.
        if (p.status === 'succeeded' || p.status === 'failed') {
          await notify(ev.id, [p.requestedBy, reporterOf(p)], 'agent.run_finished', p.ref ?? null, { ...p, outcome: p.status }, self);
        }
        break;
      }
      case 'agent.needs_input':
        await notify(ev.id, [p.requestedBy, reporterOf(p)], 'agent.needs_input', p.ref ?? null, p, self);
        break;
      case 'sales.work_digest_due': {
        const digest = await liveSalesDigest(p.userId, p.localDate);
        if (digest) await notify(ev.id, [p.userId], 'sales.work_digest', null, digest, self);
        break;
      }
      default:
        break;
    }
  },
};

/**
 * Who may hear an event on the live stream, or null when nobody should. Each
 * family is held to the rule its read routes apply, and an event that matches
 * no rule is not broadcast: the payloads name invoices, deals, leave and
 * private projects, and the stream used to send anything unscoped to everyone.
 */
async function sseAudience(ev: DomainEvent): Promise<Omit<SSEMessage, 'event' | 'data'> | null> {
  const p = ev.payload as any;
  const t = ev.type;
  // A job for the notifications consumer, which tells the person through
  // notification.created; no client listens for the job itself.
  if (t === 'sales.work_digest_due') return null;
  // Before projectId: an invoice or a quote can name a project, and its
  // members are not, by that, readers of finance.
  if (t.startsWith('deal.')) return { permissionScope: ['deals.read'] };
  if (t.startsWith('invoice.') || t.startsWith('payment.') || t.startsWith('quote.')) return { permissionScope: ['finance.read'] };
  if (t.startsWith('applicant.')) return { permissionScope: ['people.recruit'] };
  if (t.startsWith('employee.')) {
    return { permissionScope: ['people.read', 'people.write'], involvedUsers: p.userId ? [p.userId] : [] };
  }
  if (t.startsWith('leave.')) {
    return { permissionScope: ['people.read'], involvedUsers: [p.employeeUserId, p.approverId].filter(Boolean) };
  }
  // A project event's project is its aggregate: project.created and
  // project.completed carry no projectId, and a private project's key went
  // workspace-wide.
  if (ev.aggregateType === 'project') return { projectScope: [ev.aggregateId] };
  // Someone else's time (who, how long, billable) is for time.read_all, as the
  // entry routes have it: seeing the project does not show it.
  if (t.startsWith('time.')) {
    return { projectScope: p.projectId ? [p.projectId] : undefined, permissionScope: ['time.read_all'], involvedUsers: p.userId ? [p.userId] : [] };
  }
  if (p.projectId) return { projectScope: [p.projectId] };
  if (t.startsWith('page.')) {
    const pageId = p.pageId ?? ev.aggregateId;
    const { db } = getDb();
    const [page] = await db.select({
      spaceId: schema.kbPages.spaceId, published: schema.kbPages.published,
      visibility: schema.kbPages.visibility, createdBy: schema.kbPages.createdBy, deletedAt: schema.kbPages.deletedAt,
    }).from(schema.kbPages).where(eq(schema.kbPages.id, pageId));
    // Deleted before the outbox got to it: as gone as the KB routes have it.
    if (!page || page.deletedAt) return null;
    return { spaceScope: [page.spaceId], page: { published: page.published, visibility: page.visibility, createdBy: page.createdBy } };
  }
  // KB events carry a spaceId – a private space's page titles must not stream workspace-wide.
  if (p.spaceId) return { spaceScope: [p.spaceId] };
  // Says only "some role changed": every client re-reads its own permissions.
  if (t === 'role.updated') return { workspaceWide: true };
  return null;
}

const sse: Consumer = {
  name: 'sse',
  async handle(ev) {
    const audience = await sseAudience(ev);
    if (!audience) return;
    broadcaster.broadcast({
      event: ev.type,
      // actorId travels with the payload so clients can skip pings for their own actions.
      data: { aggregateType: ev.aggregateType, aggregateId: ev.aggregateId, actorId: ev.actorId, ...(ev.payload as object) },
      ...audience,
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
    // Only a status of the task's own project: a rule pointing elsewhere is
    // skipped, and so is an event about a task that has since moved (the old
    // row is deleted, the new one lives in another project).
    const [rule] = await db.select({ targetStatusId: schema.gitAutomationRules.targetStatusId }).from(schema.gitAutomationRules)
      .innerJoin(schema.taskStatuses, and(
        eq(schema.taskStatuses.id, schema.gitAutomationRules.targetStatusId),
        eq(schema.taskStatuses.projectId, schema.gitAutomationRules.projectId),
      ))
      .where(and(eq(schema.gitAutomationRules.projectId, p.projectId), eq(schema.gitAutomationRules.trigger, trigger)));
    if (!rule) return;
    const [task] = await db.select().from(schema.tasks)
      .where(and(eq(schema.tasks.id, p.taskId), eq(schema.tasks.projectId, p.projectId), isNull(schema.tasks.deletedAt)));
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
        // A CSV import creates tasks by the dozen; one message each would bury the channel.
        if (p.source === 'import') return null;
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

/**
 * Agent dispatch (plan 2026-09-05-001, R12, R30): an assignment to an agent
 * queues a run; a human comment or @-mention on a task an agent is assigned
 * to queues a follow-up. Queueing is idempotent per task (one active run).
 */
/** Done or cancelled: nothing for an agent to do, whoever assigns or comments. */
async function taskIsClosed(taskId: string): Promise<boolean> {
  const { db } = getDb();
  const [row] = await db.select({ category: schema.taskStatuses.category })
    .from(schema.tasks).leftJoin(schema.taskStatuses, eq(schema.taskStatuses.id, schema.tasks.statusId))
    .where(eq(schema.tasks.id, taskId));
  return !row || row.category === 'done' || row.category === 'canceled';
}

const agents: Consumer = {
  name: 'agents',
  async handle(ev) {
    const p = ev.payload as any;
    if (ev.type === 'task.assigned') {
      if (ev.actorType === 'agent') return;
      const profiles = await agentProfilesAmong((p.assigneeIds as string[]) ?? []);
      if (!profiles.size || await taskIsClosed(p.taskId)) return;
      for (const [agentUserId, profile] of profiles) {
        if (!profile.enabled) continue;
        await queueRun({
          agentUserId, taskId: p.taskId, projectId: p.projectId, trigger: 'assigned',
          requestedBy: ev.actorId ?? null, actorType: ev.actorType ?? 'system',
        });
      }
      return;
    }
    if (ev.type === 'comment.created') {
      if (ev.actorType === 'agent' || !p.taskId) return;
      const { db } = getDb();
      const assignees = await db.select({ userId: schema.taskAssignees.userId }).from(schema.taskAssignees).where(eq(schema.taskAssignees.taskId, p.taskId));
      // A mentioned agent starts only if the commenter may assign it (R49):
      // addComment lists those in agentMentions. A comment.created written
      // before that list existed starts the task's agents only.
      const mentioned = new Set<string>((p.agentMentions as string[] | undefined) ?? []);
      const candidates = [...new Set([...assignees.map((a) => a.userId), ...mentioned])];
      const profiles = await agentProfilesAmong(candidates);
      // A closed task is not reopened by a comment: the agent would drag it back to review.
      if (!profiles.size || await taskIsClosed(p.taskId)) return;
      for (const [agentUserId, profile] of profiles) {
        if (!profile.enabled) continue;
        // A run in flight picks the comment up as a follow-up when it ends.
        if (await activeRunForTask(p.taskId, agentUserId)) continue;
        const [last] = await db.select({ sessionId: schema.agentRuns.sessionId, branch: schema.agentRuns.branch })
          .from(schema.agentRuns)
          .where(and(eq(schema.agentRuns.taskId, p.taskId), eq(schema.agentRuns.agentUserId, agentUserId)))
          .orderBy(desc(schema.agentRuns.createdAt)).limit(1);
        // Without a session to resume there is nothing to follow up on: the
        // run gets the full brief, with the comment among the others.
        await queueRun({
          agentUserId, taskId: p.taskId, projectId: p.projectId, trigger: last?.sessionId ? 'comment' : 'assigned',
          requestedBy: ev.actorId ?? null, commentId: p.commentId ?? ev.aggregateId, sessionId: last?.sessionId ?? null,
          branch: last?.branch ?? null, actorType: ev.actorType ?? 'user',
        });
      }
    }
  },
};

/**
 * `notifications` runs before `sse`, so the rows an event produces are
 * committed before that event reaches any client: whatever a client refreshes
 * on the event, it reads a bell that is already up to date. The other way
 * round the bell refetched too early and kept showing nothing until its next
 * poll a minute later.
 */
export const consumers: Consumer[] = [notifications, sse, automations, webhooks, slack, agents];

export function logConsumers(): void {
  logger.info({ consumers: consumers.map((c) => c.name) }, 'event consumers registered');
}
