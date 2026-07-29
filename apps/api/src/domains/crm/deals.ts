/** Qualified opportunities: the pipeline half of CRM. */
import { getDb, schema, eq, and, isNull, lte, desc } from '@ordi/db';
import { ulid } from 'ulid';
import type { dealInputSchema, dealUpdateSchema } from '@ordi/shared';
import type { z } from 'zod';
import type { Actor } from '../../context';
import { err } from '../../lib/errors';
import { writeActivity } from '../../core/activity';
import { publishEvent } from '../../core/events';
import { assertVersion } from '../../core/locking';
import { mergeCustomFields } from '../../core/customfields';
import { stopActiveDealSequence } from './playbooks';
import { boundedLimit, type DbReader } from './common';
import { nextSalesActivities } from './activities';

type DealInput = z.infer<typeof dealInputSchema>;
type DealUpdate = z.infer<typeof dealUpdateSchema>;

const DEAL_UPDATE_FIELDS = [
  'title',
  'amount',
  'currency',
  'expectedCloseDate',
  'ownerId',
  'stageId',
  'projectId',
] as const satisfies readonly (keyof DealUpdate)[];

export async function requirePipelineStage(dbOrTx: DbReader, stageId: string) {
  const [stage] = await dbOrTx.select().from(schema.dealStages).where(eq(schema.dealStages.id, stageId));
  if (!stage) throw err.validation('Unknown stage');
  return stage;
}

/** A deal may only link to a live project – the FK allows any id, deleted ones included. */
export async function assertProjectExists(dbOrTx: DbReader, projectId: string): Promise<void> {
  const [project] = await dbOrTx.select({ id: schema.projects.id }).from(schema.projects)
    .where(and(eq(schema.projects.id, projectId), isNull(schema.projects.deletedAt)));
  if (!project) throw err.validation('Unknown project');
}

/**
 * Bounded and cursor-paged. This used to return every deal in the workspace on
 * every call: fine at demo size, a cliff at real size, and with no way to ask for
 * the next page even if a caller wanted one. Returns limit + 1 rows so the
 * route's `page()` can mint the cursor.
 *

 * Paged on the primary key. Ids are ULIDs (see pk() in the db schema), so they
 * sort lexicographically by creation time – newest-first is `id desc`, and the
 * cursor compares as exact text.
 *
 * Paging on createdAt does not work here: Postgres timestamptz keeps
 * microseconds, drizzle hands back a millisecond-precision JS Date, and the
 * truncated value round-tripped through the cursor matches no row at all.
 */
export async function listDeals(params: {
  companyId?: string;
  /** A ulid narrows to that project, the literal 'none' to unlinked deals. */
  projectId?: string;
  cursor?: { id?: string } | null;
  limit?: number;
}) {
  const { db } = getDb();
  const limit = boundedLimit(params.limit, 100, 200);
  // `page()` pops the (limit + 1)-th row and encodes *that* as nextCursor, so the
  // cursor names the first row of the next page: resume at it, not after it.
  const rows = await db.select().from(schema.deals).where(and(
    isNull(schema.deals.deletedAt),
    params.companyId ? eq(schema.deals.companyId, params.companyId) : undefined,
    params.projectId === 'none' ? isNull(schema.deals.projectId)
      : params.projectId ? eq(schema.deals.projectId, params.projectId) : undefined,
    params.cursor?.id ? lte(schema.deals.id, params.cursor.id) : undefined,
  )).orderBy(desc(schema.deals.id)).limit(limit + 1);

  const activities = await nextSalesActivities({ dealIds: rows.map((row) => row.id) });
  const nextByDeal = new Map(activities.map((activity) => [activity.dealId, activity]));
  return rows.map((row) => ({ ...row, nextActivity: nextByDeal.get(row.id) ?? null }));
}

export async function getDeal(id: string) {
  const { db } = getDb();
  const [deal] = await db.select().from(schema.deals).where(and(eq(schema.deals.id, id), isNull(schema.deals.deletedAt)));
  if (!deal) throw err.notFound('Deal not found');
  return deal;
}

export async function createDeal(actor: Actor, input: DealInput): Promise<string> {
  const { db } = getDb();
  if (input.projectId) await assertProjectExists(db, input.projectId);
  await requirePipelineStage(db, input.stageId);
  const id = ulid();
  await db.insert(schema.deals).values({
    id, companyId: input.companyId, projectId: input.projectId ?? null, title: input.title, stageId: input.stageId,
    amount: input.amount == null ? null : String(input.amount), currency: input.currency,
    expectedCloseDate: input.expectedCloseDate ?? null,
    ownerId: input.ownerId ?? null, customFields: input.customFields ?? {}, createdBy: actor.userId,
  });
  await writeActivity(db, { entityType: 'deal', entityId: id, action: 'created', after: input, actorId: actor.userId, actorType: actor.actorType });
  return id;
}

/** Lock-and-confirm, like updateCompany. moveDeal already worked this way. */
export async function updateDeal(actor: Actor, id: string, input: DealUpdate) {
  const { db } = getDb();
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(schema.deals)
      .where(and(eq(schema.deals.id, id), isNull(schema.deals.deletedAt)))
      .for('update');
    if (!before) throw err.notFound('Deal not found');
    assertVersion(before, input.version, before);
    if (input.projectId) await assertProjectExists(tx, input.projectId);
    if (input.stageId) await requirePipelineStage(tx, input.stageId);
    const patch: Record<string, unknown> = {};
    for (const key of DEAL_UPDATE_FIELDS) {
      const value = input[key];
      if (value === undefined) continue;
      patch[key] = key === 'amount' && value !== null ? String(value) : value;
    }
    if (input.customFields !== undefined) {
      patch.customFields = mergeCustomFields(before.customFields, input.customFields);
    }
    if (!Object.keys(patch).length) return before;
    const [after] = await tx.update(schema.deals).set(patch)
      .where(and(eq(schema.deals.id, id), eq(schema.deals.version, before.version)))
      .returning();
    if (!after) throw err.conflict('The record was modified by someone else', before);
    await writeActivity(tx, {
      entityType: 'deal',
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

export async function moveDeal(actor: Actor, id: string, stageId: string, lostReason: string | undefined, version?: number) {
  const { db } = getDb();
  await db.transaction(async (tx) => {
    const [deal] = await tx.select().from(schema.deals)
      .where(and(eq(schema.deals.id, id), isNull(schema.deals.deletedAt)))
      .for('update');
    if (!deal) throw err.notFound('Deal not found');
    assertVersion(deal, version, deal);
    const stage = await requirePipelineStage(tx, stageId);
    if (stage.isLost && !lostReason) throw err.domain('A lost reason is required');
    const [updated] = await tx.update(schema.deals)
      .set({ stageId, lostReason: stage.isLost ? lostReason ?? null : null })
      .where(and(eq(schema.deals.id, id), eq(schema.deals.version, deal.version)))
      .returning({ id: schema.deals.id });
    if (!updated) throw err.conflict('The record was modified by someone else', deal);
    if (stage.isWon || stage.isLost) {
      await tx.update(schema.salesActivities).set({ status: 'cancelled' }).where(and(
        eq(schema.salesActivities.dealId, id),
        eq(schema.salesActivities.status, 'planned'),
        isNull(schema.salesActivities.deletedAt),
      ));
      await stopActiveDealSequence(tx, id);
    }
    await writeActivity(tx, {
      entityType: 'deal', entityId: id, action: 'stage_changed',
      before: { stageId: deal.stageId }, after: { stageId }, actorId: actor.userId, actorType: actor.actorType,
    });
    await publishEvent(tx, {
      type: 'deal.stage_changed',
      aggregateType: 'deal',
      aggregateId: id,
      payload: { stageId, companyId: deal.companyId },
      actorId: actor.userId,
      actorType: actor.actorType,
    });
    if (stage.isWon) {
      await publishEvent(tx, {
        type: 'deal.won',
        aggregateType: 'deal',
        aggregateId: id,
        payload: {
          companyId: deal.companyId,
          title: deal.title,
          amount: deal.amount,
          currency: deal.currency,
          ownerId: deal.ownerId,
        },
        actorId: actor.userId,
        actorType: actor.actorType,
      });
    }
    if (stage.isLost) {
      await publishEvent(tx, {
        type: 'deal.lost',
        aggregateType: 'deal',
        aggregateId: id,
        payload: { companyId: deal.companyId, lostReason },
        actorId: actor.userId,
        actorType: actor.actorType,
      });
    }
  });
  return getDeal(id);
}

export async function softDeleteDeal(actor: Actor, id: string) {
  const { db } = getDb();
  await getDeal(id);
  await db.update(schema.deals).set({ deletedAt: new Date() }).where(eq(schema.deals.id, id));
  await writeActivity(db, {
    entityType: 'deal',
    entityId: id,
    action: 'deleted',
    actorId: actor.userId,
    actorType: actor.actorType,
  });
}
