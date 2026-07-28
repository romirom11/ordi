import { getDb, schema, eq, and, isNull, desc, sql, inArray, type SQL } from '@ordi/db';
import { ulid } from 'ulid';
import type { CustomFieldFilter } from '@ordi/shared';
import type { Actor } from '../../context';
import { err } from '../../lib/errors';
import { writeActivity } from '../../core/activity';
import { emit } from '../../core/events';
import { assertVersion } from '../../core/locking';
import { buildCustomFieldFilter, mergeCustomFields } from '../../core/customfields';

export async function listCompanies(params: {
  q?: string; status?: string; ownerId?: string; cfFilters?: CustomFieldFilter[]; limit: number;
}) {
  const { db } = getDb();
  const cf: SQL[] = [];
  for (const f of params.cfFilters ?? []) cf.push(await buildCustomFieldFilter('companies', f));
  const rows = await db.select().from(schema.companies).where(and(
    isNull(schema.companies.deletedAt),
    params.status ? eq(schema.companies.status, params.status) : undefined,
    params.ownerId ? eq(schema.companies.ownerId, params.ownerId) : undefined,
    params.q ? sql`${schema.companies.name} ilike ${'%' + params.q + '%'}` : undefined,
    ...cf,
  )).orderBy(desc(schema.companies.createdAt)).limit(params.limit + 1);
  return rows;
}

export async function createCompany(actor: Actor, input: any) {
  const { db } = getDb();
  const id = ulid();
  const portalToken = ulid();
  await db.insert(schema.companies).values({
    id, name: input.name, domain: input.domain ?? null, status: input.status ?? 'lead',
    ownerId: input.ownerId ?? null, billingEmail: input.billingEmail ?? null, address: input.address ?? null,
    defaultCurrency: input.defaultCurrency ?? 'USD', paymentTermsDays: input.paymentTermsDays ?? 14,
    portalToken, customFields: input.customFields ?? {}, createdBy: actor.userId,
  });
  await writeActivity(db, { entityType: 'company', entityId: id, action: 'created', after: input, actorId: actor.userId, actorType: actor.actorType });
  return id;
}

export async function getCompany(id: string) {
  const { db } = getDb();
  const [company] = await db.select().from(schema.companies)
    .where(and(eq(schema.companies.id, id), isNull(schema.companies.deletedAt)));
  if (!company) throw err.notFound('Company not found');
  return company;
}

export async function updateCompany(actor: Actor, id: string, input: any) {
  const { db } = getDb();
  const before = await getCompany(id);
  assertVersion(before, input.version, before);
  const patch: Record<string, unknown> = {};
  for (const k of ['name', 'domain', 'status', 'ownerId', 'billingEmail', 'address', 'defaultCurrency', 'paymentTermsDays']) {
    if (input[k] !== undefined) patch[k] = input[k];
  }
  if (input.customFields !== undefined) patch.customFields = mergeCustomFields(before.customFields, input.customFields);
  await db.update(schema.companies).set(patch).where(and(eq(schema.companies.id, id), eq(schema.companies.version, before.version)));
  await writeActivity(db, { entityType: 'company', entityId: id, action: 'updated', before, after: patch, actorId: actor.userId, actorType: actor.actorType });
  return getCompany(id);
}

/**
 * Deleting a client that still has invoices or projects would leave those
 * records pointing at something the app no longer shows anywhere – an invoice
 * with no client is a bookkeeping problem, not a tidy-up. Refuse, and point at
 * archiving, which is what "we stopped working with them" actually means.
 */
export async function softDeleteCompany(actor: Actor, id: string) {
  const { db } = getDb();
  await getCompany(id);

  const rows = await db.execute(sql`
    select
      (select count(*)::int from invoices where company_id = ${id} and deleted_at is null) as invoices,
      (select count(*)::int from projects where company_id = ${id} and deleted_at is null) as projects,
      (select count(*)::int from deals where company_id = ${id}) as deals
  `) as unknown as { invoices: number; projects: number; deals: number }[];
  const invoices = Number(rows[0]?.invoices ?? 0);
  const projects = Number(rows[0]?.projects ?? 0);
  const deals = Number(rows[0]?.deals ?? 0);

  if (invoices > 0 || projects > 0 || deals > 0) {
    throw err.domain('Cannot delete a client that still has invoices, projects or deals. Archive it instead.', {
      invoices, projects, deals,
    });
  }

  await db.update(schema.companies).set({ deletedAt: new Date() }).where(eq(schema.companies.id, id));
  await writeActivity(db, { entityType: 'company', entityId: id, action: 'deleted', actorId: actor.userId, actorType: actor.actorType });
}

/** Company overview (PRD §7.2). Finance tiles omitted (not just hidden) without finance.read. */
export async function companyOverview(actor: Actor, id: string) {
  const { db } = getDb();
  const company = await getCompany(id);
  const canFinance = actor.access.permissions.has('finance.read');
  const [projects] = await db.execute(sql`
    select count(*) filter (where status = 'active')::int as active_projects,
           count(*)::int as total_projects from projects where company_id = ${id} and deleted_at is null`) as any[];
  const [openTasks] = await db.execute(sql`
    select count(*)::int as open_tasks from tasks t
    join projects p on p.id = t.project_id
    join task_statuses ts on ts.id = t.status_id
    where p.company_id = ${id} and t.deleted_at is null and ts.category not in ('done','canceled')`) as any[];

  const out: Record<string, unknown> = {
    company,
    activeProjects: Number(projects?.active_projects ?? 0),
    totalProjects: Number(projects?.total_projects ?? 0),
    openTasks: Number(openTasks?.open_tasks ?? 0),
  };

  if (canFinance) {
    const billing = await db.execute(sql`
      select currency,
        coalesce(sum(total),0) as invoiced,
        coalesce(sum(amount_paid),0) as paid,
        coalesce(sum(total - amount_paid) filter (where status not in ('paid','canceled','draft')),0) as receivables
      from invoices where company_id = ${id} and deleted_at is null group by currency`);
    const [unbilled] = await db.execute(sql`
      select coalesce(sum(duration_seconds),0)/3600.0 as unbilled_hours from time_entries te
      join projects p on p.id = te.project_id
      where p.company_id = ${id} and te.billable = true and te.invoice_item_id is null`) as any[];
    out.billing = billing;
    out.unbilledHours = Number(unbilled?.unbilled_hours ?? 0);
  }
  return out;
}

// ── Contacts ──
export async function listContacts(companyId: string) {
  const { db } = getDb();
  return db.select().from(schema.contacts)
    .where(and(eq(schema.contacts.companyId, companyId), isNull(schema.contacts.deletedAt)))
    .orderBy(desc(schema.contacts.isPrimary));
}

export async function createContact(actor: Actor, input: any) {
  const { db } = getDb();
  const id = ulid();
  if (input.isPrimary) {
    await db.update(schema.contacts).set({ isPrimary: false }).where(eq(schema.contacts.companyId, input.companyId));
  }
  await db.insert(schema.contacts).values({
    id, companyId: input.companyId, firstName: input.firstName, lastName: input.lastName ?? '',
    email: input.email ?? null, phone: input.phone ?? null, position: input.position ?? null,
    isPrimary: input.isPrimary ?? false, customFields: input.customFields ?? {}, createdBy: actor.userId,
  });
  await writeActivity(db, { entityType: 'contact', entityId: id, action: 'created', after: input, actorId: actor.userId, actorType: actor.actorType });
  return id;
}

// ── Deals ──
export async function moveDeal(actor: Actor, id: string, stageId: string, lostReason: string | undefined, version?: number) {
  const { db } = getDb();
  const [deal] = await db.select().from(schema.deals).where(and(eq(schema.deals.id, id), isNull(schema.deals.deletedAt)));
  if (!deal) throw err.notFound('Deal not found');
  assertVersion(deal, version, deal);
  const [stage] = await db.select().from(schema.dealStages).where(eq(schema.dealStages.id, stageId));
  if (!stage) throw err.validation('Unknown stage');
  if (stage.isLost && !lostReason) throw err.domain('A lost reason is required');
  await db.update(schema.deals).set({ stageId, lostReason: stage.isLost ? lostReason ?? null : null })
    .where(and(eq(schema.deals.id, id), eq(schema.deals.version, deal.version)));
  await writeActivity(db, {
    entityType: 'deal', entityId: id, action: 'stage_changed',
    before: { stageId: deal.stageId }, after: { stageId }, actorId: actor.userId, actorType: actor.actorType,
  });
  await emit({ type: 'deal.stage_changed', aggregateType: 'deal', aggregateId: id, payload: { stageId, companyId: deal.companyId }, actorId: actor.userId, actorType: actor.actorType });
  if (stage.isWon) {
    await emit({ type: 'deal.won', aggregateType: 'deal', aggregateId: id, payload: { companyId: deal.companyId, title: deal.title, amount: deal.amount, currency: deal.currency, ownerId: deal.ownerId }, actorId: actor.userId, actorType: actor.actorType });
  }
  if (stage.isLost) {
    await emit({ type: 'deal.lost', aggregateType: 'deal', aggregateId: id, payload: { companyId: deal.companyId, lostReason }, actorId: actor.userId, actorType: actor.actorType });
  }
  return getDeal(id);
}

export async function getDeal(id: string) {
  const { db } = getDb();
  const [deal] = await db.select().from(schema.deals).where(and(eq(schema.deals.id, id), isNull(schema.deals.deletedAt)));
  if (!deal) throw err.notFound('Deal not found');
  return deal;
}
