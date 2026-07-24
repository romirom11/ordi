/**
 * Scheduled jobs (PRD §8.4, §8.7, §11.5, §11.6). All idempotent: safe to run more
 * often than required (reminder_log dedup, next_run guards, per-day snapshot unique).
 */
import { getDb, schema, eq, and, lte, isNull, sql, inArray } from '@ordi/db';
import { ulid } from 'ulid';
import { computeDocumentTotals } from '@ordi/shared';
import { emit } from '../core/events';
import { queueEmail } from '../lib/email';
import { logger } from '../lib/logger';

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
function addFrequency(date: string, freq: string): string {
  const d = new Date(date + 'T00:00:00Z');
  if (freq === 'daily') d.setUTCDate(d.getUTCDate() + 1);
  else if (freq === 'weekly') d.setUTCDate(d.getUTCDate() + 7);
  else if (freq === 'monthly') d.setUTCMonth(d.getUTCMonth() + 1);
  else if (freq === 'quarterly') d.setUTCMonth(d.getUTCMonth() + 3);
  else if (freq === 'yearly') d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d.toISOString().slice(0, 10);
}

/** Create tasks from recurring rules whose next_run <= today. */
export async function runRecurringTasks(): Promise<void> {
  const { db } = getDb();
  const rules = await db.select().from(schema.recurringTasks)
    .where(and(eq(schema.recurringTasks.active, true), lte(schema.recurringTasks.nextRun, today())));
  for (const rule of rules) {
    const [tmpl] = await db.select().from(schema.taskTemplates).where(eq(schema.taskTemplates.id, rule.templateId));
    if (!tmpl) continue;
    const def = (tmpl.definition as any) ?? {};
    const [status] = await db.select().from(schema.taskStatuses)
      .where(eq(schema.taskStatuses.projectId, rule.projectId)).orderBy(schema.taskStatuses.position).limit(1);
    if (!status) continue;
    const taskId = ulid();
    await db.insert(schema.tasks).values({
      id: taskId, projectId: rule.projectId, number: 0, title: def.titlePattern || tmpl.name,
      description: def.description ?? {}, statusId: status.id, priority: def.priority ?? 'none',
    });
    await db.update(schema.recurringTasks)
      .set({ nextRun: addFrequency(rule.nextRun, rule.frequency === 'custom' ? 'weekly' : rule.frequency) })
      .where(eq(schema.recurringTasks.id, rule.id));
    await emit({ type: 'task.created', aggregateType: 'task', aggregateId: taskId, payload: { projectId: rule.projectId } });
  }
  if (rules.length) logger.info({ count: rules.length }, 'recurring tasks created');
}

/** Recurring invoices: create draft (or send), shift next_issue_date. */
export async function runRecurringInvoices(): Promise<void> {
  const { db } = getDb();
  const rules = await db.select().from(schema.recurringInvoices)
    .where(and(eq(schema.recurringInvoices.status, 'active'), lte(schema.recurringInvoices.nextIssueDate, today())));
  for (const rule of rules) {
    if (rule.endDate && rule.endDate < today()) {
      await db.update(schema.recurringInvoices).set({ status: 'ended' }).where(eq(schema.recurringInvoices.id, rule.id));
      continue;
    }
    const items = (rule.itemsTemplate as any[]) ?? [];
    const totals = computeDocumentTotals({ items: items.map((i) => ({ quantity: i.quantity, unitPrice: i.unitPrice, taxRatePercent: 0 })) });
    const invoiceId = ulid();
    const number = await nextNumber('invoice');
    const dueDate = addFrequency(today(), 'monthly');
    await db.insert(schema.invoices).values({
      id: invoiceId, companyId: rule.companyId, projectId: rule.projectId, number,
      status: rule.autoSend ? 'sent' : 'draft', currency: rule.currency, issueDate: today(), dueDate,
      subtotal: String(totals.subtotal), taxTotal: String(totals.taxTotal), total: String(totals.total),
      source: 'recurring', publicToken: ulid(), sentAt: rule.autoSend ? new Date() : null,
    });
    for (const [i, it] of items.entries()) {
      await db.insert(schema.invoiceItems).values({
        id: ulid(), invoiceId, description: it.description, quantity: String(it.quantity),
        unitPrice: String(it.unitPrice), amount: String(it.quantity * it.unitPrice), position: String((i + 1) * 1000), source: 'manual',
      });
    }
    await db.update(schema.recurringInvoices)
      .set({ nextIssueDate: addFrequency(rule.nextIssueDate, rule.frequency) })
      .where(eq(schema.recurringInvoices.id, rule.id));
    await emit({ type: 'invoice.created', aggregateType: 'invoice', aggregateId: invoiceId, payload: { source: 'recurring' } });
  }
}

/** Invoice reminders per reminder_rules, idempotent via reminder_log. */
export async function runReminders(): Promise<void> {
  const { db } = getDb();
  const rules = await db.select().from(schema.reminderRules).where(eq(schema.reminderRules.active, true));
  if (!rules.length) return;
  const openInvoices = await db.select().from(schema.invoices)
    .where(and(inArray(schema.invoices.status, ['sent', 'viewed', 'partially_paid']), eq(schema.invoices.remindersPaused, false)));
  for (const inv of openInvoices) {
    for (const rule of rules) {
      const triggerDate = addDays(inv.dueDate, rule.offsetDays);
      if (triggerDate > today()) continue;
      const [already] = await db.select().from(schema.reminderLog)
        .where(and(eq(schema.reminderLog.invoiceId, inv.id), eq(schema.reminderLog.ruleId, rule.id)));
      if (already) continue;
      const [company] = await db.select().from(schema.companies).where(eq(schema.companies.id, inv.companyId));
      await db.insert(schema.reminderLog).values({ id: ulid(), invoiceId: inv.id, ruleId: rule.id }).onConflictDoNothing();
      if (company?.billingEmail) {
        await queueEmail({
          to: company.billingEmail,
          subject: `Reminder: invoice ${inv.number}`,
          body: `Invoice ${inv.number} total ${inv.total} ${inv.currency} due ${inv.dueDate}.`,
        });
      }
    }
    if (inv.dueDate < today() && inv.status !== 'paid') {
      await emit({ type: 'invoice.overdue', aggregateType: 'invoice', aggregateId: inv.id, payload: { ref: inv.number } });
    }
  }
}

/** Daily burndown snapshot per active cycle. */
export async function runCycleSnapshots(): Promise<void> {
  const { db } = getDb();
  const cycles = await db.select().from(schema.cycles).where(eq(schema.cycles.status, 'active'));
  for (const cycle of cycles) {
    const [row] = await db.execute(sql`
      select count(*)::int as open_count, coalesce(sum(t.estimate),0) as open_estimate
      from tasks t join task_statuses ts on ts.id = t.status_id
      where t.cycle_id = ${cycle.id} and t.deleted_at is null and ts.category not in ('done','canceled')`) as any[];
    await db.insert(schema.cycleSnapshots).values({
      id: ulid(), cycleId: cycle.id, date: today(),
      openCount: Number(row?.open_count ?? 0), openEstimate: String(row?.open_estimate ?? 0),
    }).onConflictDoNothing();
  }
}

/** Auto-activate cycles whose start date has arrived; expire quotes. */
export async function runCycleActivation(): Promise<void> {
  const { db } = getDb();
  await db.update(schema.cycles).set({ status: 'active' })
    .where(and(eq(schema.cycles.status, 'upcoming'), lte(schema.cycles.startDate, today())));
}

export async function runQuoteExpiry(): Promise<void> {
  const { db } = getDb();
  const expired = await db.select().from(schema.quotes)
    .where(and(inArray(schema.quotes.status, ['sent', 'viewed']), lte(schema.quotes.validUntil, today())));
  for (const q of expired) {
    if (!q.validUntil) continue;
    await db.update(schema.quotes).set({ status: 'expired' }).where(eq(schema.quotes.id, q.id));
  }
}

export async function runAllDailyJobs(): Promise<void> {
  await runCycleActivation();
  await runRecurringTasks();
  await runRecurringInvoices();
  await runReminders();
  await runCycleSnapshots();
  await runQuoteExpiry();
}

// helpers
function addDays(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Atomic document numbering (PRD §11.3) — shared by services and recurring worker. */
export async function nextNumber(docType: 'invoice' | 'quote'): Promise<string> {
  const { db } = getDb();
  const year = new Date().getUTCFullYear();
  const periodKey = String(year);
  const prefix = docType === 'invoice' ? 'INV' : 'QUO';
  const [seq] = await db.execute(sql`
    insert into number_sequences (id, doc_type, period_key, last_value, pattern, reset_period)
    values (${ulid()}, ${docType}, ${periodKey}, 1, ${prefix + '-{YYYY}-{seq:4}'}, 'year')
    on conflict (doc_type, period_key) do update set last_value = number_sequences.last_value + 1
    returning last_value`) as any[];
  const n = Number(seq.last_value);
  return `${prefix}-${year}-${String(n).padStart(4, '0')}`;
}
