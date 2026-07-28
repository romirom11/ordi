import { getDb, schema, eq, and, isNull, desc, asc, sql, inArray, type SQL } from '@ordi/db';
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
      (select count(*)::int from deals where company_id = ${id}) as deals,
      (select count(*)::int from leads where company_id = ${id} and deleted_at is null) as leads
  `) as unknown as { invoices: number; projects: number; deals: number; leads: number }[];
  const invoices = Number(rows[0]?.invoices ?? 0);
  const projects = Number(rows[0]?.projects ?? 0);
  const deals = Number(rows[0]?.deals ?? 0);
  const leads = Number(rows[0]?.leads ?? 0);

  if (invoices > 0 || projects > 0 || deals > 0 || leads > 0) {
    throw err.domain('Cannot delete a company that still has leads, deals, projects or invoices. Archive it instead.', {
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

// ── Leads, research and sales work ──

const STOPPED_LEAD_STATUSES = new Set(['disqualified', 'no_response']);

function normalized(value: string | null | undefined): string {
  return (value ?? '').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}

function boundedLimit(value: number | undefined, fallback: number, maximum: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(Math.trunc(value!), maximum)) : fallback;
}

const NON_COMPANY_HOSTS = [
  'indeed.com',
  'linkedin.com',
  'companieshouse.gov.uk',
  'find-and-update.company-information.service.gov.uk',
  'heyjobs.co',
];

function normalizedDomain(value: string | null | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    return url.hostname.toLocaleLowerCase().replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

function isCompanyHost(host: string): boolean {
  return !NON_COMPANY_HOSTS.some((blocked) => host === blocked || host.endsWith(`.${blocked}`));
}

function prospectDomain(prospect: any): string | null {
  const explicit = normalizedDomain(prospect.domain ?? prospect.company_url);
  if (explicit) return explicit;
  const urls = [
    ...(prospect.secondary_sources ?? []).map((source: any) => source?.url),
    prospect.source_url,
  ];
  for (const value of urls) {
    const host = normalizedDomain(value);
    if (host && isCompanyHost(host)) return host;
  }
  return null;
}

function researchCheckedAt(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

async function enrichLeads<T extends { companyId: string; contactId: string | null }>(rows: T[]) {
  const { db } = getDb();
  const companyIds = [...new Set(rows.map((row) => row.companyId))];
  const contactIds = [...new Set(rows.map((row) => row.contactId).filter(Boolean) as string[])];
  const [companyRows, contactRows] = await Promise.all([
    companyIds.length
      ? db.select({ id: schema.companies.id, name: schema.companies.name }).from(schema.companies).where(inArray(schema.companies.id, companyIds))
      : [],
    contactIds.length
      ? db.select({
        id: schema.contacts.id,
        firstName: schema.contacts.firstName,
        lastName: schema.contacts.lastName,
        position: schema.contacts.position,
      }).from(schema.contacts).where(and(
        inArray(schema.contacts.id, contactIds),
        isNull(schema.contacts.deletedAt),
      ))
      : [],
  ]);
  const companiesById = new Map(companyRows.map((row) => [row.id, row.name]));
  const contactsById = new Map(contactRows.map((row) => [row.id, row]));
  return rows.map((row) => ({
    ...row,
    companyName: companiesById.get(row.companyId) ?? '',
    contact: row.contactId ? contactsById.get(row.contactId) ?? null : null,
  }));
}

export async function listLeads(params: {
  q?: string;
  status?: string;
  companyId?: string;
  ownerId?: string;
  limit?: number;
}) {
  const { db } = getDb();
  const rows = await db.select().from(schema.leads).where(and(
    isNull(schema.leads.deletedAt),
    params.status ? eq(schema.leads.status, params.status) : undefined,
    params.companyId ? eq(schema.leads.companyId, params.companyId) : undefined,
    params.ownerId ? eq(schema.leads.ownerId, params.ownerId) : undefined,
    params.q
      ? sql`(${schema.leads.title} ilike ${'%' + params.q + '%'} or ${schema.leads.painSignal} ilike ${'%' + params.q + '%'} or ${schema.leads.evidence} ilike ${'%' + params.q + '%'})`
      : undefined,
  )).orderBy(desc(schema.leads.createdAt)).limit(params.limit ?? 100);
  const [enriched, activities] = await Promise.all([
    enrichLeads(rows),
    nextSalesActivities({ leadIds: rows.map((row) => row.id) }),
  ]);
  const nextByLead = new Map(activities.map((activity) => [activity.leadId, activity]));
  return enriched.map((lead) => ({ ...lead, nextActivity: nextByLead.get(lead.id) ?? null }));
}

async function getLeadRecord(id: string) {
  const { db } = getDb();
  const [lead] = await db.select().from(schema.leads)
    .where(and(eq(schema.leads.id, id), isNull(schema.leads.deletedAt)));
  if (!lead) throw err.notFound('Lead not found');
  return lead;
}

export async function getLead(id: string) {
  const { db } = getDb();
  const lead = await getLeadRecord(id);
  const [enriched] = await enrichLeads([lead]);
  const [convertedDeal] = await db.select({ id: schema.deals.id }).from(schema.deals)
    .where(and(eq(schema.deals.sourceLeadId, id), isNull(schema.deals.deletedAt)));
  return { ...enriched!, convertedDealId: convertedDeal?.id ?? null };
}

async function assertContactCompany(companyId: string, contactId: string | null | undefined): Promise<void> {
  if (!contactId) return;
  const { db } = getDb();
  const [contact] = await db.select({ id: schema.contacts.id }).from(schema.contacts).where(and(
    eq(schema.contacts.id, contactId),
    eq(schema.contacts.companyId, companyId),
    isNull(schema.contacts.deletedAt),
  ));
  if (!contact) throw err.validation('Contact does not belong to the company');
}

async function assertLeadContact(companyId: string, contactId: string | null | undefined): Promise<void> {
  await getCompany(companyId);
  await assertContactCompany(companyId, contactId);
}

export async function createLead(actor: Actor, input: any) {
  await assertLeadContact(input.companyId, input.contactId);
  if (input.status === 'nurture' && !input.nurtureUntil) {
    throw err.validation('A nurture return date is required');
  }
  const { db } = getDb();
  const id = ulid();
  await db.insert(schema.leads).values({
    id,
    companyId: input.companyId,
    contactId: input.contactId ?? null,
    researchBatchId: input.researchBatchId ?? null,
    title: input.title,
    product: input.product ?? null,
    status: input.status ?? 'new',
    score: input.score ?? null,
    signal: input.signal ?? null,
    painSignal: input.painSignal ?? null,
    evidence: input.evidence ?? null,
    whyFit: input.whyFit ?? null,
    whyNow: input.whyNow ?? null,
    sourceTitle: input.sourceTitle ?? null,
    sourceUrl: input.sourceUrl ?? null,
    sourceType: input.sourceType ?? null,
    signalDate: input.signalDate ?? null,
    sourceCheckedAt: input.sourceCheckedAt ? new Date(input.sourceCheckedAt) : null,
    suggestedChannel: input.suggestedChannel ?? null,
    opener: input.opener ?? null,
    caution: input.caution ?? null,
    dimensions: input.dimensions ?? {},
    secondarySources: input.secondarySources ?? [],
    rawResearch: input.rawResearch ?? {},
    nurtureUntil: input.nurtureUntil ?? null,
    disqualifiedReason: input.disqualifiedReason ?? null,
    ownerId: input.ownerId ?? actor.userId,
    customFields: input.customFields ?? {},
    createdBy: actor.userId,
  });
  await writeActivity(db, {
    entityType: 'lead',
    entityId: id,
    action: 'created',
    after: { title: input.title, companyId: input.companyId, status: input.status ?? 'new' },
    actorId: actor.userId,
    actorType: actor.actorType,
  });
  return id;
}

export async function updateLead(actor: Actor, id: string, input: any) {
  const { db } = getDb();
  const before = await getLeadRecord(id);
  assertVersion(before, input.version, before);
  const nextCompanyId = input.companyId ?? before.companyId;
  const nextContactId = input.contactId === undefined ? before.contactId : input.contactId;
  const nextStatus = input.status ?? before.status;
  const nextNurtureUntil = input.nurtureUntil === undefined ? before.nurtureUntil : input.nurtureUntil;
  if (nextStatus === 'nurture' && !nextNurtureUntil) {
    throw err.validation('A nurture return date is required');
  }
  if (input.companyId !== undefined || input.contactId !== undefined) await assertLeadContact(nextCompanyId, nextContactId);
  const patch: Record<string, unknown> = {};
  for (const key of [
    'companyId', 'contactId', 'researchBatchId', 'title', 'product', 'status', 'score', 'signal',
    'painSignal', 'evidence', 'whyFit', 'whyNow', 'sourceTitle', 'sourceUrl', 'sourceType',
    'signalDate', 'suggestedChannel', 'opener', 'caution', 'dimensions', 'secondarySources',
    'rawResearch', 'nurtureUntil', 'disqualifiedReason', 'ownerId',
  ]) {
    if (input[key] !== undefined) patch[key] = input[key];
  }
  if (input.status && input.status !== 'nurture' && input.nurtureUntil === undefined) {
    patch.nurtureUntil = null;
  }
  if (input.sourceCheckedAt !== undefined) patch.sourceCheckedAt = input.sourceCheckedAt ? new Date(input.sourceCheckedAt) : null;
  if (input.customFields !== undefined) patch.customFields = mergeCustomFields(before.customFields, input.customFields);
  await db.update(schema.leads).set(patch)
    .where(and(eq(schema.leads.id, id), eq(schema.leads.version, before.version)));
  if (input.status && STOPPED_LEAD_STATUSES.has(input.status)) {
    await db.update(schema.salesActivities).set({ status: 'cancelled' }).where(and(
      eq(schema.salesActivities.leadId, id),
      eq(schema.salesActivities.status, 'planned'),
      isNull(schema.salesActivities.deletedAt),
    ));
  }
  await writeActivity(db, {
    entityType: 'lead',
    entityId: id,
    action: 'updated',
    before,
    after: patch,
    actorId: actor.userId,
    actorType: actor.actorType,
  });
  return getLead(id);
}

export async function softDeleteLead(actor: Actor, id: string) {
  const { db } = getDb();
  await getLeadRecord(id);
  await db.update(schema.leads).set({ deletedAt: new Date() }).where(eq(schema.leads.id, id));
  await writeActivity(db, {
    entityType: 'lead',
    entityId: id,
    action: 'deleted',
    actorId: actor.userId,
    actorType: actor.actorType,
  });
}

export async function previewResearchImport(payload: any) {
  const { db } = getDb();
  const [companies, existingLeads] = await Promise.all([
    db.select({ id: schema.companies.id, name: schema.companies.name, domain: schema.companies.domain })
      .from(schema.companies).where(isNull(schema.companies.deletedAt)),
    db.select({ id: schema.leads.id, companyId: schema.leads.companyId, product: schema.leads.product, title: schema.leads.title })
      .from(schema.leads).where(isNull(schema.leads.deletedAt)),
  ]);
  const companyByName = new Map(companies.map((company) => [normalized(company.name), company]));
  const companyByDomain = new Map(companies.flatMap((company) => {
    const domain = normalizedDomain(company.domain);
    return domain ? [[domain, company] as const] : [];
  }));
  const leadIdByKey = new Map(existingLeads.map((lead) => [
    `${lead.companyId}:${normalized(lead.product || lead.title)}`,
    lead.id,
  ]));
  const newCompanyKeys = new Set<string>();
  const payloadLeadKeys = new Set<string>();
  let companiesToCreate = 0;
  let leadsToCreate = 0;
  const matches = payload.prospects.map((prospect: any) => {
    const domain = prospectDomain(prospect);
    const companyNameKey = normalized(prospect.name);
    const company = (domain ? companyByDomain.get(domain) : undefined) ?? companyByName.get(companyNameKey);
    const newCompanyKey = domain ? `domain:${domain}` : `name:${companyNameKey}`;
    if (!company && !newCompanyKeys.has(newCompanyKey)) {
      newCompanyKeys.add(newCompanyKey);
      companiesToCreate += 1;
    }
    const companyKey = company?.id ?? `new:${newCompanyKey}`;
    const leadKey = `${companyKey}:${normalized(payload.product || prospect.name)}`;
    const duplicateLeadId = company ? leadIdByKey.get(leadKey) : undefined;
    const duplicateInPayload = payloadLeadKeys.has(leadKey);
    if (!duplicateLeadId && !duplicateInPayload) {
      payloadLeadKeys.add(leadKey);
      leadsToCreate += 1;
    }
    return {
      name: prospect.name,
      domain,
      companyId: company?.id ?? null,
      leadId: duplicateLeadId ?? null,
      action: duplicateLeadId || duplicateInPayload ? 'skip' : company ? 'create_lead' : 'create_company_and_lead',
    };
  });
  return {
    prospects: payload.prospects.length,
    companiesToCreate,
    leadsToCreate,
    exclusions: payload.excluded_candidates?.length ?? 0,
    matches,
  };
}

export async function importResearch(actor: Actor, payload: any) {
  const { db } = getDb();
  return db.transaction(async (tx) => {
    const existingBatches = await tx.select().from(schema.researchBatches).where(and(
      eq(schema.researchBatches.title, payload.title),
      payload.generated_at ? eq(schema.researchBatches.generatedAt, payload.generated_at) : undefined,
      isNull(schema.researchBatches.deletedAt),
    ));
    const researchBatchId = existingBatches[0]?.id ?? ulid();
    if (!existingBatches[0]) {
      await tx.insert(schema.researchBatches).values({
        id: researchBatchId,
        title: payload.title,
        product: payload.product ?? null,
        productUrl: payload.product_url ?? null,
        targetCustomer: payload.target_customer ?? null,
        searchScope: payload.search_scope ?? null,
        generatedAt: payload.generated_at ?? null,
        verdict: payload.verdict ?? null,
        patterns: payload.patterns ?? [],
        outreachPlan: payload.outreach_plan ?? {},
        limits: payload.limits ?? [],
        excludedCandidates: payload.excluded_candidates ?? [],
        rawPayload: payload,
        createdBy: actor.userId,
      });
    }

    const companyRows = await tx.select().from(schema.companies).where(isNull(schema.companies.deletedAt));
    const companyIdByName = new Map(companyRows.map((company) => [normalized(company.name), company.id]));
    const companyIdByDomain = new Map(companyRows.flatMap((company) => {
      const domain = normalizedDomain(company.domain);
      return domain ? [[domain, company.id] as const] : [];
    }));
    const companyById = new Map(companyRows.map((company) => [company.id, company]));
    const leadRows = await tx.select().from(schema.leads).where(isNull(schema.leads.deletedAt));
    const leadIdByKey = new Map(leadRows.map((lead) => [
      `${lead.companyId}:${normalized(lead.product || lead.title)}`,
      lead.id,
    ]));
    const leadIds: string[] = [];
    let createdCompanies = 0;
    let createdLeads = 0;

    for (const prospect of payload.prospects) {
      const domain = prospectDomain(prospect);
      let companyId = (domain ? companyIdByDomain.get(domain) : undefined)
        ?? companyIdByName.get(normalized(prospect.name));
      if (!companyId) {
        companyId = ulid();
        await tx.insert(schema.companies).values({
          id: companyId,
          name: prospect.name,
          domain,
          status: 'lead',
          ownerId: actor.userId,
          createdBy: actor.userId,
        });
        companyIdByName.set(normalized(prospect.name), companyId);
        if (domain) companyIdByDomain.set(domain, companyId);
        createdCompanies += 1;
      } else if (domain && !companyById.get(companyId)?.domain) {
        await tx.update(schema.companies).set({ domain }).where(eq(schema.companies.id, companyId));
        companyIdByDomain.set(domain, companyId);
      }

      const key = `${companyId}:${normalized(payload.product || prospect.name)}`;
      const duplicateLeadId = leadIdByKey.get(key);
      if (duplicateLeadId) {
        leadIds.push(duplicateLeadId);
        continue;
      }

      const leadId = ulid();
      await tx.insert(schema.leads).values({
        id: leadId,
        companyId,
        researchBatchId,
        title: prospect.name,
        product: payload.product ?? null,
        status: 'needs_review',
        score: prospect.score ?? null,
        signal: [prospect.stage, prospect.type].filter(Boolean).join(' · ') || null,
        painSignal: prospect.pain_signal ?? null,
        evidence: prospect.evidence ?? null,
        whyFit: prospect.why_fit ?? null,
        whyNow: prospect.why_now ?? null,
        sourceTitle: prospect.source_title ?? null,
        sourceUrl: prospect.source_url ?? null,
        sourceType: prospect.source_type ?? null,
        signalDate: prospect.signal_date ?? null,
        sourceCheckedAt: researchCheckedAt(payload.generated_at),
        suggestedChannel: prospect.suggested_channel ?? null,
        opener: prospect.opener ?? null,
        caution: prospect.caution ?? null,
        dimensions: prospect.dimensions ?? {},
        secondarySources: prospect.secondary_sources ?? [],
        rawResearch: prospect,
        ownerId: actor.userId,
        createdBy: actor.userId,
      });
      await tx.insert(schema.salesActivities).values({
        id: ulid(),
        leadId,
        companyId,
        type: 'review',
        status: 'planned',
        subject: 'Validate signal and choose outreach',
        dueAt: new Date(),
        ownerId: actor.userId,
        createdBy: actor.userId,
      });
      await writeActivity(tx, {
        entityType: 'lead',
        entityId: leadId,
        action: 'imported',
        after: { researchBatchId, sourceUrl: prospect.source_url ?? null },
        actorId: actor.userId,
        actorType: actor.actorType,
      });
      leadIdByKey.set(key, leadId);
      leadIds.push(leadId);
      createdLeads += 1;
    }

    return {
      researchBatchId,
      leadIds,
      createdCompanies,
      createdLeads,
      exclusions: payload.excluded_candidates?.length ?? 0,
    };
  });
}

export async function listSalesActivities(params: {
  leadId?: string;
  dealId?: string;
  companyId?: string;
  ownerId?: string;
  status?: string;
  includeLeads?: boolean;
  includeDeals?: boolean;
  limit?: number;
}) {
  const { db } = getDb();
  const limit = boundedLimit(params.limit, 100, 200);
  return db.select().from(schema.salesActivities).where(and(
    isNull(schema.salesActivities.deletedAt),
    params.leadId ? eq(schema.salesActivities.leadId, params.leadId) : undefined,
    params.dealId ? eq(schema.salesActivities.dealId, params.dealId) : undefined,
    params.companyId ? eq(schema.salesActivities.companyId, params.companyId) : undefined,
    params.ownerId ? eq(schema.salesActivities.ownerId, params.ownerId) : undefined,
    params.status ? eq(schema.salesActivities.status, params.status) : undefined,
    params.includeLeads === false ? isNull(schema.salesActivities.leadId) : undefined,
    params.includeDeals === false ? isNull(schema.salesActivities.dealId) : undefined,
  )).orderBy(
    sql`case when ${schema.salesActivities.status} = 'planned' then 0 else 1 end`,
    asc(schema.salesActivities.dueAt),
    desc(schema.salesActivities.createdAt),
  ).limit(limit);
}

export async function nextSalesActivities(params: { leadIds?: string[]; dealIds?: string[] }) {
  const { db } = getDb();
  const leadIds = [...new Set(params.leadIds ?? [])];
  const dealIds = [...new Set(params.dealIds ?? [])];
  const [leadActivities, dealActivities] = await Promise.all([
    leadIds.length
      ? db.selectDistinctOn([schema.salesActivities.leadId]).from(schema.salesActivities).where(and(
        inArray(schema.salesActivities.leadId, leadIds),
        eq(schema.salesActivities.status, 'planned'),
        isNull(schema.salesActivities.deletedAt),
      )).orderBy(schema.salesActivities.leadId, asc(schema.salesActivities.dueAt), asc(schema.salesActivities.createdAt))
      : [],
    dealIds.length
      ? db.selectDistinctOn([schema.salesActivities.dealId]).from(schema.salesActivities).where(and(
        inArray(schema.salesActivities.dealId, dealIds),
        eq(schema.salesActivities.status, 'planned'),
        isNull(schema.salesActivities.deletedAt),
      )).orderBy(schema.salesActivities.dealId, asc(schema.salesActivities.dueAt), asc(schema.salesActivities.createdAt))
      : [],
  ]);
  return [...leadActivities, ...dealActivities];
}

export async function getSalesActivity(id: string) {
  const { db } = getDb();
  const [activity] = await db.select().from(schema.salesActivities).where(and(
    eq(schema.salesActivities.id, id),
    isNull(schema.salesActivities.deletedAt),
  ));
  if (!activity) throw err.notFound('Sales activity not found');
  return activity;
}

async function activityParent(input: any) {
  if (input.leadId) {
    const lead = await getLeadRecord(input.leadId);
    const contactId = input.contactId === undefined ? lead.contactId : input.contactId;
    await assertContactCompany(lead.companyId, contactId);
    return { leadId: lead.id, dealId: null, companyId: lead.companyId, contactId, ownerId: input.ownerId ?? lead.ownerId };
  }
  const deal = await getDeal(input.dealId);
  await assertContactCompany(deal.companyId, input.contactId);
  return { leadId: null, dealId: deal.id, companyId: deal.companyId, contactId: input.contactId ?? null, ownerId: input.ownerId ?? deal.ownerId };
}

export async function createSalesActivity(actor: Actor, input: any) {
  const { db } = getDb();
  const parent = await activityParent(input);
  const id = ulid();
  await db.insert(schema.salesActivities).values({
    id,
    ...parent,
    type: input.type,
    status: 'planned',
    channel: input.channel ?? null,
    subject: input.subject ?? null,
    context: input.context ?? null,
    dueAt: new Date(input.dueAt),
    createdBy: actor.userId,
  });
  await writeActivity(db, {
    entityType: parent.leadId ? 'lead' : 'deal',
    entityId: parent.leadId ?? parent.dealId!,
    action: 'sales_activity_created',
    after: { activityId: id, type: input.type, dueAt: input.dueAt },
    actorId: actor.userId,
    actorType: actor.actorType,
  });
  return id;
}

export async function updateSalesActivity(actor: Actor, id: string, input: any) {
  const { db } = getDb();
  const [before] = await db.select().from(schema.salesActivities).where(and(
    eq(schema.salesActivities.id, id),
    isNull(schema.salesActivities.deletedAt),
  ));
  if (!before) throw err.notFound('Sales activity not found');
  assertVersion(before, input.version, before);
  if (before.status !== 'planned') throw err.domain('Only planned activities can be edited');
  const patch: Record<string, unknown> = {};
  for (const key of ['type', 'channel', 'subject', 'context', 'ownerId']) {
    if (input[key] !== undefined) patch[key] = input[key];
  }
  if (input.dueAt !== undefined) patch.dueAt = new Date(input.dueAt);
  await db.update(schema.salesActivities).set(patch)
    .where(and(eq(schema.salesActivities.id, id), eq(schema.salesActivities.version, before.version)));
  await writeActivity(db, {
    entityType: before.leadId ? 'lead' : 'deal',
    entityId: before.leadId ?? before.dealId!,
    action: 'sales_activity_updated',
    before: { activityId: id, ...before },
    after: { activityId: id, ...patch },
    actorId: actor.userId,
    actorType: actor.actorType,
  });
  return (await listSalesActivities({
    leadId: before.leadId ?? undefined,
    dealId: before.dealId ?? undefined,
  })).find((row) => row.id === id);
}

export async function completeSalesActivity(actor: Actor, id: string, input: any) {
  const { db } = getDb();
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(schema.salesActivities).where(and(
      eq(schema.salesActivities.id, id),
      isNull(schema.salesActivities.deletedAt),
    )).for('update');
    if (!before) throw err.notFound('Sales activity not found');
    if (before.status === 'completed') return { activityId: id, nextActivityId: null };
    if (before.status !== 'planned') throw err.domain('Only planned activities can be completed');
    if (!before.leadId && input.leadStatus) throw err.validation('A deal activity cannot change lead status');
    assertVersion(before, input.version, before);
    await tx.update(schema.salesActivities).set({
      status: 'completed',
      outcome: input.outcome ?? null,
      context: input.context ?? before.context,
      completedAt: new Date(),
    }).where(and(eq(schema.salesActivities.id, id), eq(schema.salesActivities.version, before.version)));
    if (before.leadId && input.leadStatus) {
      await tx.update(schema.leads).set({
        status: input.leadStatus,
        nurtureUntil: input.leadStatus === 'nurture' ? input.nurtureUntil : null,
      }).where(eq(schema.leads.id, before.leadId));
      if (STOPPED_LEAD_STATUSES.has(input.leadStatus)) {
        await tx.update(schema.salesActivities).set({ status: 'cancelled' }).where(and(
          eq(schema.salesActivities.leadId, before.leadId),
          eq(schema.salesActivities.status, 'planned'),
          isNull(schema.salesActivities.deletedAt),
        ));
      }
    }
    let nextActivityId: string | null = null;
    if (input.nextActivity) {
      nextActivityId = ulid();
      await tx.insert(schema.salesActivities).values({
        id: nextActivityId,
        leadId: before.leadId,
        dealId: before.dealId,
        companyId: before.companyId,
        contactId: before.contactId,
        type: input.nextActivity.type,
        status: 'planned',
        channel: input.nextActivity.channel ?? before.channel,
        subject: input.nextActivity.subject ?? null,
        context: input.nextActivity.context ?? null,
        dueAt: new Date(input.nextActivity.dueAt),
        ownerId: input.nextActivity.ownerId ?? before.ownerId,
        createdBy: actor.userId,
      });
    }
    await writeActivity(tx, {
      entityType: before.leadId ? 'lead' : 'deal',
      entityId: before.leadId ?? before.dealId!,
      action: 'sales_activity_completed',
      before: { activityId: id, status: before.status },
      after: { activityId: id, status: 'completed', outcome: input.outcome ?? null, nextActivityId },
      actorId: actor.userId,
      actorType: actor.actorType,
    });
    return { activityId: id, nextActivityId };
  });
}

export async function cancelSalesActivity(actor: Actor, id: string, version?: number) {
  const { db } = getDb();
  const [before] = await db.select().from(schema.salesActivities).where(and(
    eq(schema.salesActivities.id, id),
    isNull(schema.salesActivities.deletedAt),
  ));
  if (!before) throw err.notFound('Sales activity not found');
  if (before.status === 'cancelled') return;
  if (before.status !== 'planned') throw err.domain('Only planned activities can be cancelled');
  assertVersion(before, version, before);
  await db.update(schema.salesActivities).set({ status: 'cancelled' })
    .where(and(eq(schema.salesActivities.id, id), eq(schema.salesActivities.version, before.version)));
  await writeActivity(db, {
    entityType: before.leadId ? 'lead' : 'deal',
    entityId: before.leadId ?? before.dealId!,
    action: 'sales_activity_cancelled',
    after: { activityId: id },
    actorId: actor.userId,
    actorType: actor.actorType,
  });
}

export async function convertLead(actor: Actor, id: string, input: any) {
  const { db } = getDb();
  return db.transaction(async (tx) => {
    const [lead] = await tx.select().from(schema.leads).where(and(
      eq(schema.leads.id, id),
      isNull(schema.leads.deletedAt),
    )).for('update');
    if (!lead) throw err.notFound('Lead not found');
    const [existing] = await tx.select({ id: schema.deals.id }).from(schema.deals)
      .where(and(eq(schema.deals.sourceLeadId, id), isNull(schema.deals.deletedAt)));
    if (existing) return { dealId: existing.id, alreadyConverted: true };
    if (lead.status !== 'engaged') throw err.domain('Lead must be engaged before conversion');

    const stage = input.stageId
      ? (await tx.select().from(schema.dealStages).where(eq(schema.dealStages.id, input.stageId)))[0]
      : (await tx.select().from(schema.dealStages).where(and(
        eq(schema.dealStages.isWon, false),
        eq(schema.dealStages.isLost, false),
        sql`lower(${schema.dealStages.name}) <> 'lead'`,
      )).orderBy(asc(schema.dealStages.position)).limit(1))[0];
    if (!stage || stage.isWon || stage.isLost || normalized(stage.name) === 'lead') {
      throw err.validation('Choose a qualified opportunity stage');
    }
    const [company] = await tx.select().from(schema.companies).where(eq(schema.companies.id, lead.companyId));
    if (!company) throw err.notFound('Company not found');
    const contactId = input.contactId === undefined ? lead.contactId : input.contactId;
    if (contactId) {
      const [contact] = await tx.select({ id: schema.contacts.id }).from(schema.contacts).where(and(
        eq(schema.contacts.id, contactId),
        eq(schema.contacts.companyId, lead.companyId),
        isNull(schema.contacts.deletedAt),
      ));
      if (!contact) throw err.validation('Contact does not belong to the company');
    }
    const dealId = ulid();
    await tx.insert(schema.deals).values({
      id: dealId,
      companyId: lead.companyId,
      sourceLeadId: lead.id,
      title: input.title ?? lead.title,
      stageId: stage.id,
      amount: input.amount == null ? null : String(input.amount),
      currency: input.currency ?? company.defaultCurrency,
      expectedCloseDate: input.expectedCloseDate ?? null,
      ownerId: lead.ownerId,
      createdBy: actor.userId,
    });
    await tx.update(schema.leads).set({
      status: 'converted',
      contactId,
    }).where(eq(schema.leads.id, lead.id));
    await tx.update(schema.notes).set({ leadId: null, dealId }).where(eq(schema.notes.leadId, lead.id));
    await tx.update(schema.attachments).set({ entityType: 'deal', entityId: dealId }).where(and(
      eq(schema.attachments.entityType, 'lead'),
      eq(schema.attachments.entityId, lead.id),
    ));
    await tx.update(schema.salesActivities).set({ leadId: null, dealId }).where(eq(schema.salesActivities.leadId, lead.id));
    await writeActivity(tx, {
      entityType: 'lead',
      entityId: lead.id,
      action: 'converted',
      before: { status: lead.status },
      after: { status: 'converted', dealId },
      actorId: actor.userId,
      actorType: actor.actorType,
    });
    await writeActivity(tx, {
      entityType: 'deal',
      entityId: dealId,
      action: 'created_from_lead',
      after: { sourceLeadId: lead.id, stageId: stage.id },
      actorId: actor.userId,
      actorType: actor.actorType,
    });
    return { dealId, alreadyConverted: false };
  });
}

export { salesWork } from './work';

export async function demoteDealToLead(actor: Actor, id: string, input: any) {
  const { db } = getDb();
  return db.transaction(async (tx) => {
    const [deal] = await tx.select().from(schema.deals).where(and(
      eq(schema.deals.id, id),
      isNull(schema.deals.deletedAt),
    )).for('update');
    if (!deal) throw err.notFound('Deal not found');
    const [existing] = await tx.select({ id: schema.leads.id }).from(schema.leads)
      .where(and(eq(schema.leads.legacyDealId, id), isNull(schema.leads.deletedAt)));
    if (existing) return { leadId: existing.id, alreadyDemoted: true };
    const [stage] = await tx.select().from(schema.dealStages).where(eq(schema.dealStages.id, deal.stageId));
    if (!stage || normalized(stage.name) !== 'lead') throw err.domain('Only a legacy Lead-stage deal can be demoted');
    if (deal.sourceLeadId) throw err.domain('A converted lead deal cannot be demoted as a legacy deal');
    const leadId = ulid();
    await tx.insert(schema.leads).values({
      id: leadId,
      companyId: deal.companyId,
      legacyDealId: deal.id,
      title: input.title ?? deal.title,
      product: input.product ?? null,
      status: input.status ?? 'needs_review',
      ownerId: deal.ownerId,
      rawResearch: {
        legacyDeal: {
          amount: deal.amount,
          currency: deal.currency,
          expectedCloseDate: deal.expectedCloseDate,
          customFields: deal.customFields,
        },
      },
      createdBy: actor.userId,
    });
    await tx.update(schema.notes).set({ dealId: null, leadId }).where(eq(schema.notes.dealId, deal.id));
    await tx.update(schema.attachments).set({ entityType: 'lead', entityId: leadId }).where(and(
      eq(schema.attachments.entityType, 'deal'),
      eq(schema.attachments.entityId, deal.id),
    ));
    await tx.update(schema.salesActivities).set({ dealId: null, leadId }).where(eq(schema.salesActivities.dealId, deal.id));
    const [planned] = await tx.select({ id: schema.salesActivities.id }).from(schema.salesActivities).where(and(
      eq(schema.salesActivities.leadId, leadId),
      eq(schema.salesActivities.status, 'planned'),
      isNull(schema.salesActivities.deletedAt),
    )).limit(1);
    if (!planned) {
      await tx.insert(schema.salesActivities).values({
        id: ulid(),
        leadId,
        companyId: deal.companyId,
        type: 'review',
        status: 'planned',
        subject: 'Review legacy pipeline record',
        dueAt: new Date(),
        ownerId: deal.ownerId ?? actor.userId,
        createdBy: actor.userId,
      });
    }
    await tx.update(schema.deals).set({ deletedAt: new Date() }).where(eq(schema.deals.id, deal.id));
    await writeActivity(tx, {
      entityType: 'deal',
      entityId: deal.id,
      action: 'demoted_to_lead',
      after: { leadId },
      actorId: actor.userId,
      actorType: actor.actorType,
    });
    await writeActivity(tx, {
      entityType: 'lead',
      entityId: leadId,
      action: 'created_from_deal',
      after: { legacyDealId: deal.id },
      actorId: actor.userId,
      actorType: actor.actorType,
    });
    return { leadId, alreadyDemoted: false };
  });
}
