/** Leads: an unqualified pursuit, with its own lifecycle up to conversion. */
import { getDb, schema, eq, and, isNull, desc, asc, sql, inArray } from '@ordi/db';
import { ulid } from 'ulid';
import type { leadInputSchema, leadUpdateSchema, leadBulkUpdateSchema, leadConvertSchema } from '@ordi/shared';
import type { z } from 'zod';
import type { Actor } from '../../context';
import { err } from '../../lib/errors';
import { writeActivity } from '../../core/activity';
import { assertVersion } from '../../core/locking';
import { mergeCustomFields } from '../../core/customfields';
import { stopActiveLeadSequence } from './playbooks';
import { CANCELS_PLANNED_LEAD_STATUSES, assertCompanyExists, assertContactCompany, boundedLimit, pickDefined, type DbReader } from './common';
import { nextSalesActivities } from './activities';
import { requirePipelineStage } from './deals';

type LeadInput = z.infer<typeof leadInputSchema>;
type LeadUpdate = z.infer<typeof leadUpdateSchema>;
type LeadBulkUpdate = z.infer<typeof leadBulkUpdateSchema>;
type LeadConvert = z.infer<typeof leadConvertSchema>;

const LEAD_UPDATE_FIELDS = [
  'companyId', 'contactId', 'title', 'product', 'status', 'score', 'signal',
  'painSignal', 'evidence', 'whyFit', 'whyNow', 'sourceTitle', 'sourceUrl', 'sourceType',
  'signalDate', 'suggestedChannel', 'opener', 'caution',
  'nurtureUntil', 'disqualifiedReason', 'ownerId',
] as const satisfies readonly (keyof LeadUpdate)[];

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

/**
 * Returns `truncated` alongside the rows: the list is bounded, and a table that
 * silently stops at the cap looks complete when it is not – the same lie the
 * pipeline board already refuses to tell.
 */
export async function listLeads(params: {
  q?: string;
  status?: string;
  companyId?: string;
  ownerId?: string;
  limit?: number;
}) {
  const { db } = getDb();
  const limit = boundedLimit(params.limit, 100, 200);
  const rows = await db.select().from(schema.leads).where(and(
    isNull(schema.leads.deletedAt),
    params.status ? eq(schema.leads.status, params.status) : undefined,
    params.companyId ? eq(schema.leads.companyId, params.companyId) : undefined,
    params.ownerId ? eq(schema.leads.ownerId, params.ownerId) : undefined,
    params.q
      ? sql`(${schema.leads.title} ilike ${'%' + params.q + '%'} or ${schema.leads.painSignal} ilike ${'%' + params.q + '%'} or ${schema.leads.evidence} ilike ${'%' + params.q + '%'})`
      : undefined,
  )).orderBy(desc(schema.leads.createdAt)).limit(limit + 1);
  const truncated = rows.length > limit;
  if (truncated) rows.length = limit;
  const [enriched, activities] = await Promise.all([
    enrichLeads(rows),
    nextSalesActivities({ leadIds: rows.map((row) => row.id) }),
  ]);
  const nextByLead = new Map(activities.map((activity) => [activity.leadId, activity]));
  return {
    data: enriched.map((lead) => ({ ...lead, nextActivity: nextByLead.get(lead.id) ?? null })),
    truncated,
  };
}

async function getLeadRecord(
  id: string,
  dbOrTx: DbReader = getDb().db,
  lock = false,
) {
  const query = dbOrTx.select().from(schema.leads)
    .where(and(eq(schema.leads.id, id), isNull(schema.leads.deletedAt)));
  const [lead] = lock ? await query.for('update') : await query;
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

async function assertLeadContact(
  companyId: string,
  contactId: string | null | undefined,
  dbOrTx: DbReader = getDb().db,
): Promise<void> {
  await assertCompanyExists(companyId, dbOrTx);
  await assertContactCompany(companyId, contactId, dbOrTx);
}

export async function createLead(actor: Actor, input: LeadInput) {
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

export async function updateLead(actor: Actor, id: string, input: LeadUpdate) {
  const { db } = getDb();
  await db.transaction(async (tx) => {
    const before = await getLeadRecord(id, tx, true);
    assertVersion(before, input.version, before);
    const nextCompanyId = input.companyId ?? before.companyId;
    const nextContactId = input.contactId === undefined ? before.contactId : input.contactId;
    const nextStatus = input.status ?? before.status;
    const nextNurtureUntil = input.nurtureUntil === undefined ? before.nurtureUntil : input.nurtureUntil;
    if (nextStatus === 'nurture' && !nextNurtureUntil) {
      throw err.validation('A nurture return date is required');
    }
    if (input.companyId !== undefined || input.contactId !== undefined) {
      await assertLeadContact(nextCompanyId, nextContactId, tx);
    }
    const patch = pickDefined(input, LEAD_UPDATE_FIELDS);
    if (input.status && input.status !== 'nurture' && input.nurtureUntil === undefined) {
      patch.nurtureUntil = null;
    }
    if (input.sourceCheckedAt !== undefined) {
      patch.sourceCheckedAt = input.sourceCheckedAt ? new Date(input.sourceCheckedAt) : null;
    }
    if (input.customFields !== undefined) {
      patch.customFields = mergeCustomFields(before.customFields, input.customFields);
    }
    await tx.update(schema.leads).set(patch)
      .where(and(eq(schema.leads.id, id), eq(schema.leads.version, before.version)));
    if (
      CANCELS_PLANNED_LEAD_STATUSES.has(nextStatus)
      && (input.status !== undefined || input.nurtureUntil !== undefined)
    ) {
      await tx.update(schema.salesActivities).set({ status: 'cancelled' }).where(and(
        eq(schema.salesActivities.leadId, id),
        eq(schema.salesActivities.status, 'planned'),
        isNull(schema.salesActivities.deletedAt),
      ));
      await stopActiveLeadSequence(tx, id);
    }
    await writeActivity(tx, {
      entityType: 'lead',
      entityId: id,
      action: 'updated',
      before,
      after: patch,
      actorId: actor.userId,
      actorType: actor.actorType,
    });
  });
  return getLead(id);
}

/**
 * One decision applied across many leads: reassign the owner and/or move the
 * status. Each lead goes through updateLead, so the single-lead rules – nurture
 * needs a return date, terminal statuses cancel planned activities and stop
 * sequences – hold for fifty leads exactly as they do for one. Failures are
 * collected per lead instead of aborting the batch: reassigning 48 of 50 and
 * naming the 2 that failed beats an all-or-nothing error.
 */
export async function bulkUpdateLeads(actor: Actor, input: LeadBulkUpdate) {
  const patch: LeadUpdate = {};
  if (input.ownerId !== undefined) patch.ownerId = input.ownerId;
  if (input.status !== undefined) patch.status = input.status;
  if (input.nurtureUntil !== undefined) patch.nurtureUntil = input.nurtureUntil;
  let updated = 0;
  const errors: { id: string; message: string }[] = [];
  for (const id of [...new Set(input.ids)]) {
    try {
      const lead = await getLeadRecord(id);
      // The single-lead UI freezes a converted lead as a record of what
      // happened; a batch must not quietly rewrite that history.
      if (lead.status === 'converted') throw err.domain('A converted lead cannot be changed');
      await updateLead(actor, id, patch);
      updated += 1;
    } catch (cause) {
      errors.push({ id, message: cause instanceof Error ? cause.message : 'Update failed' });
    }
  }
  return { updated, errors };
}

/**
 * Every other way a lead stops being worked – a terminal status, a won or lost
 * deal – cancels its planned activities and stops its sequence. Deleting one did
 * not, so the enrollment stayed 'active' for a lead nothing could reach any more:
 * unstoppable through the UI, and still counted in a sequence's active total.
 */
export async function softDeleteLead(actor: Actor, id: string) {
  const { db } = getDb();
  await db.transaction(async (tx) => {
    await getLeadRecord(id, tx, true);
    await tx.update(schema.leads).set({ deletedAt: new Date() }).where(eq(schema.leads.id, id));
    await tx.update(schema.salesActivities).set({ status: 'cancelled' }).where(and(
      eq(schema.salesActivities.leadId, id),
      eq(schema.salesActivities.status, 'planned'),
      isNull(schema.salesActivities.deletedAt),
    ));
    await stopActiveLeadSequence(tx, id);
    await writeActivity(tx, {
      entityType: 'lead',
      entityId: id,
      action: 'deleted',
      actorId: actor.userId,
      actorType: actor.actorType,
    });
  });
}

export async function convertLead(actor: Actor, id: string, input: LeadConvert) {
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
      ? await requirePipelineStage(tx, input.stageId)
      : (await tx.select().from(schema.dealStages).where(and(
        eq(schema.dealStages.isWon, false),
        eq(schema.dealStages.isLost, false),
      )).orderBy(asc(schema.dealStages.position)).limit(1))[0];
    if (!stage || stage.isWon || stage.isLost) {
      throw err.validation('Choose a qualified opportunity stage');
    }
    const [company] = await tx.select().from(schema.companies).where(eq(schema.companies.id, lead.companyId));
    if (!company) throw err.notFound('Company not found');
    const contactId = input.contactId === undefined ? lead.contactId : input.contactId;
    await assertContactCompany(lead.companyId, contactId, tx);
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
    await tx.update(schema.salesSequenceEnrollments).set({ leadId: null, dealId })
      .where(eq(schema.salesSequenceEnrollments.leadId, lead.id));
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
