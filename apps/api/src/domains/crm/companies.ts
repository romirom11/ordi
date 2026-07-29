/** Companies and their contacts: the stable hub leads, deals and invoices hang off. */
import { getDb, schema, eq, and, isNull, lte, desc, sql, type SQL } from '@ordi/db';
import { ulid } from 'ulid';
import type {
  companyInputSchema,
  companyUpdateSchema,
  contactInputSchema,
  contactUpdateSchema,
  CustomFieldFilter,
} from '@ordi/shared';
import type { z } from 'zod';
import type { Actor } from '../../context';
import { err } from '../../lib/errors';
import { writeActivity } from '../../core/activity';
import { assertVersion } from '../../core/locking';
import { buildCustomFieldFilter, mergeCustomFields } from '../../core/customfields';

type CompanyInput = z.infer<typeof companyInputSchema>;
type CompanyUpdate = z.infer<typeof companyUpdateSchema>;
type ContactInput = z.infer<typeof contactInputSchema>;
type ContactUpdate = z.infer<typeof contactUpdateSchema>;

const COMPANY_UPDATE_FIELDS = [
  'name',
  'domain',
  'status',
  'ownerId',
  'billingEmail',
  'address',
  'defaultCurrency',
  'paymentTermsDays',
] as const satisfies readonly (keyof CompanyUpdate)[];

const CONTACT_UPDATE_FIELDS = [
  'firstName',
  'lastName',
  'email',
  'phone',
  'position',
  'isPrimary',
] as const satisfies readonly (keyof ContactUpdate)[];

/**
 * The route already returned a `nextCursor` here, but nothing ever consumed it:
 * passing it back replayed page one, so any caller that trusted it (the MCP
 * `list_companies` tool hands it straight to the model) looped on the same rows.
 * The cursor is honoured now, on the same key as /deals.
 *

 * Paged on the primary key. Ids are ULIDs (see pk() in the db schema), so they
 * sort lexicographically by creation time – newest-first is `id desc`, and the
 * cursor compares as exact text.
 *
 * Paging on createdAt does not work here: Postgres timestamptz keeps
 * microseconds, drizzle hands back a millisecond-precision JS Date, and the
 * truncated value round-tripped through the cursor matches no row at all.
 */
export async function listCompanies(params: {
  q?: string;
  status?: string;
  ownerId?: string;
  cfFilters?: CustomFieldFilter[];
  cursor?: { id?: string } | null;
  limit: number;
}) {
  const { db } = getDb();
  const cf: SQL[] = [];
  for (const f of params.cfFilters ?? []) cf.push(await buildCustomFieldFilter('companies', f));
  const rows = await db.select().from(schema.companies).where(and(
    isNull(schema.companies.deletedAt),
    params.status ? eq(schema.companies.status, params.status) : undefined,
    params.ownerId ? eq(schema.companies.ownerId, params.ownerId) : undefined,
    params.q ? sql`${schema.companies.name} ilike ${'%' + params.q + '%'}` : undefined,
    params.cursor?.id ? lte(schema.companies.id, params.cursor.id) : undefined,
    ...cf,
  )).orderBy(desc(schema.companies.id)).limit(params.limit + 1);
  return rows;
}

export async function createCompany(actor: Actor, input: CompanyInput) {
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

/**
 * Read under a row lock and confirm the write landed. The version filter alone
 * silently matched zero rows when someone else saved between the read and the
 * write: the caller got 200 plus the other writer's data and believed the edit
 * had been stored. A stale write is a 409 now, and the audit entry commits with
 * the update or not at all.
 */
export async function updateCompany(actor: Actor, id: string, input: CompanyUpdate) {
  const { db } = getDb();
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(schema.companies)
      .where(and(eq(schema.companies.id, id), isNull(schema.companies.deletedAt)))
      .for('update');
    if (!before) throw err.notFound('Company not found');
    assertVersion(before, input.version, before);
    const patch: Record<string, unknown> = {};
    for (const key of COMPANY_UPDATE_FIELDS) {
      if (input[key] !== undefined) patch[key] = input[key];
    }
    if (input.customFields !== undefined) patch.customFields = mergeCustomFields(before.customFields, input.customFields);
    if (!Object.keys(patch).length) return before;
    const [after] = await tx.update(schema.companies).set(patch)
      .where(and(eq(schema.companies.id, id), eq(schema.companies.version, before.version)))
      .returning();
    if (!after) throw err.conflict('The record was modified by someone else', before);
    await writeActivity(tx, { entityType: 'company', entityId: id, action: 'updated', before, after: patch, actorId: actor.userId, actorType: actor.actorType });
    return after;
  });
}

/**
 * Rotating the portal token revokes every link handed out so far, so it is a
 * real state change: check the company exists first (the route used to update
 * by id and report a token for anything, including a deleted or invented id)
 * and leave an audit trail. The token itself never enters the audit diff.
 */
export async function rotatePortalToken(
  actor: Actor,
  id: string,
  enabled?: boolean,
): Promise<{ portalToken: string }> {
  const { db } = getDb();
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(schema.companies)
      .where(and(eq(schema.companies.id, id), isNull(schema.companies.deletedAt)))
      .for('update');
    if (!before) throw err.notFound('Company not found');
    const portalToken = ulid();
    await tx.update(schema.companies).set({
      portalToken,
      ...(enabled !== undefined ? { portalEnabled: enabled } : {}),
    }).where(eq(schema.companies.id, id));
    await writeActivity(tx, {
      entityType: 'company',
      entityId: id,
      action: 'portal_token_rotated',
      before: { portalEnabled: before.portalEnabled },
      after: { portalEnabled: enabled ?? before.portalEnabled },
      actorId: actor.userId,
      actorType: actor.actorType,
    });
    return { portalToken };
  });
}

/**
 * Deleting a client that still has invoices or projects would leave those
 * records pointing at something the app no longer shows anywhere – an invoice
 * with no client is a bookkeeping problem, not a tidy-up. Refuse, and point at
 * archiving, which is what "we stopped working with them" actually means.
 *
 * Every count ignores soft-deleted rows: a record the user already deleted is
 * not a dependency, and counting it made the client undeletable forever with
 * nothing on screen to explain why (demoting a deal to a lead soft-deletes the
 * deal, so that dead end was easy to reach). The message names what actually
 * blocks, with counts – "leads, deals, projects or invoices" left the user
 * hunting through four lists that all looked empty.
 */
export async function softDeleteCompany(actor: Actor, id: string) {
  const { db } = getDb();
  await getCompany(id);

  const rows = await db.execute(sql`
    select
      (select count(*)::int from invoices where company_id = ${id} and deleted_at is null) as invoices,
      (select count(*)::int from projects where company_id = ${id} and deleted_at is null) as projects,
      (select count(*)::int from deals where company_id = ${id} and deleted_at is null) as deals,
      (select count(*)::int from leads where company_id = ${id} and deleted_at is null) as leads
  `) as unknown as { invoices: number; projects: number; deals: number; leads: number }[];
  const invoices = Number(rows[0]?.invoices ?? 0);
  const projects = Number(rows[0]?.projects ?? 0);
  const deals = Number(rows[0]?.deals ?? 0);
  const leads = Number(rows[0]?.leads ?? 0);

  const blockers: string[] = [];
  for (const [count, one, many] of [
    [leads, 'lead', 'leads'],
    [deals, 'deal', 'deals'],
    [projects, 'project', 'projects'],
    [invoices, 'invoice', 'invoices'],
  ] as const) {
    if (count > 0) blockers.push(`${count} ${count === 1 ? one : many}`);
  }
  if (blockers.length) {
    const what = blockers.length > 1
      ? `${blockers.slice(0, -1).join(', ')} and ${blockers[blockers.length - 1]}`
      : blockers[0];
    throw err.domain(`Cannot delete a company that still has ${what}. Delete those first, or archive the company instead.`, {
      invoices, projects, deals, leads,
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

export async function getContact(id: string) {
  const { db } = getDb();
  const [contact] = await db.select().from(schema.contacts)
    .where(and(eq(schema.contacts.id, id), isNull(schema.contacts.deletedAt)));
  if (!contact) throw err.notFound('Contact not found');
  return contact;
}

export async function createContact(actor: Actor, input: ContactInput) {
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

/**
 * Same lock-and-confirm shape as updateCompany. Demoting the previous primary
 * contact now shares the update's transaction – it used to be a separate write
 * that stuck even when the update itself matched nothing.
 */
export async function updateContact(actor: Actor, id: string, input: ContactUpdate) {
  const { db } = getDb();
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(schema.contacts)
      .where(and(eq(schema.contacts.id, id), isNull(schema.contacts.deletedAt)))
      .for('update');
    if (!before) throw err.notFound('Contact not found');
    assertVersion(before, input.version, before);
    const patch: Record<string, unknown> = {};
    for (const key of CONTACT_UPDATE_FIELDS) {
      if (input[key] !== undefined) patch[key] = input[key];
    }
    if (input.customFields !== undefined) {
      patch.customFields = mergeCustomFields(before.customFields, input.customFields);
    }
    if (!Object.keys(patch).length) return before;
    if (patch.isPrimary === true) {
      await tx.update(schema.contacts).set({ isPrimary: false })
        .where(eq(schema.contacts.companyId, before.companyId));
    }
    const [after] = await tx.update(schema.contacts).set(patch)
      .where(and(eq(schema.contacts.id, id), eq(schema.contacts.version, before.version)))
      .returning();
    if (!after) throw err.conflict('The record was modified by someone else', before);
    await writeActivity(tx, {
      entityType: 'contact',
      entityId: id,
      action: 'updated',
      before: { version: before.version },
      after: { fields: Object.keys(patch) },
      actorId: actor.userId,
      actorType: actor.actorType,
    });
    return after;
  });
}

export async function softDeleteContact(actor: Actor, id: string) {
  const { db } = getDb();
  await getContact(id);
  await db.update(schema.contacts).set({ deletedAt: new Date() }).where(eq(schema.contacts.id, id));
  await writeActivity(db, {
    entityType: 'contact',
    entityId: id,
    action: 'deleted',
    actorId: actor.userId,
    actorType: actor.actorType,
  });
}
