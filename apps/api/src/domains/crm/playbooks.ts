import {
  and,
  asc,
  desc,
  eq,
  getDb,
  inArray,
  isNull,
  schema,
  sql,
  type Database,
} from '@ordi/db';
import {
  SALES_TEMPLATE_VARIABLES,
  salesActivityCompleteSchema,
  salesActivityInputSchema,
  salesMessageTemplateInputSchema,
  salesMessageTemplateUpdateSchema,
  salesSequenceEnrollSchema,
  salesSequenceInputSchema,
  salesSequenceUpdateSchema,
} from '@ordi/shared';
import { ulid } from 'ulid';
import type { z } from 'zod';
import type { Actor } from '../../context';
import { writeActivity } from '../../core/activity';
import { assertVersion } from '../../core/locking';
import { err } from '../../lib/errors';
import { assertSalesWrite } from './sales-access';

type SalesActivity = typeof schema.salesActivities.$inferSelect;
type SalesActivityInput = z.infer<typeof salesActivityInputSchema>;
type SalesActivityCompleteInput = z.infer<typeof salesActivityCompleteSchema>;
type SalesMessageTemplateInput = z.infer<typeof salesMessageTemplateInputSchema>;
type SalesMessageTemplateUpdate = z.infer<typeof salesMessageTemplateUpdateSchema>;
type SalesSequenceInput = z.infer<typeof salesSequenceInputSchema>;
type SalesSequenceUpdate = z.infer<typeof salesSequenceUpdateSchema>;
type SalesSequenceEnrollInput = z.infer<typeof salesSequenceEnrollSchema>;
type SalesSequenceStep = typeof schema.salesSequenceSteps.$inferSelect;
type SalesDb = Pick<Database, 'select' | 'insert' | 'update' | 'delete'>;

const SUPPORTED_VARIABLES = new Set<string>(SALES_TEMPLATE_VARIABLES);
const STOPS_LEAD_SEQUENCE = new Set(['nurture', 'disqualified', 'no_response']);
const TEMPLATE_UPDATE_FIELDS = [
  'name',
  'activityType',
  'channel',
  'subject',
  'body',
  'active',
] as const satisfies readonly (keyof SalesMessageTemplateUpdate)[];
const SEQUENCE_UPDATE_FIELDS = [
  'name',
  'description',
  'active',
] as const satisfies readonly (keyof SalesSequenceUpdate)[];

function validateVariables(value: string | null | undefined): void {
  if (!value) return;
  for (const match of value.matchAll(/\{\{\s*([a-zA-Z][a-zA-Z0-9]*)\s*\}\}/g)) {
    if (!SUPPORTED_VARIABLES.has(match[1]!)) {
      throw err.validation(`Unknown sales template variable: ${match[1]}`);
    }
  }
}

function render(value: string | null | undefined, variables: Record<string, string>): string | null {
  if (value == null) return null;
  return value.replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9]*)\s*\}\}/g, (source, name: string) =>
    Object.hasOwn(variables, name) ? variables[name]! : source);
}

function plusDays(value: Date, days: number): Date {
  return new Date(value.getTime() + days * 86_400_000);
}

export async function listSalesMessageTemplates(includeInactive = true) {
  const { db } = getDb();
  return db.select().from(schema.salesMessageTemplates).where(and(
    isNull(schema.salesMessageTemplates.deletedAt),
    includeInactive ? undefined : eq(schema.salesMessageTemplates.active, true),
  )).orderBy(desc(schema.salesMessageTemplates.active), asc(schema.salesMessageTemplates.name));
}

export async function createSalesMessageTemplate(
  actor: Actor,
  input: SalesMessageTemplateInput,
): Promise<string> {
  validateVariables(input.subject);
  validateVariables(input.body);
  const { db } = getDb();
  const id = ulid();
  await db.transaction(async (tx) => {
    await tx.insert(schema.salesMessageTemplates).values({
      id,
      name: input.name,
      activityType: input.activityType,
      channel: input.channel ?? null,
      subject: input.subject ?? null,
      body: input.body,
      active: input.active ?? true,
      createdBy: actor.userId,
    });
    await writeActivity(tx, {
      entityType: 'sales_message_template',
      entityId: id,
      action: 'created',
      after: { name: input.name, activityType: input.activityType, channel: input.channel ?? null },
      actorId: actor.userId,
      actorType: actor.actorType,
    });
  });
  return id;
}

export async function updateSalesMessageTemplate(
  actor: Actor,
  id: string,
  input: SalesMessageTemplateUpdate,
) {
  validateVariables(input.subject);
  validateVariables(input.body);
  const { db } = getDb();
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(schema.salesMessageTemplates).where(and(
      eq(schema.salesMessageTemplates.id, id),
      isNull(schema.salesMessageTemplates.deletedAt),
    )).for('update');
    if (!before) throw err.notFound('Sales message template not found');
    assertVersion(before, input.version, before);
    const patch: Record<string, unknown> = {};
    for (const key of TEMPLATE_UPDATE_FIELDS) {
      if (input[key] !== undefined) patch[key] = input[key];
    }
    if (!Object.keys(patch).length) return before;
    const [after] = await tx.update(schema.salesMessageTemplates).set(patch)
      .where(and(
        eq(schema.salesMessageTemplates.id, id),
        eq(schema.salesMessageTemplates.version, before.version),
      )).returning();
    if (!after) throw err.conflict('The record was modified by someone else', before);
    await writeActivity(tx, {
      entityType: 'sales_message_template',
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

async function hydrateSequenceSteps(dbOrTx: SalesDb, inputs: SalesSequenceInput['steps']) {
  const templateIds = [...new Set(inputs.map((step) => step.templateId).filter(Boolean) as string[])];
  const templates = templateIds.length
    ? await dbOrTx.select().from(schema.salesMessageTemplates).where(and(
      inArray(schema.salesMessageTemplates.id, templateIds),
      isNull(schema.salesMessageTemplates.deletedAt),
    ))
    : [];
  type MessageTemplate = typeof schema.salesMessageTemplates.$inferSelect;
  const byId = new Map<string, MessageTemplate>(
    templates.map((template: MessageTemplate) => [template.id, template]),
  );

  return inputs.map((input, index) => {
    const template = input.templateId ? byId.get(input.templateId) : null;
    if (input.templateId && (!template || !template.active)) {
      throw err.validation('Sequence steps can only use active message templates');
    }
    const activityType = input.activityType ?? template?.activityType;
    if (!activityType) throw err.validation('Every sequence step needs an activity type');
    const subject = input.subject !== undefined ? input.subject : template?.subject ?? null;
    const context = input.context !== undefined ? input.context : template?.body ?? null;
    validateVariables(subject);
    validateVariables(context);
    return {
      id: ulid(),
      position: index + 1,
      delayDays: input.delayDays ?? 0,
      templateId: template?.id ?? null,
      activityType,
      channel: input.channel !== undefined ? input.channel : template?.channel ?? null,
      subject,
      context,
    };
  });
}

async function querySalesSequences(includeInactive: boolean, id?: string) {
  const { db } = getDb();
  const sequences = await db.select().from(schema.salesSequences).where(and(
    id ? eq(schema.salesSequences.id, id) : undefined,
    isNull(schema.salesSequences.deletedAt),
    includeInactive ? undefined : eq(schema.salesSequences.active, true),
  )).orderBy(desc(schema.salesSequences.active), asc(schema.salesSequences.name));
  if (!sequences.length) return [];
  const ids = sequences.map((sequence) => sequence.id);
  const [steps, counts] = await Promise.all([
    db.select().from(schema.salesSequenceSteps)
      .where(inArray(schema.salesSequenceSteps.sequenceId, ids))
      .orderBy(asc(schema.salesSequenceSteps.position)),
    db.select({
      sequenceId: schema.salesSequenceEnrollments.sequenceId,
      enrollmentCount: sql<number>`count(*)::int`,
      activeEnrollments: sql<number>`
        count(*) filter (where ${schema.salesSequenceEnrollments.status} = 'active')::int
      `,
    }).from(schema.salesSequenceEnrollments).where(and(
      inArray(schema.salesSequenceEnrollments.sequenceId, ids),
    )).groupBy(schema.salesSequenceEnrollments.sequenceId),
  ]);
  const stepsBySequence = new Map<string, typeof steps>();
  for (const step of steps) {
    const list = stepsBySequence.get(step.sequenceId) ?? [];
    list.push(step);
    stepsBySequence.set(step.sequenceId, list);
  }
  const countsBySequence = new Map(counts.map((row) => [row.sequenceId, {
    enrollmentCount: Number(row.enrollmentCount),
    activeEnrollments: Number(row.activeEnrollments),
  }]));
  return sequences.map((sequence) => ({
    ...sequence,
    steps: stepsBySequence.get(sequence.id) ?? [],
    enrollmentCount: countsBySequence.get(sequence.id)?.enrollmentCount ?? 0,
    activeEnrollments: countsBySequence.get(sequence.id)?.activeEnrollments ?? 0,
  }));
}

export function listSalesSequences(includeInactive = true) {
  return querySalesSequences(includeInactive);
}

async function getSalesSequence(id: string) {
  const [sequence] = await querySalesSequences(true, id);
  if (!sequence) throw err.notFound('Sales sequence not found');
  return sequence;
}

export async function createSalesSequence(actor: Actor, input: SalesSequenceInput): Promise<string> {
  const { db } = getDb();
  const id = ulid();
  await db.transaction(async (tx) => {
    const steps = await hydrateSequenceSteps(tx, input.steps);
    await tx.insert(schema.salesSequences).values({
      id,
      name: input.name,
      description: input.description ?? '',
      active: input.active ?? true,
      createdBy: actor.userId,
    });
    await tx.insert(schema.salesSequenceSteps).values(
      steps.map((step) => ({ ...step, sequenceId: id })),
    );
    await writeActivity(tx, {
      entityType: 'sales_sequence',
      entityId: id,
      action: 'created',
      after: { name: input.name, stepCount: steps.length },
      actorId: actor.userId,
      actorType: actor.actorType,
    });
  });
  return id;
}

export async function updateSalesSequence(actor: Actor, id: string, input: SalesSequenceUpdate) {
  const { db } = getDb();
  await db.transaction(async (tx) => {
    const [before] = await tx.select().from(schema.salesSequences).where(and(
      eq(schema.salesSequences.id, id),
      isNull(schema.salesSequences.deletedAt),
    )).for('update');
    if (!before) throw err.notFound('Sales sequence not found');
    assertVersion(before, input.version, before);
    if (input.steps) {
      const [used] = await tx.select({ id: schema.salesSequenceEnrollments.id })
        .from(schema.salesSequenceEnrollments)
        .where(eq(schema.salesSequenceEnrollments.sequenceId, id))
        .limit(1);
      if (used) throw err.domain('A sequence cannot change steps after it has been used');
    }
    const patch: Record<string, unknown> = {};
    for (const key of SEQUENCE_UPDATE_FIELDS) {
      if (input[key] !== undefined) patch[key] = input[key];
    }
    const steps = input.steps ? await hydrateSequenceSteps(tx, input.steps) : null;
    const sequencePatch = {
      ...patch,
      ...(steps ? { updatedAt: new Date() } : {}),
    };
    if (!Object.keys(sequencePatch).length) return;
    const [updated] = await tx.update(schema.salesSequences).set(sequencePatch).where(and(
      eq(schema.salesSequences.id, id),
      eq(schema.salesSequences.version, before.version),
    )).returning({ id: schema.salesSequences.id });
    if (!updated) throw err.conflict('The record was modified by someone else', before);
    if (steps) {
      await tx.delete(schema.salesSequenceSteps).where(eq(schema.salesSequenceSteps.sequenceId, id));
      await tx.insert(schema.salesSequenceSteps).values(
        steps.map((step) => ({ ...step, sequenceId: id })),
      );
    }
    await writeActivity(tx, {
      entityType: 'sales_sequence',
      entityId: id,
      action: 'updated',
      before: { version: before.version },
      after: { fields: [...Object.keys(patch), ...(steps ? ['steps'] : [])] },
      actorId: actor.userId,
      actorType: actor.actorType,
    });
  });
  return getSalesSequence(id);
}

interface ActivityParent {
  leadId: string | null;
  dealId: string | null;
  companyId: string;
  contactId: string | null;
  ownerId: string | null;
  title: string;
}

async function variablesFor(
  dbOrTx: SalesDb,
  parent: ActivityParent,
): Promise<Record<string, string>> {
  const [[company], [contact], [owner]] = await Promise.all([
    dbOrTx.select({ name: schema.companies.name }).from(schema.companies)
      .where(eq(schema.companies.id, parent.companyId)),
    parent.contactId
      ? dbOrTx.select({
        firstName: schema.contacts.firstName,
        lastName: schema.contacts.lastName,
      }).from(schema.contacts).where(and(
        eq(schema.contacts.id, parent.contactId),
        eq(schema.contacts.companyId, parent.companyId),
        isNull(schema.contacts.deletedAt),
      ))
      : Promise.resolve([]),
    parent.ownerId
      ? dbOrTx.select({ name: schema.users.name }).from(schema.users)
        .where(eq(schema.users.id, parent.ownerId))
      : Promise.resolve([]),
  ]);
  if (!company) throw err.notFound('Company not found');
  if (parent.contactId && !contact) throw err.validation('Contact does not belong to the company');
  const contactName = contact ? `${contact.firstName} ${contact.lastName}`.trim() : '';
  return {
    companyName: company.name,
    contactFirstName: contact?.firstName ?? '',
    contactName,
    ownerName: owner?.name ?? '',
    leadTitle: parent.title,
  };
}

export async function resolveActivityTemplate(
  dbOrTx: SalesDb,
  parent: ActivityParent,
  input: SalesActivityInput,
) {
  if (!input.templateId) {
    return {
      messageTemplateId: null,
      channel: input.channel ?? null,
      subject: input.subject ?? null,
      context: input.context ?? null,
    };
  }
  const [template] = await dbOrTx.select().from(schema.salesMessageTemplates).where(and(
    eq(schema.salesMessageTemplates.id, input.templateId),
    eq(schema.salesMessageTemplates.active, true),
    isNull(schema.salesMessageTemplates.deletedAt),
  ));
  if (!template) throw err.validation('Choose an active sales message template');
  const variables = await variablesFor(dbOrTx, parent);
  return {
    messageTemplateId: template.id,
    channel: input.channel ?? template.channel,
    subject: render(input.subject ?? template.subject, variables),
    context: render(input.context ?? template.body, variables),
  };
}

async function enrollmentParent(
  dbOrTx: SalesDb,
  actor: Actor,
  input: SalesSequenceEnrollInput,
): Promise<ActivityParent> {
  if (input.leadId) {
    const [lead] = await dbOrTx.select().from(schema.leads).where(and(
      eq(schema.leads.id, input.leadId),
      isNull(schema.leads.deletedAt),
    )).for('update');
    if (!lead) throw err.notFound('Lead not found');
    if (['converted', 'disqualified', 'no_response'].includes(lead.status)) {
      throw err.domain('This lead cannot start a sequence in its current status');
    }
    return {
      leadId: lead.id,
      dealId: null,
      companyId: lead.companyId,
      contactId: input.contactId === undefined ? lead.contactId : input.contactId,
      ownerId: input.ownerId ?? lead.ownerId ?? actor.userId,
      title: lead.title,
    };
  }
  const [deal] = await dbOrTx.select().from(schema.deals).where(and(
    eq(schema.deals.id, input.dealId!),
    isNull(schema.deals.deletedAt),
  )).for('update');
  if (!deal) throw err.notFound('Deal not found');
  const [stage] = await dbOrTx.select().from(schema.dealStages)
    .where(eq(schema.dealStages.id, deal.stageId));
  if (stage?.isWon || stage?.isLost) throw err.domain('Closed deals cannot start a sequence');
  return {
    leadId: null,
    dealId: deal.id,
    companyId: deal.companyId,
    contactId: input.contactId ?? null,
    ownerId: input.ownerId ?? deal.ownerId ?? actor.userId,
    title: deal.title,
  };
}

async function createStepActivity(
  dbOrTx: SalesDb,
  actor: Actor,
  enrollment: {
    id: string;
    leadId: string | null;
    dealId: string | null;
    ownerId: string | null;
  },
  parent: ActivityParent,
  step: typeof schema.salesSequenceSteps.$inferSelect,
  baseAt: Date,
  variables: Record<string, string>,
): Promise<string> {
  const id = ulid();
  await dbOrTx.insert(schema.salesActivities).values({
    id,
    leadId: enrollment.leadId,
    dealId: enrollment.dealId,
    companyId: parent.companyId,
    contactId: parent.contactId,
    type: step.activityType,
    status: 'planned',
    channel: step.channel,
    subject: render(step.subject, variables),
    context: render(step.context, variables),
    dueAt: plusDays(baseAt, step.delayDays),
    ownerId: enrollment.ownerId,
    messageTemplateId: step.templateId,
    sequenceEnrollmentId: enrollment.id,
    sequenceStepId: step.id,
    createdBy: actor.userId,
  });
  return id;
}

export async function enrollSalesSequence(
  actor: Actor,
  sequenceId: string,
  input: SalesSequenceEnrollInput,
) {
  const { db } = getDb();
  return db.transaction(async (tx) => {
    const [sequence] = await tx.select().from(schema.salesSequences).where(and(
      eq(schema.salesSequences.id, sequenceId),
      eq(schema.salesSequences.active, true),
      isNull(schema.salesSequences.deletedAt),
    )).for('update');
    if (!sequence) throw err.notFound('Active sales sequence not found');
    const [firstStep] = await tx.select().from(schema.salesSequenceSteps)
      .where(eq(schema.salesSequenceSteps.sequenceId, sequenceId))
      .orderBy(asc(schema.salesSequenceSteps.position))
      .limit(1);
    if (!firstStep) throw err.domain('The sequence has no steps');
    const parent = await enrollmentParent(tx, actor, input);
    assertSalesWrite(actor, parent.dealId);
    const variables = await variablesFor(tx, parent);

    const [active] = await tx.select({ id: schema.salesSequenceEnrollments.id })
      .from(schema.salesSequenceEnrollments).where(and(
        eq(schema.salesSequenceEnrollments.status, 'active'),
        parent.leadId
          ? eq(schema.salesSequenceEnrollments.leadId, parent.leadId)
          : eq(schema.salesSequenceEnrollments.dealId, parent.dealId!),
      )).limit(1);
    if (active) throw err.domain('This record is already enrolled in a sequence');

    const [planned] = await tx.select({ id: schema.salesActivities.id })
      .from(schema.salesActivities).where(and(
        eq(schema.salesActivities.status, 'planned'),
        isNull(schema.salesActivities.deletedAt),
        parent.leadId
          ? eq(schema.salesActivities.leadId, parent.leadId)
          : eq(schema.salesActivities.dealId, parent.dealId!),
      )).limit(1);
    if (planned) throw err.domain('Complete or cancel the existing planned activity before enrolling');

    if (parent.leadId) {
      const [lead] = await tx.select({
        status: schema.leads.status,
        nurtureUntil: schema.leads.nurtureUntil,
      }).from(schema.leads).where(eq(schema.leads.id, parent.leadId));
      if (lead?.status === 'nurture') {
        await tx.update(schema.leads).set({ status: 'ready', nurtureUntil: null })
          .where(eq(schema.leads.id, parent.leadId));
      }
    }

    const enrollmentId = ulid();
    const startAt = input.startAt ? new Date(input.startAt) : new Date();
    const enrollment = {
      id: enrollmentId,
      sequenceId,
      leadId: parent.leadId,
      dealId: parent.dealId,
      status: 'active',
      currentStepPosition: firstStep.position,
      ownerId: parent.ownerId,
      startedAt: startAt,
      createdBy: actor.userId,
    } as const;
    await tx.insert(schema.salesSequenceEnrollments).values(enrollment);
    const activityId = await createStepActivity(
      tx,
      actor,
      enrollment,
      parent,
      firstStep,
      startAt,
      variables,
    );
    await writeActivity(tx, {
      entityType: parent.leadId ? 'lead' : 'deal',
      entityId: parent.leadId ?? parent.dealId!,
      action: 'sales_sequence_started',
      after: { enrollmentId, sequenceId, activityId },
      actorId: actor.userId,
      actorType: actor.actorType,
    });
    return { id: enrollmentId, activityId };
  });
}

export async function listSalesSequenceEnrollments(params: { leadId?: string; dealId?: string }) {
  const { db } = getDb();
  const rows = await db.select().from(schema.salesSequenceEnrollments).where(and(
    params.leadId ? eq(schema.salesSequenceEnrollments.leadId, params.leadId) : undefined,
    params.dealId ? eq(schema.salesSequenceEnrollments.dealId, params.dealId) : undefined,
  )).orderBy(desc(schema.salesSequenceEnrollments.createdAt));
  const sequenceIds = [...new Set(rows.map((row) => row.sequenceId))];
  const sequences = sequenceIds.length
    ? await db.select({ id: schema.salesSequences.id, name: schema.salesSequences.name })
      .from(schema.salesSequences).where(inArray(schema.salesSequences.id, sequenceIds))
    : [];
  const names = new Map(sequences.map((sequence) => [sequence.id, sequence.name]));
  return rows.map((row) => ({ ...row, sequenceName: names.get(row.sequenceId) ?? '' }));
}

async function parentFromActivity(
  dbOrTx: SalesDb,
  activity: SalesActivity,
): Promise<ActivityParent> {
  const [parent] = activity.leadId
    ? await dbOrTx.select({ title: schema.leads.title }).from(schema.leads)
      .where(eq(schema.leads.id, activity.leadId))
    : await dbOrTx.select({ title: schema.deals.title }).from(schema.deals)
      .where(eq(schema.deals.id, activity.dealId!));
  if (!parent) throw err.notFound('Sales activity parent not found');
  return {
    leadId: activity.leadId,
    dealId: activity.dealId,
    companyId: activity.companyId,
    contactId: activity.contactId,
    ownerId: activity.ownerId,
    title: parent.title,
  };
}

/**
 * Return undefined for a normal activity, null for a finished/stopped
 * sequence, or the id of the next sequence activity.
 */
export async function advanceSequenceActivity(
  dbOrTx: SalesDb,
  actor: Actor,
  activity: SalesActivity,
  input: SalesActivityCompleteInput,
): Promise<string | null | undefined> {
  if (!activity.sequenceEnrollmentId) return undefined;
  if (input.nextActivity) {
    throw err.domain('A sequence activity plans its next step automatically');
  }
  const [enrollment] = await dbOrTx.select().from(schema.salesSequenceEnrollments).where(
    eq(schema.salesSequenceEnrollments.id, activity.sequenceEnrollmentId),
  ).for('update');
  if (!enrollment || enrollment.status !== 'active') return null;

  if (activity.leadId && input.leadStatus && STOPS_LEAD_SEQUENCE.has(input.leadStatus)) {
    await dbOrTx.update(schema.salesSequenceEnrollments).set({
      status: 'stopped',
      stoppedAt: new Date(),
    }).where(eq(schema.salesSequenceEnrollments.id, enrollment.id));
    return null;
  }

  const steps = await dbOrTx.select().from(schema.salesSequenceSteps).where(
    eq(schema.salesSequenceSteps.sequenceId, enrollment.sequenceId),
  ).orderBy(asc(schema.salesSequenceSteps.position)) as SalesSequenceStep[];
  const next = steps.find((step: SalesSequenceStep) =>
    step.position > enrollment.currentStepPosition);
  if (!next) {
    await dbOrTx.update(schema.salesSequenceEnrollments).set({
      status: 'completed',
      completedAt: new Date(),
    }).where(eq(schema.salesSequenceEnrollments.id, enrollment.id));
    return null;
  }

  const parent = await parentFromActivity(dbOrTx, activity);
  const variables = await variablesFor(dbOrTx, parent);
  const nextActivityId = await createStepActivity(
    dbOrTx,
    actor,
    enrollment,
    parent,
    next,
    new Date(),
    variables,
  );
  await dbOrTx.update(schema.salesSequenceEnrollments).set({
    currentStepPosition: next.position,
  }).where(eq(schema.salesSequenceEnrollments.id, enrollment.id));
  return nextActivityId;
}

export async function stopSequenceForActivity(
  dbOrTx: SalesDb,
  activity: SalesActivity,
): Promise<void> {
  if (!activity.sequenceEnrollmentId) return;
  await dbOrTx.update(schema.salesSequenceEnrollments).set({
    status: 'stopped',
    stoppedAt: new Date(),
  }).where(and(
    eq(schema.salesSequenceEnrollments.id, activity.sequenceEnrollmentId),
    eq(schema.salesSequenceEnrollments.status, 'active'),
  ));
}

export async function stopActiveLeadSequence(dbOrTx: SalesDb, leadId: string): Promise<void> {
  await dbOrTx.update(schema.salesSequenceEnrollments).set({
    status: 'stopped',
    stoppedAt: new Date(),
  }).where(and(
    eq(schema.salesSequenceEnrollments.leadId, leadId),
    eq(schema.salesSequenceEnrollments.status, 'active'),
  ));
}

export async function stopActiveDealSequence(dbOrTx: SalesDb, dealId: string): Promise<void> {
  await dbOrTx.update(schema.salesSequenceEnrollments).set({
    status: 'stopped',
    stoppedAt: new Date(),
  }).where(and(
    eq(schema.salesSequenceEnrollments.dealId, dealId),
    eq(schema.salesSequenceEnrollments.status, 'active'),
  ));
}

export async function stopSalesSequenceEnrollment(actor: Actor, id: string, version?: number) {
  const { db } = getDb();
  return db.transaction(async (tx) => {
    const [visible] = await tx.select().from(schema.salesSequenceEnrollments)
      .where(eq(schema.salesSequenceEnrollments.id, id));
    if (!visible) throw err.notFound('Sales sequence enrollment not found');
    assertSalesWrite(actor, visible.dealId);
    if (visible.status === 'stopped') return visible;
    if (visible.status !== 'active') throw err.domain('Only an active sequence can be stopped');
    assertVersion(visible, version, visible);

    // Completion locks activity -> enrollment. Match that order so a concurrent
    // stop cannot deadlock; the final UPDATE also catches a step just advanced
    // while this transaction was waiting for the previous activity.
    await tx.select({ id: schema.salesActivities.id }).from(schema.salesActivities).where(and(
      eq(schema.salesActivities.sequenceEnrollmentId, id),
      eq(schema.salesActivities.status, 'planned'),
      isNull(schema.salesActivities.deletedAt),
    )).for('update');
    const [before] = await tx.select().from(schema.salesSequenceEnrollments)
      .where(eq(schema.salesSequenceEnrollments.id, id))
      .for('update');
    if (!before) throw err.notFound('Sales sequence enrollment not found');
    assertSalesWrite(actor, before.dealId);
    if (before.status === 'stopped') return before;
    if (before.status !== 'active') throw err.domain('Only an active sequence can be stopped');
    assertVersion(before, version, before);

    await tx.update(schema.salesActivities).set({ status: 'cancelled' }).where(and(
      eq(schema.salesActivities.sequenceEnrollmentId, id),
      eq(schema.salesActivities.status, 'planned'),
      isNull(schema.salesActivities.deletedAt),
    ));
    const [after] = await tx.update(schema.salesSequenceEnrollments).set({
      status: 'stopped',
      stoppedAt: new Date(),
    }).where(and(
      eq(schema.salesSequenceEnrollments.id, id),
      eq(schema.salesSequenceEnrollments.version, before.version),
    )).returning();
    if (!after) throw err.conflict('The record was modified by someone else', before);
    await writeActivity(tx, {
      entityType: before.leadId ? 'lead' : 'deal',
      entityId: before.leadId ?? before.dealId!,
      action: 'sales_sequence_stopped',
      before: { enrollmentId: id, status: before.status },
      after: { enrollmentId: id, status: 'stopped' },
      actorId: actor.userId,
      actorType: actor.actorType,
    });
    return after;
  });
}
