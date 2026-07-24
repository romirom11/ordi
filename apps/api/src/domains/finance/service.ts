/**
 * Finance domain services (PRD §11). The server is the sole authority for money:
 * all totals come from `computeDocumentTotals`, paid state from `computePaidState`,
 * overpayment from `wouldOverpay`, aging from `computeAging`, profitability from
 * `computeProfitability`/`utilization`. Status changes validate the transition maps.
 */
import {
  getDb, schema, eq, and, isNull, desc, inArray, gte, lte, sql,
} from '@ordi/db';
import { ulid } from 'ulid';
import {
  computeDocumentTotals, computePaidState, wouldOverpay, computeAging, computeProfitability, utilization,
  lineAmount, INVOICE_TRANSITIONS, QUOTE_TRANSITIONS,
  type InvoiceStatus, type QuoteStatus,
} from '@ordi/shared';
import type { Actor } from '../../context';
import { err } from '../../lib/errors';
import { writeActivity } from '../../core/activity';
import { emit } from '../../core/events';
import { assertVersion } from '../../core/locking';
import { queueEmail } from '../../lib/email';
import { nextNumber } from '../../workers/scheduled';
import { env } from '../../env';
import { renderInvoicePdf, renderQuotePdf } from './pdf';

// ─── helpers ───────────────────────────────────────────────────────────────
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

interface InvoiceRow { dueDate: string; status: string }
export function isOverdue(inv: InvoiceRow): boolean {
  return !!inv.dueDate && inv.dueDate < today() && inv.status !== 'paid' && inv.status !== 'canceled';
}
function withOverdue<T extends InvoiceRow>(inv: T): T & { is_overdue: boolean } {
  return { ...inv, is_overdue: isOverdue(inv) };
}

function assertTransition(map: Record<string, string[]>, from: string, to: string): void {
  if (from === to) return;
  if (!map[from]?.includes(to)) throw err.domain(`Invalid status transition ${from} -> ${to}`);
}

interface ItemInput { description: string; quantity: number; unitPrice: number; taxRateId?: string | null; position?: number; source?: string }

async function resolveTaxRates(items: ItemInput[]): Promise<Map<string, number>> {
  const { db } = getDb();
  const ids = [...new Set(items.map((i) => i.taxRateId).filter((x): x is string => !!x))];
  if (!ids.length) return new Map();
  const rows = await db.select().from(schema.taxRates).where(inArray(schema.taxRates.id, ids));
  return new Map(rows.map((r) => [r.id, Number(r.ratePercent)]));
}

function docTotals(items: ItemInput[], rateMap: Map<string, number>, discountType?: string, discountValue?: number, discountBeforeTax?: boolean) {
  return computeDocumentTotals({
    items: items.map((i) => ({
      quantity: i.quantity,
      unitPrice: i.unitPrice,
      taxRatePercent: i.taxRateId ? rateMap.get(i.taxRateId) ?? 0 : 0,
    })),
    discountType: (discountType as 'none' | 'percent' | 'fixed') ?? 'none',
    discountValue: discountValue ?? 0,
    discountBeforeTax: discountBeforeTax ?? true,
  });
}

async function insertInvoiceItems(invoiceId: string, items: ItemInput[]): Promise<string[]> {
  const { db } = getDb();
  const ids: string[] = [];
  for (const [i, it] of items.entries()) {
    const id = ulid();
    ids.push(id);
    await db.insert(schema.invoiceItems).values({
      id, invoiceId, description: it.description, quantity: String(it.quantity),
      unitPrice: String(it.unitPrice), taxRateId: it.taxRateId ?? null,
      amount: String(lineAmount({ quantity: it.quantity, unitPrice: it.unitPrice })),
      position: String(it.position ?? (i + 1) * 1000), source: it.source ?? 'manual',
    });
  }
  return ids;
}

async function insertQuoteItems(quoteId: string, items: ItemInput[]): Promise<string[]> {
  const { db } = getDb();
  const ids: string[] = [];
  for (const [i, it] of items.entries()) {
    const id = ulid();
    ids.push(id);
    await db.insert(schema.quoteItems).values({
      id, quoteId, description: it.description, quantity: String(it.quantity),
      unitPrice: String(it.unitPrice), taxRateId: it.taxRateId ?? null,
      amount: String(lineAmount({ quantity: it.quantity, unitPrice: it.unitPrice })),
      position: String(it.position ?? (i + 1) * 1000),
    });
  }
  return ids;
}

async function assertClientProject(projectId: string): Promise<void> {
  const { db } = getDb();
  const [p] = await db.select({ kind: schema.projects.kind })
    .from(schema.projects).where(and(eq(schema.projects.id, projectId), isNull(schema.projects.deletedAt)));
  if (!p) throw err.validation('Project not found');
  if (p.kind !== 'client') throw err.domain('An invoice cannot be attached to an internal project (PRD §5.4)', { projectId });
}

async function getWorkspace() {
  const { db } = getDb();
  const [ws] = await db.select().from(schema.workspaceSettings).limit(1);
  return ws ?? null;
}

async function getCompanyRow(id: string) {
  const { db } = getDb();
  const [company] = await db.select().from(schema.companies).where(eq(schema.companies.id, id));
  if (!company) throw err.notFound('Company not found');
  return company;
}

// ─── Invoices ──────────────────────────────────────────────────────────────
export async function listInvoices(params: {
  status?: string; companyId?: string; projectId?: string; from?: string; to?: string; q?: string; limit: number;
}) {
  const { db } = getDb();
  const rows = await db.select().from(schema.invoices).where(and(
    isNull(schema.invoices.deletedAt),
    params.status ? eq(schema.invoices.status, params.status) : undefined,
    params.companyId ? eq(schema.invoices.companyId, params.companyId) : undefined,
    params.projectId ? eq(schema.invoices.projectId, params.projectId) : undefined,
    params.from ? gte(schema.invoices.issueDate, params.from) : undefined,
    params.to ? lte(schema.invoices.issueDate, params.to) : undefined,
    params.q ? sql`${schema.invoices.number} ilike ${'%' + params.q + '%'}` : undefined,
  )).orderBy(desc(schema.invoices.createdAt)).limit(params.limit + 1);
  return rows.map(withOverdue);
}

export async function getInvoiceRow(id: string) {
  const { db } = getDb();
  const [inv] = await db.select().from(schema.invoices)
    .where(and(eq(schema.invoices.id, id), isNull(schema.invoices.deletedAt)));
  if (!inv) throw err.notFound('Invoice not found');
  return inv;
}

export async function getInvoice(id: string) {
  const { db } = getDb();
  const inv = await getInvoiceRow(id);
  const [items, pays, credits] = await Promise.all([
    db.select().from(schema.invoiceItems).where(eq(schema.invoiceItems.invoiceId, id)).orderBy(schema.invoiceItems.position),
    db.select().from(schema.payments).where(eq(schema.payments.invoiceId, id)).orderBy(desc(schema.payments.date)),
    db.select().from(schema.creditNotes).where(eq(schema.creditNotes.invoiceId, id)).orderBy(desc(schema.creditNotes.date)),
  ]);
  return { ...withOverdue(inv), items, payments: pays, creditNotes: credits };
}

export async function createInvoice(actor: Actor, input: any) {
  const { db } = getDb();
  if (input.projectId) await assertClientProject(input.projectId);
  await getCompanyRow(input.companyId);
  const items: ItemInput[] = input.items ?? [];
  const rateMap = await resolveTaxRates(items);
  const totals = docTotals(items, rateMap, input.discountType, input.discountValue, input.discountBeforeTax);
  const id = ulid();
  const number = await nextNumber('invoice');
  await db.insert(schema.invoices).values({
    id, companyId: input.companyId, projectId: input.projectId ?? null, quoteId: input.quoteId ?? null,
    number, status: 'draft', currency: input.currency, issueDate: input.issueDate, dueDate: input.dueDate,
    language: input.language, discountType: input.discountType, discountValue: String(input.discountValue ?? 0),
    discountBeforeTax: input.discountBeforeTax ?? true, subtotal: String(totals.subtotal),
    taxTotal: String(totals.taxTotal), total: String(totals.total), notes: input.notes ?? '', terms: input.terms ?? '',
    publicToken: ulid(), source: 'manual', customFields: input.customFields ?? {}, createdBy: actor.userId,
  });
  await insertInvoiceItems(id, items);
  await writeActivity(db, { entityType: 'invoice', entityId: id, action: 'created', after: { number, total: totals.total }, actorId: actor.userId, actorType: actor.actorType });
  await emit({ type: 'invoice.created', aggregateType: 'invoice', aggregateId: id, payload: { number, companyId: input.companyId }, actorId: actor.userId, actorType: actor.actorType });
  return id;
}

export async function updateInvoice(actor: Actor, id: string, input: any) {
  const { db } = getDb();
  const before = await getInvoiceRow(id);
  assertVersion(before, input.version, withOverdue(before));
  const itemsChanged = input.items !== undefined;
  if (itemsChanged && before.status !== 'draft') {
    throw err.domain('Items are immutable after an invoice is sent; cancel and duplicate instead', { status: before.status });
  }
  if (input.projectId) await assertClientProject(input.projectId);

  const patch: Record<string, unknown> = {};
  for (const k of ['projectId', 'currency', 'issueDate', 'dueDate', 'language', 'notes', 'terms', 'customFields']) {
    if (input[k] !== undefined) patch[k] = input[k];
  }

  // Recompute totals when items or any discount field changed (draft only for items).
  const discountChanged = ['discountType', 'discountValue', 'discountBeforeTax'].some((k) => input[k] !== undefined);
  if (itemsChanged || discountChanged) {
    const items: ItemInput[] = itemsChanged
      ? input.items
      : (await db.select().from(schema.invoiceItems).where(eq(schema.invoiceItems.invoiceId, id))).map((r) => ({
          description: r.description, quantity: Number(r.quantity), unitPrice: Number(r.unitPrice), taxRateId: r.taxRateId, position: Number(r.position),
        }));
    const discountType = input.discountType ?? before.discountType;
    const discountValue = input.discountValue ?? Number(before.discountValue);
    const discountBeforeTax = input.discountBeforeTax ?? before.discountBeforeTax;
    const rateMap = await resolveTaxRates(items);
    const totals = docTotals(items, rateMap, discountType, discountValue, discountBeforeTax);
    patch.discountType = discountType;
    patch.discountValue = String(discountValue);
    patch.discountBeforeTax = discountBeforeTax;
    patch.subtotal = String(totals.subtotal);
    patch.taxTotal = String(totals.taxTotal);
    patch.total = String(totals.total);
    if (itemsChanged) {
      await db.delete(schema.invoiceItems).where(eq(schema.invoiceItems.invoiceId, id));
      await insertInvoiceItems(id, items);
    }
  }

  await db.update(schema.invoices).set(patch).where(and(eq(schema.invoices.id, id), eq(schema.invoices.version, before.version)));
  await writeActivity(db, { entityType: 'invoice', entityId: id, action: 'updated', before, after: patch, actorId: actor.userId, actorType: actor.actorType });
  return getInvoice(id);
}

export async function sendInvoice(actor: Actor, id: string, opts: { to?: string; subject?: string; body?: string }) {
  const { db } = getDb();
  const inv = await getInvoiceRow(id);
  if (inv.status === 'paid' || inv.status === 'canceled') throw err.domain(`Cannot send a ${inv.status} invoice`);
  const company = await getCompanyRow(inv.companyId);
  const workspace = await getWorkspace();
  const items = await db.select().from(schema.invoiceItems).where(eq(schema.invoiceItems.invoiceId, id)).orderBy(schema.invoiceItems.position);
  const pdf = renderInvoicePdf(inv as any, items as any, company as any, workspace as any);

  const isFirstSend = inv.status === 'draft';
  if (isFirstSend) {
    assertTransition(INVOICE_TRANSITIONS, inv.status, 'sent');
    await db.update(schema.invoices).set({ status: 'sent', sentAt: new Date() })
      .where(and(eq(schema.invoices.id, id), eq(schema.invoices.version, inv.version)));
  }

  const to = opts.to ?? company.billingEmail;
  const link = `${env.appUrl}/i/${inv.publicToken}`;
  if (to) {
    await queueEmail({
      to,
      subject: opts.subject ?? `Invoice ${inv.number}`,
      body: opts.body ?? `Please find invoice ${inv.number} attached. View online: ${link}`,
      attachments: [{ filename: `${inv.number}.pdf`, content: pdf, contentType: 'application/pdf' }],
    });
  }
  await writeActivity(db, { entityType: 'invoice', entityId: id, action: 'sent', before: { status: inv.status }, after: { status: 'sent', to }, actorId: actor.userId, actorType: actor.actorType });
  await emit({ type: 'invoice.sent', aggregateType: 'invoice', aggregateId: id, payload: { number: inv.number, companyId: inv.companyId, to }, actorId: actor.userId, actorType: actor.actorType });
  return getInvoice(id);
}

export async function cancelInvoice(actor: Actor, id: string) {
  const { db } = getDb();
  const inv = await getInvoiceRow(id);
  assertTransition(INVOICE_TRANSITIONS, inv.status, 'canceled');
  await db.update(schema.invoices).set({ status: 'canceled' })
    .where(and(eq(schema.invoices.id, id), eq(schema.invoices.version, inv.version)));
  // Unlink billed time entries so they become billable again (PRD §10.3).
  const itemRows = await db.select({ id: schema.invoiceItems.id }).from(schema.invoiceItems).where(eq(schema.invoiceItems.invoiceId, id));
  const itemIds = itemRows.map((r) => r.id);
  if (itemIds.length) {
    await db.update(schema.timeEntries).set({ invoiceItemId: null }).where(inArray(schema.timeEntries.invoiceItemId, itemIds));
  }
  await writeActivity(db, { entityType: 'invoice', entityId: id, action: 'canceled', before: { status: inv.status }, after: { status: 'canceled' }, actorId: actor.userId, actorType: actor.actorType });
  return getInvoice(id);
}

export async function duplicateInvoice(actor: Actor, id: string) {
  const { db } = getDb();
  const src = await getInvoiceRow(id);
  const items = await db.select().from(schema.invoiceItems).where(eq(schema.invoiceItems.invoiceId, id)).orderBy(schema.invoiceItems.position);
  const newId = ulid();
  const number = await nextNumber('invoice');
  await db.insert(schema.invoices).values({
    id: newId, companyId: src.companyId, projectId: src.projectId, quoteId: null, number, status: 'draft',
    currency: src.currency, issueDate: today(), dueDate: src.dueDate, language: src.language,
    discountType: src.discountType, discountValue: src.discountValue, discountBeforeTax: src.discountBeforeTax,
    subtotal: src.subtotal, taxTotal: src.taxTotal, total: src.total, notes: src.notes, terms: src.terms,
    publicToken: ulid(), source: 'manual', customFields: src.customFields, createdBy: actor.userId,
  });
  await insertInvoiceItems(newId, items.map((r) => ({
    description: r.description, quantity: Number(r.quantity), unitPrice: Number(r.unitPrice), taxRateId: r.taxRateId, position: Number(r.position), source: 'manual',
  })));
  await writeActivity(db, { entityType: 'invoice', entityId: newId, action: 'created', after: { duplicatedFrom: id, number }, actorId: actor.userId, actorType: actor.actorType });
  return newId;
}

export async function getInvoicePdfBuffer(id: string): Promise<{ buffer: Buffer; number: string }> {
  const { db } = getDb();
  const inv = await getInvoiceRow(id);
  const company = await getCompanyRow(inv.companyId);
  const workspace = await getWorkspace();
  const items = await db.select().from(schema.invoiceItems).where(eq(schema.invoiceItems.invoiceId, id)).orderBy(schema.invoiceItems.position);
  return { buffer: renderInvoicePdf(inv as any, items as any, company as any, workspace as any), number: inv.number };
}

export async function softDeleteInvoice(actor: Actor, id: string) {
  const { db } = getDb();
  const inv = await getInvoiceRow(id);
  await db.update(schema.invoices).set({ deletedAt: new Date() }).where(eq(schema.invoices.id, id));
  // free any time entries tied to this invoice
  const itemRows = await db.select({ id: schema.invoiceItems.id }).from(schema.invoiceItems).where(eq(schema.invoiceItems.invoiceId, id));
  const itemIds = itemRows.map((r) => r.id);
  if (itemIds.length) await db.update(schema.timeEntries).set({ invoiceItemId: null }).where(inArray(schema.timeEntries.invoiceItemId, itemIds));
  await writeActivity(db, { entityType: 'invoice', entityId: id, action: 'deleted', before: { number: inv.number }, actorId: actor.userId, actorType: actor.actorType });
}

// ─── Invoice from time (PRD §10.3) ───────────────────────────────────────────
export async function invoiceFromTime(actor: Actor, input: any) {
  const { db } = getDb();
  await getCompanyRow(input.companyId);
  // Restrict to the company's client projects.
  const projRows = await db.select({ id: schema.projects.id })
    .from(schema.projects)
    .where(and(inArray(schema.projects.id, input.projectIds), eq(schema.projects.companyId, input.companyId), eq(schema.projects.kind, 'client'), isNull(schema.projects.deletedAt)));
  const projectIds = projRows.map((r) => r.id);
  if (!projectIds.length) throw err.validation('No client projects for this company in the selection');

  const rows = await db.execute(sql`
    select te.id, te.task_id, te.user_id, te.duration_seconds, te.hourly_rate,
           t.title as task_title, u.name as user_name
    from time_entries te
    join tasks t on t.id = te.task_id
    join users u on u.id = te.user_id
    where te.project_id in (${sql.join(projectIds.map((p) => sql`${p}`), sql`, `)})
      and te.billable = true and te.invoice_item_id is null
      and te.started_at >= ${input.from} and te.started_at < ${input.to + 'T23:59:59.999Z'}
    order by te.started_at`) as any[];
  if (!rows.length) throw err.domain('No unbilled billable time entries in this period');

  // Group by (grouping dimension + rate) so each line keeps a single unit price.
  const groups = new Map<string, { description: string; hours: number; rate: number; entryIds: string[] }>();
  for (const r of rows) {
    const rate = Number(r.hourly_rate);
    const hours = Number(r.duration_seconds) / 3600;
    let dimKey: string; let description: string;
    if (input.grouping === 'user') { dimKey = `u:${r.user_id}`; description = `${r.user_name} — time`; }
    else if (input.grouping === 'single') { dimKey = 'single'; description = `Billable time ${input.from} — ${input.to}`; }
    else { dimKey = `t:${r.task_id}`; description = r.task_title; }
    const key = `${dimKey}|${rate}`;
    const g = groups.get(key) ?? { description, hours: 0, rate, entryIds: [] };
    g.hours += hours; g.entryIds.push(r.id);
    groups.set(key, g);
  }

  const items: ItemInput[] = [...groups.values()].map((g, i) => ({
    description: g.description, quantity: Math.round(g.hours * 100) / 100, unitPrice: g.rate, taxRateId: null, position: (i + 1) * 1000, source: 'time',
  }));
  const totals = docTotals(items, new Map());

  const id = ulid();
  const number = await nextNumber('invoice');
  const company = await getCompanyRow(input.companyId);
  const dueDate = addDays(today(), company.paymentTermsDays ?? 14);
  await db.insert(schema.invoices).values({
    id, companyId: input.companyId, projectId: projectIds.length === 1 ? projectIds[0] : null, number,
    status: 'draft', currency: company.defaultCurrency ?? 'USD', issueDate: today(), dueDate,
    subtotal: String(totals.subtotal), taxTotal: String(totals.taxTotal), total: String(totals.total),
    publicToken: ulid(), source: 'time', createdBy: actor.userId,
  });
  const itemIds = await insertInvoiceItems(id, items);
  // Link each entry to the created invoice item.
  const groupList = [...groups.values()];
  for (let i = 0; i < groupList.length; i++) {
    const itemId = itemIds[i];
    if (!itemId) continue;
    await db.update(schema.timeEntries).set({ invoiceItemId: itemId }).where(inArray(schema.timeEntries.id, groupList[i]!.entryIds));
  }
  await writeActivity(db, { entityType: 'invoice', entityId: id, action: 'created', after: { number, source: 'time', total: totals.total }, actorId: actor.userId, actorType: actor.actorType });
  await emit({ type: 'invoice.created', aggregateType: 'invoice', aggregateId: id, payload: { number, source: 'time', companyId: input.companyId }, actorId: actor.userId, actorType: actor.actorType });
  return id;
}

// ─── Payments ────────────────────────────────────────────────────────────────
async function settlement(invoiceId: string): Promise<{ payments: number[]; creditNotes: number[] }> {
  const { db } = getDb();
  const [pays, credits] = await Promise.all([
    db.select({ amount: schema.payments.amount }).from(schema.payments).where(eq(schema.payments.invoiceId, invoiceId)),
    db.select({ amount: schema.creditNotes.amount }).from(schema.creditNotes).where(eq(schema.creditNotes.invoiceId, invoiceId)),
  ]);
  return { payments: pays.map((p) => Number(p.amount)), creditNotes: credits.map((c) => Number(c.amount)) };
}

/** Recompute amount_paid + status from current payments & credit notes. */
async function reconcileInvoice(invoiceId: string): Promise<{ status: string; amountPaid: number; isFullyPaid: boolean }> {
  const { db } = getDb();
  const inv = await getInvoiceRow(invoiceId);
  const { payments, creditNotes } = await settlement(invoiceId);
  const state = computePaidState({ total: Number(inv.total), payments, creditNotes });
  let status: string;
  if (state.isFullyPaid) status = 'paid';
  else if (state.isPartiallyPaid) status = 'partially_paid';
  else status = inv.viewedAt ? 'viewed' : (inv.sentAt ? 'sent' : inv.status);
  await db.update(schema.invoices).set({ amountPaid: String(state.amountPaid), status })
    .where(eq(schema.invoices.id, invoiceId));
  return { status, amountPaid: state.amountPaid, isFullyPaid: state.isFullyPaid };
}

export async function listPayments(invoiceId: string) {
  const { db } = getDb();
  await getInvoiceRow(invoiceId);
  return db.select().from(schema.payments).where(eq(schema.payments.invoiceId, invoiceId)).orderBy(desc(schema.payments.date));
}

export async function recordPayment(actor: Actor, invoiceId: string, input: any) {
  const { db } = getDb();
  const inv = await getInvoiceRow(invoiceId);
  if (inv.status === 'canceled') throw err.domain('Cannot record a payment on a canceled invoice');
  const { payments, creditNotes } = await settlement(invoiceId);
  if (wouldOverpay({ total: Number(inv.total), existingPayments: payments, existingCreditNotes: creditNotes, newAmount: input.amount })) {
    throw err.domain('Payment would overpay the invoice', { total: Number(inv.total) });
  }
  const id = ulid();
  await db.insert(schema.payments).values({
    id, invoiceId, amount: String(input.amount), currency: input.currency, date: input.date,
    method: input.method, reference: input.reference ?? '', notes: input.notes ?? '', createdBy: actor.userId,
  });
  const rec = await reconcileInvoice(invoiceId);
  await writeActivity(db, { entityType: 'invoice', entityId: invoiceId, action: 'payment_recorded', after: { paymentId: id, amount: input.amount, status: rec.status }, actorId: actor.userId, actorType: actor.actorType });
  await emit({ type: 'payment.recorded', aggregateType: 'payment', aggregateId: id, payload: { invoiceId, amount: input.amount, number: inv.number }, actorId: actor.userId, actorType: actor.actorType });
  if (rec.isFullyPaid) {
    await emit({ type: 'invoice.paid', aggregateType: 'invoice', aggregateId: invoiceId, payload: { number: inv.number, companyId: inv.companyId }, actorId: actor.userId, actorType: actor.actorType });
  }
  return id;
}

export async function deletePayment(actor: Actor, paymentId: string) {
  const { db } = getDb();
  const [pay] = await db.select().from(schema.payments).where(eq(schema.payments.id, paymentId));
  if (!pay) throw err.notFound('Payment not found');
  await db.delete(schema.payments).where(eq(schema.payments.id, paymentId));
  const rec = await reconcileInvoice(pay.invoiceId);
  await writeActivity(db, { entityType: 'invoice', entityId: pay.invoiceId, action: 'payment_deleted', before: { paymentId, amount: pay.amount }, after: { status: rec.status }, actorId: actor.userId, actorType: actor.actorType });
}

// ─── Credit notes ─────────────────────────────────────────────────────────────
export async function listCreditNotes(invoiceId: string) {
  const { db } = getDb();
  await getInvoiceRow(invoiceId);
  return db.select().from(schema.creditNotes).where(eq(schema.creditNotes.invoiceId, invoiceId)).orderBy(desc(schema.creditNotes.date));
}

export async function createCreditNote(actor: Actor, invoiceId: string, input: any) {
  const { db } = getDb();
  const inv = await getInvoiceRow(invoiceId);
  const { payments, creditNotes } = await settlement(invoiceId);
  if (wouldOverpay({ total: Number(inv.total), existingPayments: payments, existingCreditNotes: creditNotes, newAmount: input.amount })) {
    throw err.domain('Credit note would exceed the invoice balance', { total: Number(inv.total) });
  }
  const id = ulid();
  await db.insert(schema.creditNotes).values({
    id, invoiceId, amount: String(input.amount), reason: input.reason, date: input.date, createdBy: actor.userId,
  });
  const rec = await reconcileInvoice(invoiceId);
  await writeActivity(db, { entityType: 'invoice', entityId: invoiceId, action: 'credit_note_created', after: { creditNoteId: id, amount: input.amount, status: rec.status }, actorId: actor.userId, actorType: actor.actorType });
  if (rec.isFullyPaid) {
    await emit({ type: 'invoice.paid', aggregateType: 'invoice', aggregateId: invoiceId, payload: { number: inv.number, companyId: inv.companyId, viaCreditNote: true }, actorId: actor.userId, actorType: actor.actorType });
  }
  return id;
}

// ─── Quotes ────────────────────────────────────────────────────────────────
export async function listQuotes(params: { status?: string; companyId?: string; projectId?: string; limit: number }) {
  const { db } = getDb();
  return db.select().from(schema.quotes).where(and(
    isNull(schema.quotes.deletedAt),
    params.status ? eq(schema.quotes.status, params.status) : undefined,
    params.companyId ? eq(schema.quotes.companyId, params.companyId) : undefined,
    params.projectId ? eq(schema.quotes.projectId, params.projectId) : undefined,
  )).orderBy(desc(schema.quotes.createdAt)).limit(params.limit + 1);
}

export async function getQuoteRow(id: string) {
  const { db } = getDb();
  const [q] = await db.select().from(schema.quotes).where(and(eq(schema.quotes.id, id), isNull(schema.quotes.deletedAt)));
  if (!q) throw err.notFound('Quote not found');
  return q;
}

export async function getQuote(id: string) {
  const { db } = getDb();
  const q = await getQuoteRow(id);
  const items = await db.select().from(schema.quoteItems).where(eq(schema.quoteItems.quoteId, id)).orderBy(schema.quoteItems.position);
  return { ...q, items };
}

export async function createQuote(actor: Actor, input: any) {
  const { db } = getDb();
  if (input.projectId) await assertClientProject(input.projectId);
  await getCompanyRow(input.companyId);
  const items: ItemInput[] = input.items ?? [];
  const rateMap = await resolveTaxRates(items);
  const totals = docTotals(items, rateMap, input.discountType, input.discountValue, input.discountBeforeTax);
  const id = ulid();
  const number = await nextNumber('quote');
  await db.insert(schema.quotes).values({
    id, companyId: input.companyId, projectId: input.projectId ?? null, number, status: 'draft',
    currency: input.currency, issueDate: input.issueDate, validUntil: input.validUntil ?? null, language: input.language,
    discountType: input.discountType, discountValue: String(input.discountValue ?? 0), subtotal: String(totals.subtotal),
    taxTotal: String(totals.taxTotal), total: String(totals.total), notes: input.notes ?? '', terms: input.terms ?? '',
    publicToken: ulid(), customFields: input.customFields ?? {}, createdBy: actor.userId,
  });
  await insertQuoteItems(id, items);
  await writeActivity(db, { entityType: 'quote', entityId: id, action: 'created', after: { number, total: totals.total }, actorId: actor.userId, actorType: actor.actorType });
  return id;
}

export async function updateQuote(actor: Actor, id: string, input: any) {
  const { db } = getDb();
  const before = await getQuoteRow(id);
  assertVersion(before, input.version, before);
  if (before.status !== 'draft') throw err.domain('A quote is not editable after it has been sent; duplicate it instead', { status: before.status });
  if (input.projectId) await assertClientProject(input.projectId);

  const patch: Record<string, unknown> = {};
  for (const k of ['projectId', 'currency', 'issueDate', 'validUntil', 'language', 'notes', 'terms', 'customFields']) {
    if (input[k] !== undefined) patch[k] = input[k];
  }
  const itemsChanged = input.items !== undefined;
  const discountChanged = ['discountType', 'discountValue'].some((k) => input[k] !== undefined);
  if (itemsChanged || discountChanged) {
    const items: ItemInput[] = itemsChanged
      ? input.items
      : (await db.select().from(schema.quoteItems).where(eq(schema.quoteItems.quoteId, id))).map((r) => ({
          description: r.description, quantity: Number(r.quantity), unitPrice: Number(r.unitPrice), taxRateId: r.taxRateId, position: Number(r.position),
        }));
    const discountType = input.discountType ?? before.discountType;
    const discountValue = input.discountValue ?? Number(before.discountValue);
    const rateMap = await resolveTaxRates(items);
    const totals = docTotals(items, rateMap, discountType, discountValue, true);
    patch.discountType = discountType;
    patch.discountValue = String(discountValue);
    patch.subtotal = String(totals.subtotal);
    patch.taxTotal = String(totals.taxTotal);
    patch.total = String(totals.total);
    if (itemsChanged) {
      await db.delete(schema.quoteItems).where(eq(schema.quoteItems.quoteId, id));
      await insertQuoteItems(id, items);
    }
  }
  await db.update(schema.quotes).set(patch).where(and(eq(schema.quotes.id, id), eq(schema.quotes.version, before.version)));
  await writeActivity(db, { entityType: 'quote', entityId: id, action: 'updated', before, after: patch, actorId: actor.userId, actorType: actor.actorType });
  return getQuote(id);
}

export async function sendQuote(actor: Actor, id: string, opts: { to?: string; subject?: string; body?: string }) {
  const { db } = getDb();
  const q = await getQuoteRow(id);
  if (['accepted', 'declined', 'expired'].includes(q.status)) throw err.domain(`Cannot send a ${q.status} quote`);
  const company = await getCompanyRow(q.companyId);
  const workspace = await getWorkspace();
  const items = await db.select().from(schema.quoteItems).where(eq(schema.quoteItems.quoteId, id)).orderBy(schema.quoteItems.position);
  const pdf = renderQuotePdf(q as any, items as any, company as any, workspace as any);

  if (q.status === 'draft') {
    assertTransition(QUOTE_TRANSITIONS, q.status, 'sent');
    await db.update(schema.quotes).set({ status: 'sent' }).where(and(eq(schema.quotes.id, id), eq(schema.quotes.version, q.version)));
  }
  const to = opts.to ?? company.billingEmail;
  const link = `${env.appUrl}/q/${q.publicToken}`;
  if (to) {
    await queueEmail({
      to,
      subject: opts.subject ?? `Quote ${q.number}`,
      body: opts.body ?? `Please find quote ${q.number} attached. View online: ${link}`,
      attachments: [{ filename: `${q.number}.pdf`, content: pdf, contentType: 'application/pdf' }],
    });
  }
  await writeActivity(db, { entityType: 'quote', entityId: id, action: 'sent', before: { status: q.status }, after: { status: 'sent', to }, actorId: actor.userId, actorType: actor.actorType });
  return getQuote(id);
}

export async function convertQuote(actor: Actor, id: string) {
  const { db } = getDb();
  const q = await getQuoteRow(id);
  if (q.convertedInvoiceId) throw err.domain('Quote already converted', { invoiceId: q.convertedInvoiceId });
  const items = await db.select().from(schema.quoteItems).where(eq(schema.quoteItems.quoteId, id)).orderBy(schema.quoteItems.position);
  const company = await getCompanyRow(q.companyId);
  const invoiceId = ulid();
  const number = await nextNumber('invoice');
  const dueDate = addDays(today(), company.paymentTermsDays ?? 14);
  await db.insert(schema.invoices).values({
    id: invoiceId, companyId: q.companyId, projectId: q.projectId, quoteId: q.id, number, status: 'draft',
    currency: q.currency, issueDate: today(), dueDate, language: q.language, discountType: q.discountType,
    discountValue: q.discountValue, subtotal: q.subtotal, taxTotal: q.taxTotal, total: q.total,
    notes: q.notes, terms: q.terms, publicToken: ulid(), source: 'quote', createdBy: actor.userId,
  });
  await insertInvoiceItems(invoiceId, items.map((r) => ({
    description: r.description, quantity: Number(r.quantity), unitPrice: Number(r.unitPrice), taxRateId: r.taxRateId, position: Number(r.position), source: 'quote',
  })));
  await db.update(schema.quotes).set({ convertedInvoiceId: invoiceId }).where(eq(schema.quotes.id, id));
  await writeActivity(db, { entityType: 'invoice', entityId: invoiceId, action: 'created', after: { fromQuote: id, number }, actorId: actor.userId, actorType: actor.actorType });
  await emit({ type: 'invoice.created', aggregateType: 'invoice', aggregateId: invoiceId, payload: { number, source: 'quote', quoteId: id, companyId: q.companyId }, actorId: actor.userId, actorType: actor.actorType });
  return invoiceId;
}

export async function getQuotePdfBuffer(id: string): Promise<{ buffer: Buffer; number: string }> {
  const { db } = getDb();
  const q = await getQuoteRow(id);
  const company = await getCompanyRow(q.companyId);
  const workspace = await getWorkspace();
  const items = await db.select().from(schema.quoteItems).where(eq(schema.quoteItems.quoteId, id)).orderBy(schema.quoteItems.position);
  return { buffer: renderQuotePdf(q as any, items as any, company as any, workspace as any), number: q.number };
}

export async function softDeleteQuote(actor: Actor, id: string) {
  const { db } = getDb();
  await getQuoteRow(id);
  await db.update(schema.quotes).set({ deletedAt: new Date() }).where(eq(schema.quotes.id, id));
  await writeActivity(db, { entityType: 'quote', entityId: id, action: 'deleted', actorId: actor.userId, actorType: actor.actorType });
}

// ─── Recurring invoices ───────────────────────────────────────────────────────
export async function listRecurring() {
  const { db } = getDb();
  return db.select().from(schema.recurringInvoices).orderBy(desc(schema.recurringInvoices.createdAt));
}

export async function createRecurring(actor: Actor, input: any) {
  const { db } = getDb();
  if (input.projectId) await assertClientProject(input.projectId);
  await getCompanyRow(input.companyId);
  const id = ulid();
  await db.insert(schema.recurringInvoices).values({
    id, companyId: input.companyId, projectId: input.projectId ?? null, frequency: input.frequency,
    nextIssueDate: input.nextIssueDate, itemsTemplate: input.itemsTemplate ?? [], autoSend: input.autoSend ?? false,
    currency: input.currency, endDate: input.endDate ?? null, status: 'active',
  });
  await writeActivity(db, { entityType: 'recurring_invoice', entityId: id, action: 'created', after: input, actorId: actor.userId, actorType: actor.actorType });
  return id;
}

export async function updateRecurring(actor: Actor, id: string, input: any) {
  const { db } = getDb();
  const [before] = await db.select().from(schema.recurringInvoices).where(eq(schema.recurringInvoices.id, id));
  if (!before) throw err.notFound('Recurring invoice not found');
  const patch: Record<string, unknown> = {};
  for (const k of ['frequency', 'nextIssueDate', 'autoSend', 'itemsTemplate', 'currency', 'endDate', 'status']) {
    if (input[k] !== undefined) patch[k] = input[k];
  }
  await db.update(schema.recurringInvoices).set(patch).where(eq(schema.recurringInvoices.id, id));
  await writeActivity(db, { entityType: 'recurring_invoice', entityId: id, action: 'updated', before, after: patch, actorId: actor.userId, actorType: actor.actorType });
  return { ...before, ...patch };
}

export async function deleteRecurring(actor: Actor, id: string) {
  const { db } = getDb();
  await db.delete(schema.recurringInvoices).where(eq(schema.recurringInvoices.id, id));
  await writeActivity(db, { entityType: 'recurring_invoice', entityId: id, action: 'deleted', actorId: actor.userId, actorType: actor.actorType });
}

// ─── Expenses ─────────────────────────────────────────────────────────────────
export async function listExpenses(params: { projectId?: string; companyId?: string }) {
  const { db } = getDb();
  return db.select().from(schema.expenses).where(and(
    isNull(schema.expenses.deletedAt),
    params.projectId ? eq(schema.expenses.projectId, params.projectId) : undefined,
    params.companyId ? eq(schema.expenses.companyId, params.companyId) : undefined,
  )).orderBy(desc(schema.expenses.date));
}

export async function createExpense(actor: Actor, input: any) {
  const { db } = getDb();
  const id = ulid();
  await db.insert(schema.expenses).values({
    id, companyId: input.companyId ?? null, projectId: input.projectId ?? null, categoryId: input.categoryId ?? null,
    amount: String(input.amount), currency: input.currency, date: input.date, description: input.description ?? '',
    attachmentId: input.attachmentId ?? null, billable: input.billable ?? false, markup: String(input.markup ?? 0), createdBy: actor.userId,
  });
  await writeActivity(db, { entityType: 'expense', entityId: id, action: 'created', after: input, actorId: actor.userId, actorType: actor.actorType });
  return id;
}

export async function updateExpense(actor: Actor, id: string, input: any) {
  const { db } = getDb();
  const [before] = await db.select().from(schema.expenses).where(and(eq(schema.expenses.id, id), isNull(schema.expenses.deletedAt)));
  if (!before) throw err.notFound('Expense not found');
  const patch: Record<string, unknown> = {};
  for (const k of ['companyId', 'projectId', 'categoryId', 'currency', 'date', 'description', 'attachmentId', 'billable']) {
    if (input[k] !== undefined) patch[k] = input[k];
  }
  if (input.amount !== undefined) patch.amount = String(input.amount);
  if (input.markup !== undefined) patch.markup = String(input.markup);
  await db.update(schema.expenses).set(patch).where(eq(schema.expenses.id, id));
  await writeActivity(db, { entityType: 'expense', entityId: id, action: 'updated', before, after: patch, actorId: actor.userId, actorType: actor.actorType });
  return { ...before, ...patch };
}

export async function deleteExpense(actor: Actor, id: string) {
  const { db } = getDb();
  await db.update(schema.expenses).set({ deletedAt: new Date() }).where(eq(schema.expenses.id, id));
  await writeActivity(db, { entityType: 'expense', entityId: id, action: 'deleted', actorId: actor.userId, actorType: actor.actorType });
}

export async function listExpenseCategories() {
  const { db } = getDb();
  return db.select().from(schema.expenseCategories).orderBy(schema.expenseCategories.name);
}
export async function createExpenseCategory(input: any) {
  const { db } = getDb();
  const id = ulid();
  await db.insert(schema.expenseCategories).values({ id, name: input.name });
  return id;
}
export async function deleteExpenseCategory(id: string) {
  const { db } = getDb();
  await db.delete(schema.expenseCategories).where(eq(schema.expenseCategories.id, id));
}

// ─── Settings: tax rates / reminders / email templates / number sequences ──────
export async function listTaxRates() {
  const { db } = getDb();
  return db.select().from(schema.taxRates).orderBy(schema.taxRates.name);
}
export async function createTaxRate(input: any) {
  const { db } = getDb();
  const id = ulid();
  await db.insert(schema.taxRates).values({ id, name: input.name, ratePercent: String(input.ratePercent) });
  return id;
}
export async function updateTaxRate(id: string, input: any) {
  const { db } = getDb();
  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.ratePercent !== undefined) patch.ratePercent = String(input.ratePercent);
  await db.update(schema.taxRates).set(patch).where(eq(schema.taxRates.id, id));
}
export async function deleteTaxRate(id: string) {
  const { db } = getDb();
  await db.delete(schema.taxRates).where(eq(schema.taxRates.id, id));
}

export async function listReminderRules() {
  const { db } = getDb();
  return db.select().from(schema.reminderRules).orderBy(schema.reminderRules.offsetDays);
}
export async function createReminderRule(input: any) {
  const { db } = getDb();
  const id = ulid();
  await db.insert(schema.reminderRules).values({ id, offsetDays: input.offsetDays, templateId: input.templateId ?? null, active: input.active ?? true });
  return id;
}
export async function updateReminderRule(id: string, input: any) {
  const { db } = getDb();
  const patch: Record<string, unknown> = {};
  for (const k of ['offsetDays', 'templateId', 'active']) if (input[k] !== undefined) patch[k] = input[k];
  await db.update(schema.reminderRules).set(patch).where(eq(schema.reminderRules.id, id));
}
export async function deleteReminderRule(id: string) {
  const { db } = getDb();
  await db.delete(schema.reminderRules).where(eq(schema.reminderRules.id, id));
}

export async function listEmailTemplates() {
  const { db } = getDb();
  return db.select().from(schema.emailTemplates).orderBy(schema.emailTemplates.type);
}
export async function createEmailTemplate(input: any) {
  const { db } = getDb();
  const id = ulid();
  await db.insert(schema.emailTemplates).values({ id, type: input.type, subject: input.subject, body: input.body });
  return id;
}
export async function updateEmailTemplate(id: string, input: any) {
  const { db } = getDb();
  const patch: Record<string, unknown> = {};
  for (const k of ['type', 'subject', 'body']) if (input[k] !== undefined) patch[k] = input[k];
  await db.update(schema.emailTemplates).set(patch).where(eq(schema.emailTemplates.id, id));
}
export async function deleteEmailTemplate(id: string) {
  const { db } = getDb();
  await db.delete(schema.emailTemplates).where(eq(schema.emailTemplates.id, id));
}

export async function listNumberSequences() {
  const { db } = getDb();
  return db.select().from(schema.numberSequences).orderBy(schema.numberSequences.docType);
}
export async function updateNumberSequence(input: any) {
  const { db } = getDb();
  // Update the pattern/reset for the current period's sequence (or all periods of a docType).
  await db.update(schema.numberSequences)
    .set({ pattern: input.pattern, resetPeriod: input.resetPeriod })
    .where(eq(schema.numberSequences.docType, input.docType));
  return listNumberSequences();
}

// ─── Finance dashboard (PRD §11.9) ─────────────────────────────────────────────
export async function financeDashboard(params: { from?: string; to?: string }) {
  const { db } = getDb();
  const asOf = today();
  const from = params.from ?? asOf.slice(0, 4) + '-01-01';
  const to = params.to ?? asOf;

  // Open invoices (unpaid, not draft/canceled) with outstanding net of credit notes.
  const openRows = await db.execute(sql`
    select i.id, i.number, i.company_id, c.name as company_name, i.currency, i.due_date,
      (i.total - i.amount_paid - coalesce((select sum(cn.amount) from credit_notes cn where cn.invoice_id = i.id),0)) as outstanding
    from invoices i join companies c on c.id = i.company_id
    where i.deleted_at is null and i.status in ('sent','viewed','partially_paid')
  `) as any[];
  const open = openRows
    .map((r) => ({ id: r.id, number: r.number, companyId: r.company_id, companyName: r.company_name, currency: r.currency, dueDate: r.due_date, outstanding: Number(r.outstanding) }))
    .filter((r) => r.outstanding > 0);

  const receivablesTotal: Record<string, number> = {};
  for (const r of open) receivablesTotal[r.currency] = round2((receivablesTotal[r.currency] ?? 0) + r.outstanding);

  const aging = computeAging(open.map((r) => ({ currency: r.currency, outstanding: r.outstanding, dueDate: r.dueDate })), asOf);

  // Invoiced / paid within the period (by issue date).
  const period = await db.execute(sql`
    select currency, coalesce(sum(total),0) as invoiced, coalesce(sum(amount_paid),0) as paid
    from invoices where deleted_at is null and status <> 'canceled' and issue_date >= ${from} and issue_date <= ${to}
    group by currency`) as any[];

  const overdue = open.filter((r) => r.dueDate < asOf).sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  // Expected payments grouped by due date.
  const expectedMap = new Map<string, Record<string, number>>();
  for (const r of open) {
    const bucket: Record<string, number> = expectedMap.get(r.dueDate) ?? {};
    bucket[r.currency] = round2((bucket[r.currency] ?? 0) + r.outstanding);
    expectedMap.set(r.dueDate, bucket);
  }
  const expectedPayments = [...expectedMap.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([dueDate, byCurrency]) => ({ dueDate, byCurrency }));

  // Top debtors.
  const debtorMap = new Map<string, { companyId: string; companyName: string; byCurrency: Record<string, number> }>();
  for (const r of open) {
    const d: { companyId: string; companyName: string; byCurrency: Record<string, number> } =
      debtorMap.get(r.companyId) ?? { companyId: r.companyId, companyName: r.companyName, byCurrency: {} };
    d.byCurrency[r.currency] = round2((d.byCurrency[r.currency] ?? 0) + r.outstanding);
    debtorMap.set(r.companyId, d);
  }
  const topDebtors = [...debtorMap.values()]
    .sort((a, b) => Object.values(b.byCurrency).reduce((s, v) => s + v, 0) - Object.values(a.byCurrency).reduce((s, v) => s + v, 0))
    .slice(0, 10);

  const [unbilled] = await db.execute(sql`
    select coalesce(sum(duration_seconds),0)/3600.0 as hours
    from time_entries where billable = true and invoice_item_id is null`) as any[];

  return {
    asOf,
    period: { from, to },
    receivables: { total: receivablesTotal, aging },
    invoicedPaid: period.map((r: any) => ({ currency: r.currency, invoiced: Number(r.invoiced), paid: Number(r.paid) })),
    overdue,
    expectedPayments,
    topDebtors,
    unbilledBillableHours: round2(Number(unbilled?.hours ?? 0)),
  };
}

// ─── Profitability (PRD §11.10) ────────────────────────────────────────────────
export async function profitability(params: { scope: 'project' | 'client' | 'labor'; from?: string; to?: string; projectId?: string; companyId?: string }) {
  const { db } = getDb();
  const from = params.from ?? '0001-01-01';
  const to = params.to ?? '9999-12-31';
  const toEnd = to + 'T23:59:59.999Z';

  if (params.scope === 'project') {
    const projects = await db.select().from(schema.projects).where(and(
      isNull(schema.projects.deletedAt),
      params.projectId ? eq(schema.projects.id, params.projectId) : undefined,
      params.companyId ? eq(schema.projects.companyId, params.companyId) : undefined,
    ));
    const out = [];
    for (const p of projects) {
      out.push(await projectProfit(p.id, p.name, p.kind, from, to, toEnd));
    }
    return { scope: 'project', from: params.from ?? null, to: params.to ?? null, rows: out };
  }

  if (params.scope === 'client') {
    const companies = await db.select().from(schema.companies).where(and(
      isNull(schema.companies.deletedAt),
      params.companyId ? eq(schema.companies.id, params.companyId) : undefined,
    ));
    const rows = [];
    for (const c of companies) {
      const projs = await db.select().from(schema.projects).where(and(eq(schema.projects.companyId, c.id), isNull(schema.projects.deletedAt)));
      if (!projs.length) continue;
      let revenue = 0, laborCost = 0, expenseCost = 0;
      for (const p of projs) {
        const pr = await projectProfit(p.id, p.name, p.kind, from, to, toEnd);
        revenue += pr.revenue; laborCost += pr.laborCost; expenseCost += pr.expenseCost;
      }
      rows.push({ companyId: c.id, companyName: c.name, ...computeProfitability({ revenue, laborCost, expenseCost }) });
    }
    rows.sort((a, b) => b.margin - a.margin);
    return { scope: 'client', from: params.from ?? null, to: params.to ?? null, rows };
  }

  // labor scope: cost by employee + billable/non-billable money + utilization.
  const [ohs] = await db.select().from(schema.overheadSettings).orderBy(desc(schema.overheadSettings.effectiveFrom)).limit(1);
  const hoursPerWeek = ohs ? Number(ohs.workingHoursPerWeek) : 40;
  const weeks = params.from && params.to ? Math.max(1, (Date.parse(toEnd) - Date.parse(from)) / (7 * 86400000)) : 0;
  const availableHours = round2(hoursPerWeek * weeks);

  const rows = await db.execute(sql`
    select te.user_id, u.name as user_name,
      coalesce(sum(te.duration_seconds),0)/3600.0 as total_hours,
      coalesce(sum(te.duration_seconds) filter (where te.billable),0)/3600.0 as billable_hours,
      coalesce(sum(te.duration_seconds) filter (where not te.billable),0)/3600.0 as nonbillable_hours,
      coalesce(sum(te.duration_seconds/3600.0 * te.cost_rate),0) as labor_cost,
      coalesce(sum((te.duration_seconds/3600.0 * te.cost_rate) filter (where te.billable)),0) as billable_cost,
      coalesce(sum((te.duration_seconds/3600.0 * te.cost_rate) filter (where not te.billable)),0) as nonbillable_cost
    from time_entries te join users u on u.id = te.user_id
    where te.started_at >= ${from} and te.started_at < ${toEnd}
    group by te.user_id, u.name
    order by labor_cost desc`) as any[];

  return {
    scope: 'labor',
    from: params.from ?? null,
    to: params.to ?? null,
    availableHoursPerPerson: availableHours,
    rows: rows.map((r: any) => ({
      userId: r.user_id,
      userName: r.user_name,
      totalHours: round2(Number(r.total_hours)),
      billableHours: round2(Number(r.billable_hours)),
      nonBillableHours: round2(Number(r.nonbillable_hours)),
      laborCost: round2(Number(r.labor_cost)),
      billableCost: round2(Number(r.billable_cost)),
      nonBillableCost: round2(Number(r.nonbillable_cost)),
      utilization: utilization(Number(r.billable_hours), availableHours),
    })),
  };
}

async function projectProfit(projectId: string, name: string, kind: string, from: string, to: string, toEnd: string) {
  const { db } = getDb();
  // Labor cost & billable value from time entries in the period.
  const [t] = await db.execute(sql`
    select coalesce(sum(duration_seconds/3600.0 * cost_rate),0) as labor_cost,
           coalesce(sum((duration_seconds/3600.0 * hourly_rate) filter (where billable)),0) as billable_value
    from time_entries where project_id = ${projectId} and started_at >= ${from} and started_at < ${toEnd}`) as any[];
  // Invoiced revenue (issued within period, not canceled).
  const [inv] = await db.execute(sql`
    select coalesce(sum(total),0) as invoiced
    from invoices where project_id = ${projectId} and deleted_at is null and status <> 'canceled' and issue_date >= ${from} and issue_date <= ${to}`) as any[];
  // Expense cost (base amount of all project expenses in period).
  const [ex] = await db.execute(sql`
    select coalesce(sum(amount),0) as expense_cost
    from expenses where project_id = ${projectId} and deleted_at is null and date >= ${from} and date <= ${to}`) as any[];

  const laborCost = Number(t?.labor_cost ?? 0);
  const expenseCost = Number(ex?.expense_cost ?? 0);
  const invoiced = Number(inv?.invoiced ?? 0);
  const billableValue = Number(t?.billable_value ?? 0);
  // internal projects are pure cost, zero revenue (PRD §5.4).
  const revenue = kind === 'internal' ? 0 : (invoiced > 0 ? invoiced : billableValue);
  const profit = computeProfitability({ revenue, laborCost, expenseCost });
  return { projectId, name, kind, ...profit, laborCost: round2(laborCost), expenseCost: round2(expenseCost) };
}

// ─── misc helpers ─────────────────────────────────────────────────────────────
function addDays(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
