/** Sales activities: the "what happens next" record on a lead or a deal. */
import { getDb, schema, eq, and, isNull, desc, asc, sql, inArray } from '@ordi/db';
import { ulid } from 'ulid';
import type {
  salesActivityInputSchema,
  salesActivityUpdateSchema,
  salesActivityCompleteSchema,
} from '@ordi/shared';
import type { z } from 'zod';
import type { Actor } from '../../context';
import { err } from '../../lib/errors';
import { writeActivity } from '../../core/activity';
import { assertUpdated, assertVersion } from '../../core/locking';
import {
  advanceSequenceActivity,
  resolveActivityTemplate,
  stopSequenceForActivity,
} from './playbooks';
import { assertSalesWrite } from './sales-access';
import {
  assertContactCompany,
  boundedLimit,
  CANCELS_PLANNED_LEAD_STATUSES,
  pickDefined,
  type DbReader,
} from './common';

type SalesActivityInput = z.infer<typeof salesActivityInputSchema>;
type SalesActivityUpdate = z.infer<typeof salesActivityUpdateSchema>;
type SalesActivityComplete = z.infer<typeof salesActivityCompleteSchema>;

const ACTIVITY_UPDATE_FIELDS = [
  'type',
  'channel',
  'subject',
  'context',
  'ownerId',
] as const satisfies readonly (keyof SalesActivityUpdate)[];

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
  return salesActivityRecord(db, id);
}

async function salesActivityRecord(dbOrTx: DbReader, id: string, lock = false) {
  const query = dbOrTx.select().from(schema.salesActivities).where(and(
    eq(schema.salesActivities.id, id),
    isNull(schema.salesActivities.deletedAt),
  ));
  const [activity] = lock ? await query.for('update') : await query;
  if (!activity) throw err.notFound('Sales activity not found');
  return activity;
}

async function activityParent(dbOrTx: DbReader, input: SalesActivityInput) {
  if (input.leadId) {
    const [lead] = await dbOrTx.select().from(schema.leads).where(and(
      eq(schema.leads.id, input.leadId),
      isNull(schema.leads.deletedAt),
    )).for('update');
    if (!lead) throw err.notFound('Lead not found');
    const contactId = input.contactId === undefined ? lead.contactId : input.contactId;
    await assertContactCompany(lead.companyId, contactId, dbOrTx);
    return {
      parent: {
        leadId: lead.id,
        dealId: null,
        companyId: lead.companyId,
        contactId,
        ownerId: input.ownerId ?? lead.ownerId,
      },
      title: lead.title,
      nurture: lead.status === 'nurture'
        ? { status: lead.status, nurtureUntil: lead.nurtureUntil }
        : null,
    };
  }
  // salesActivityInputSchema already enforces exactly one parent; restate it here
  // so the narrowing is real rather than a non-null assertion.
  if (!input.dealId) throw err.validation('Exactly one of leadId or dealId is required');
  const [deal] = await dbOrTx.select().from(schema.deals).where(and(
    eq(schema.deals.id, input.dealId),
    isNull(schema.deals.deletedAt),
  )).for('update');
  if (!deal) throw err.notFound('Deal not found');
  const [stage] = await dbOrTx.select({
    isWon: schema.dealStages.isWon,
    isLost: schema.dealStages.isLost,
  }).from(schema.dealStages).where(eq(schema.dealStages.id, deal.stageId));
  if (stage?.isWon || stage?.isLost) {
    throw err.domain('Closed deals cannot schedule sales activities');
  }
  await assertContactCompany(deal.companyId, input.contactId, dbOrTx);
  return {
    parent: {
      leadId: null,
      dealId: deal.id,
      companyId: deal.companyId,
      contactId: input.contactId ?? null,
      ownerId: input.ownerId ?? deal.ownerId,
    },
    title: deal.title,
    nurture: null,
  };
}

export async function createSalesActivity(actor: Actor, input: SalesActivityInput) {
  const { db } = getDb();
  return db.transaction(async (tx) => {
    const { parent, nurture, title } = await activityParent(tx, input);
    assertSalesWrite(actor, parent.dealId);
    const id = ulid();
    if (nurture && parent.leadId) {
      await tx.update(schema.leads).set({
        status: 'ready',
        nurtureUntil: null,
      }).where(eq(schema.leads.id, parent.leadId));
      await writeActivity(tx, {
        entityType: 'lead',
        entityId: parent.leadId,
        action: 'updated',
        before: nurture,
        after: { status: 'ready', nurtureUntil: null },
        actorId: actor.userId,
        actorType: actor.actorType,
      });
    }
    const copy = await resolveActivityTemplate(tx, { ...parent, title }, input);
    await tx.insert(schema.salesActivities).values({
      id,
      ...parent,
      type: input.type,
      status: 'planned',
      ...copy,
      dueAt: new Date(input.dueAt),
      createdBy: actor.userId,
    });
    await writeActivity(tx, {
      entityType: parent.leadId ? 'lead' : 'deal',
      entityId: parent.leadId ?? parent.dealId!,
      action: 'sales_activity_created',
      after: { activityId: id, type: input.type, dueAt: input.dueAt },
      actorId: actor.userId,
      actorType: actor.actorType,
    });
    return id;
  });
}

export async function updateSalesActivity(actor: Actor, id: string, input: SalesActivityUpdate) {
  const { db } = getDb();
  return db.transaction(async (tx) => {
    const before = await salesActivityRecord(tx, id, true);
    assertSalesWrite(actor, before.dealId);
    assertVersion(before, input.version, before);
    if (before.status !== 'planned') throw err.domain('Only planned activities can be edited');
    const patch = pickDefined(input, ACTIVITY_UPDATE_FIELDS);
    if (input.dueAt !== undefined) patch.dueAt = new Date(input.dueAt);
    if (!Object.keys(patch).length) return before;

    const [after] = await tx.update(schema.salesActivities).set(patch)
      .where(and(eq(schema.salesActivities.id, id), eq(schema.salesActivities.version, before.version)))
      .returning();
    assertUpdated(after, before);
    const auditBefore = Object.fromEntries(
      Object.keys(patch).map((key) => [key, before[key as keyof typeof before]]),
    );
    await writeActivity(tx, {
      entityType: before.leadId ? 'lead' : 'deal',
      entityId: before.leadId ?? before.dealId!,
      action: 'sales_activity_updated',
      before: { activityId: id, ...auditBefore },
      after: { activityId: id, ...patch },
      actorId: actor.userId,
      actorType: actor.actorType,
    });
    return after;
  });
}

export async function completeSalesActivity(actor: Actor, id: string, input: SalesActivityComplete) {
  const { db } = getDb();
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(schema.salesActivities).where(and(
      eq(schema.salesActivities.id, id),
      isNull(schema.salesActivities.deletedAt),
    )).for('update');
    if (!before) throw err.notFound('Sales activity not found');
    assertSalesWrite(actor, before.dealId);
    if (before.status === 'completed') {
      const [next] = before.sequenceEnrollmentId
        ? await tx.select({ id: schema.salesActivities.id }).from(schema.salesActivities).where(and(
          eq(schema.salesActivities.sequenceEnrollmentId, before.sequenceEnrollmentId),
          eq(schema.salesActivities.status, 'planned'),
          isNull(schema.salesActivities.deletedAt),
        )).orderBy(asc(schema.salesActivities.dueAt)).limit(1)
        : [];
      return { activityId: id, nextActivityId: next?.id ?? null };
    }
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
      if (CANCELS_PLANNED_LEAD_STATUSES.has(input.leadStatus)) {
        await tx.update(schema.salesActivities).set({ status: 'cancelled' }).where(and(
          eq(schema.salesActivities.leadId, before.leadId),
          eq(schema.salesActivities.status, 'planned'),
          isNull(schema.salesActivities.deletedAt),
        ));
      }
    }
    let nextActivityId: string | null = null;
    const sequenceNextActivityId = await advanceSequenceActivity(tx, actor, before, input);
    if (sequenceNextActivityId !== undefined) {
      nextActivityId = sequenceNextActivityId;
    } else if (input.nextActivity) {
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
  return db.transaction(async (tx) => {
    const before = await salesActivityRecord(tx, id, true);
    assertSalesWrite(actor, before.dealId);
    if (before.status === 'cancelled') return;
    if (before.status !== 'planned') throw err.domain('Only planned activities can be cancelled');
    assertVersion(before, version, before);
    const [cancelled] = await tx.update(schema.salesActivities).set({ status: 'cancelled' })
      .where(and(eq(schema.salesActivities.id, id), eq(schema.salesActivities.version, before.version)))
      .returning({ id: schema.salesActivities.id });
    assertUpdated(cancelled, before);
    await stopSequenceForActivity(tx, before);
    await writeActivity(tx, {
      entityType: before.leadId ? 'lead' : 'deal',
      entityId: before.leadId ?? before.dealId!,
      action: 'sales_activity_cancelled',
      before: { activityId: id, status: before.status },
      after: { activityId: id, status: 'cancelled' },
      actorId: actor.userId,
      actorType: actor.actorType,
    });
  });
}
