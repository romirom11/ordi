/**
 * What a Slack notification says (PRD §13.2). Every message is Block Kit: one
 * section line where the entity's reference carries the deep link, plus a muted
 * context line naming the project, the people and the state – so a channel can
 * tell from the message alone whether it concerns them.
 *
 * `text` is the notification fallback, which is what a phone shows on the lock
 * screen. It is short and carries no URL on purpose: it used to be the whole
 * message body, so half of every push was a link with two ids in it.
 *
 * Delivery lives in the `slack` consumer – this module only decides the copy.
 */
import { getDb, schema, eq, inArray } from '@ordi/db';
import type { DomainEvent, EventType } from '@ordi/shared';
import { appLink } from '../lib/email-templates';
import { formatMoney } from '../lib/money';

export type SlackBlock =
  | { type: 'section'; text: { type: 'mrkdwn'; text: string } }
  | { type: 'context'; elements: { type: 'mrkdwn'; text: string }[] };

export interface SlackMessage {
  /** Notification/push fallback: one short line, no URL. */
  text: string;
  blocks: SlackBlock[];
  /** Project whose channel the message belongs to, for target resolution. */
  projectId: string | null;
}

/** Separator of the context line: "Finqbit · Assignee: Roman K. · Status: To Do". */
const CONTEXT_SEPARATOR = ' · ';

/**
 * Slack mrkdwn reads `<`, `>` and `&` as markup – angle brackets are its link
 * syntax – so a task called "Fix <script> parsing" rendered mutilated. Slack
 * turns the entities back into the original characters when it displays the
 * message, so escaped text reads exactly as the person typed it.
 */
function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Escaped human text, or null when there is none – an empty context part drops out. */
function esc(value: string | null | undefined): string | null {
  return value ? escapeMrkdwn(value) : null;
}

/** A `<url|label>` link: the label hides the URL behind a short reference. */
function link(url: string, label: string): string {
  // `|` and the escaped `>` would end the label early – neither can survive in it.
  return `<${url}|${escapeMrkdwn(label).replace(/\|/g, '/')}>`;
}

interface MessageInput {
  /** Section line as mrkdwn: human text in it must already be escaped. */
  headline: string;
  /** Push fallback as plain text – escaped here, so pass it raw. */
  fallback: string;
  /** Muted second line as mrkdwn; empty parts drop out. */
  context?: (string | null | undefined)[];
  projectId?: string | null;
}

function message(input: MessageInput): SlackMessage {
  const blocks: SlackBlock[] = [{ type: 'section', text: { type: 'mrkdwn', text: input.headline } }];
  const context = (input.context ?? []).filter(Boolean).join(CONTEXT_SEPARATOR);
  if (context) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: context }] });
  return { text: escapeMrkdwn(input.fallback), blocks, projectId: input.projectId ?? null };
}

// ─── The data a message names ────────────────────────────────────────────────

interface TaskCard {
  projectId: string;
  projectName: string;
  ref: string;
  title: string;
  statusName: string;
  assignees: string[];
  url: string;
}

/**
 * The task a task-, comment- or git-event is about, as it stands when the
 * worker runs. Read from the database rather than from the payload: the events
 * that move a task furthest (a webhook, an automation, an agent) carry ids and
 * nothing else, and the channel wants the title and the status.
 */
async function loadTaskCard(ev: DomainEvent): Promise<TaskCard | null> {
  const p = ev.payload as Record<string, unknown>;
  const taskId = (p.taskId as string | undefined)
    ?? (ev.aggregateType === 'task' ? ev.aggregateId : undefined);
  if (!taskId) return null;
  const { db } = getDb();
  const [row] = await db.select({
    number: schema.tasks.number,
    title: schema.tasks.title,
    projectId: schema.tasks.projectId,
    projectKey: schema.projects.key,
    projectName: schema.projects.name,
    statusName: schema.taskStatuses.name,
  }).from(schema.tasks)
    .leftJoin(schema.projects, eq(schema.projects.id, schema.tasks.projectId))
    .leftJoin(schema.taskStatuses, eq(schema.taskStatuses.id, schema.tasks.statusId))
    .where(eq(schema.tasks.id, taskId));
  // A task deleted between the event and this worker has nothing left to say.
  if (!row) return null;
  const assignees = await db.select({ name: schema.users.name })
    .from(schema.taskAssignees)
    .innerJoin(schema.users, eq(schema.users.id, schema.taskAssignees.userId))
    .where(eq(schema.taskAssignees.taskId, taskId));
  return {
    projectId: row.projectId,
    projectName: row.projectName ?? '',
    ref: (p.ref as string | undefined) ?? (row.projectKey ? `${row.projectKey}-${row.number}` : taskId),
    title: row.title,
    statusName: row.statusName ?? '',
    assignees: assignees.map((a) => a.name),
    url: appLink(`/projects/${row.projectId}/tasks/${taskId}`),
  };
}

function refLink(card: TaskCard): string {
  return link(card.url, card.ref);
}

/** "Finqbit · Assignee: Roman K. · Status: To Do" – parts a headline already says drop out. */
function taskContext(card: TaskCard, omit: { assignees?: boolean; status?: boolean } = {}): (string | null)[] {
  const label = card.assignees.length > 1 ? 'Assignees' : 'Assignee';
  return [
    esc(card.projectName),
    omit.assignees ? null
      : card.assignees.length ? `${label}: ${escapeMrkdwn(card.assignees.join(', '))}` : 'Unassigned',
    omit.status || !card.statusName ? null : `Status: ${escapeMrkdwn(card.statusName)}`,
  ];
}

async function userNames(userIds: unknown): Promise<string[]> {
  const ids = (Array.isArray(userIds) ? userIds : []).filter((id): id is string => typeof id === 'string');
  if (!ids.length) return [];
  const { db } = getDb();
  const rows = await db.select({ name: schema.users.name })
    .from(schema.users).where(inArray(schema.users.id, ids));
  return rows.map((r) => r.name);
}

/** Who caused the event, when that is a person or an agent with a name. */
async function actorName(ev: DomainEvent): Promise<string | null> {
  if (!ev.actorId) return null;
  const { db } = getDb();
  const [actor] = await db.select({ name: schema.users.name })
    .from(schema.users).where(eq(schema.users.id, ev.actorId));
  return actor?.name ?? null;
}

/** The client a document belongs to – the context a finance message needs most. */
async function companyName(companyId: string | null | undefined): Promise<string | null> {
  if (!companyId) return null;
  const { db } = getDb();
  const [company] = await db.select({ name: schema.companies.name })
    .from(schema.companies).where(eq(schema.companies.id, companyId));
  return company?.name ?? null;
}

// ─── One builder per event ───────────────────────────────────────────────────

type SlackMessageBuilder = (ev: DomainEvent) => Promise<SlackMessage | null>;

/**
 * The events that reach Slack, and what each one says. A channel is a shared
 * room, which is what decides the list: project and money news belong in it,
 * while the personal notification types stay out – a leave request, an agent
 * run or a sales digest is addressed to one person (and a KB mention would
 * carry titles out of a space that may be private). This registry is the only
 * list of Slack events there is: an event without an entry is not posted.
 */
const BUILDERS: Partial<Record<EventType, SlackMessageBuilder>> = {
  'task.created': async (ev) => {
    const card = await loadTaskCard(ev);
    if (!card) return null;
    return message({
      headline: `:sparkles: New task *${refLink(card)}*  ${escapeMrkdwn(card.title)}`,
      fallback: `New task ${card.ref}: ${card.title}`,
      context: taskContext(card),
      projectId: card.projectId,
    });
  },

  'task.assigned': async (ev) => {
    const card = await loadTaskCard(ev);
    if (!card) return null;
    // The payload names whoever was just added; the ones already on the task
    // are old news, so the context line leaves the assignees out here.
    const added = await userNames((ev.payload as Record<string, unknown>).assigneeIds);
    if (!added.length) return null;
    const names = added.join(', ');
    return message({
      headline: `:inbox_tray: *${refLink(card)}* assigned to *${escapeMrkdwn(names)}*  ${escapeMrkdwn(card.title)}`,
      fallback: `${card.ref} assigned to ${names}`,
      context: taskContext(card, { assignees: true }),
      projectId: card.projectId,
    });
  },

  'task.status_changed': async (ev) => {
    const card = await loadTaskCard(ev);
    if (!card) return null;
    return message({
      headline: `:arrows_counterclockwise: *${refLink(card)}* → *${escapeMrkdwn(card.statusName)}*  ${escapeMrkdwn(card.title)}`,
      fallback: `${card.ref} moved to ${card.statusName}`,
      context: taskContext(card, { status: true }),
      projectId: card.projectId,
    });
  },

  'comment.created': async (ev) => {
    const p = ev.payload as Record<string, unknown>;
    // A comment that @-mentions someone is announced by comment.mentioned:
    // one comment must not fill the channel twice.
    if (Array.isArray(p.mentions) && p.mentions.length) return null;
    const card = await loadTaskCard(ev);
    if (!card) return null;
    const author = await actorName(ev);
    const who = author ? `*${escapeMrkdwn(author)}* commented on` : 'New comment on';
    return message({
      headline: `:speech_balloon: ${who} *${refLink(card)}*  ${escapeMrkdwn(card.title)}`,
      fallback: author ? `${author} commented on ${card.ref}` : `New comment on ${card.ref}`,
      context: taskContext(card),
      projectId: card.projectId,
    });
  },

  'comment.mentioned': async (ev) => {
    const card = await loadTaskCard(ev);
    if (!card) return null;
    // "You were mentioned" reads as nonsense in a shared channel – name them.
    const mentioned = (await userNames((ev.payload as Record<string, unknown>).mentions)).join(', ');
    const author = await actorName(ev);
    const headline = mentioned && author
      ? `*${escapeMrkdwn(author)}* mentioned *${escapeMrkdwn(mentioned)}* in *${refLink(card)}*`
      : mentioned
        ? `*${escapeMrkdwn(mentioned)}* was mentioned in *${refLink(card)}*`
        : `Someone was mentioned in *${refLink(card)}*`;
    return message({
      headline: `:speech_balloon: ${headline}  ${escapeMrkdwn(card.title)}`,
      fallback: mentioned ? `${mentioned} mentioned in ${card.ref}` : `Mention in ${card.ref}`,
      context: taskContext(card),
      projectId: card.projectId,
    });
  },

  'git.pr_merged': async (ev) => {
    const card = await loadTaskCard(ev);
    if (!card) return null;
    return message({
      headline: `:twisted_rightwards_arrows: PR merged for *${refLink(card)}*  ${escapeMrkdwn(card.title)}`,
      fallback: `PR merged for ${card.ref}`,
      // Status included: a git automation may have moved the task on the merge.
      context: taskContext(card),
      projectId: card.projectId,
    });
  },

  'invoice.paid': async (ev) => {
    const invoice = await loadInvoice(ev.aggregateId);
    if (!invoice) return null;
    return message({
      headline: `:moneybag: Invoice *${link(invoice.url, invoice.number)}* was paid`,
      fallback: `Invoice ${invoice.number} was paid`,
      context: [esc(invoice.company), formatMoney(invoice.total, invoice.currency)],
    });
  },

  'payment.recorded': async (ev) => {
    const p = ev.payload as Record<string, unknown>;
    const invoice = await loadInvoice(p.invoiceId as string | undefined);
    if (!invoice) return null;
    // The payment that settled the invoice is announced as invoice.paid, which
    // is the better headline of the two – this one covers the part payments.
    if (invoice.status === 'paid') return null;
    const amount = formatMoney(p.amount as number | string | null, invoice.currency);
    const outstanding = Number(invoice.total) - Number(invoice.amountPaid);
    return message({
      headline: `:money_with_wings: Payment *${amount}* on invoice *${link(invoice.url, invoice.number)}*`,
      fallback: `Payment ${amount} recorded on invoice ${invoice.number}`,
      context: [
        esc(invoice.company),
        outstanding > 0 ? `Outstanding: ${formatMoney(outstanding, invoice.currency)}` : null,
      ],
    });
  },

  'quote.accepted': async (ev) => {
    const quote = await loadQuote(ev.aggregateId);
    if (!quote) return null;
    return message({
      headline: `:handshake: Quote *${link(quote.url, quote.number)}* was accepted`,
      fallback: `Quote ${quote.number} was accepted`,
      context: [esc(quote.company), formatMoney(quote.total, quote.currency)],
    });
  },

  'quote.declined': async (ev) => {
    const quote = await loadQuote(ev.aggregateId);
    if (!quote) return null;
    return message({
      headline: `:x: Quote *${link(quote.url, quote.number)}* was declined`,
      fallback: `Quote ${quote.number} was declined`,
      context: [
        esc(quote.company),
        quote.declineComment ? `Reason: ${escapeMrkdwn(quote.declineComment)}` : null,
      ],
    });
  },

  'deal.won': async (ev) => {
    const deal = await loadDeal(ev);
    if (!deal) return null;
    return message({
      headline: `:tada: Deal won: *${link(deal.url, deal.title)}*`,
      fallback: `Deal won: ${deal.title}`,
      context: [esc(deal.company), deal.amount],
    });
  },

  'deal.lost': async (ev) => {
    const deal = await loadDeal(ev);
    if (!deal) return null;
    return message({
      headline: `:disappointed: Deal lost: *${link(deal.url, deal.title)}*`,
      fallback: `Deal lost: ${deal.title}`,
      context: [
        esc(deal.company),
        deal.amount,
        deal.lostReason ? `Reason: ${escapeMrkdwn(deal.lostReason)}` : null,
      ],
    });
  },

  'project.completed': async (ev) => {
    const { db } = getDb();
    const projectId = ev.aggregateId;
    const [project] = await db.select({ name: schema.projects.name, key: schema.projects.key, companyId: schema.projects.companyId })
      .from(schema.projects).where(eq(schema.projects.id, projectId));
    if (!project) return null;
    return message({
      headline: `:checkered_flag: Project *${link(appLink(`/projects/${projectId}`), project.name)}* completed`,
      fallback: `Project ${project.name} completed`,
      context: [esc(project.key), esc(await companyName(project.companyId))],
      projectId,
    });
  },
};

interface InvoiceCard {
  number: string; status: string; total: string; amountPaid: string;
  currency: string; company: string | null; url: string;
}

async function loadInvoice(invoiceId: string | undefined): Promise<InvoiceCard | null> {
  if (!invoiceId) return null;
  const { db } = getDb();
  const [row] = await db.select({
    number: schema.invoices.number,
    status: schema.invoices.status,
    total: schema.invoices.total,
    amountPaid: schema.invoices.amountPaid,
    currency: schema.invoices.currency,
    companyId: schema.invoices.companyId,
  }).from(schema.invoices).where(eq(schema.invoices.id, invoiceId));
  if (!row) return null;
  return { ...row, company: await companyName(row.companyId), url: appLink(`/finance/invoices/${invoiceId}`) };
}

interface QuoteCard {
  number: string; total: string; currency: string;
  declineComment: string | null; company: string | null; url: string;
}

async function loadQuote(quoteId: string): Promise<QuoteCard | null> {
  const { db } = getDb();
  const [row] = await db.select({
    number: schema.quotes.number,
    total: schema.quotes.total,
    currency: schema.quotes.currency,
    declineComment: schema.quotes.declineComment,
    companyId: schema.quotes.companyId,
  }).from(schema.quotes).where(eq(schema.quotes.id, quoteId));
  if (!row) return null;
  // Quotes have no page of their own – the finance module is where they live.
  return { ...row, company: await companyName(row.companyId), url: appLink('/finance') };
}

interface DealCard { title: string; amount: string | null; company: string | null; lostReason: string | null; url: string }

async function loadDeal(ev: DomainEvent): Promise<DealCard | null> {
  const { db } = getDb();
  const p = ev.payload as Record<string, unknown>;
  const [row] = await db.select({
    title: schema.deals.title,
    amount: schema.deals.amount,
    currency: schema.deals.currency,
    companyId: schema.deals.companyId,
    lostReason: schema.deals.lostReason,
  }).from(schema.deals).where(eq(schema.deals.id, ev.aggregateId));
  if (!row) return null;
  return {
    title: row.title,
    amount: row.amount ? formatMoney(row.amount, row.currency) : null,
    company: await companyName(row.companyId),
    lostReason: (p.lostReason as string | undefined) ?? row.lostReason,
    url: appLink(`/deals/${ev.aggregateId}`),
  };
}

/**
 * The Slack copy for an event, or null when Slack has nothing to say about it –
 * an event nobody posts, or one whose news another event tells better.
 */
export async function buildSlackMessage(ev: DomainEvent): Promise<SlackMessage | null> {
  const build = BUILDERS[ev.type];
  return build ? build(ev) : null;
}
