import { Hono } from 'hono';
import { getDb, schema, eq, and, isNull, desc, sql } from '@ordi/db';
import { ulid } from 'ulid';
import {
  companyInputSchema, companyUpdateSchema, contactInputSchema, contactUpdateSchema,
  dealStageInputSchema, dealInputSchema, dealUpdateSchema, dealMoveSchema, noteInputSchema,
  type CustomFieldFilter,
} from '@ordi/shared';
import type { AppEnv } from '../../context';
import { requireAuth, currentActor } from '../../core/auth';
import { guard } from '../../core/rbac';
import { err } from '../../lib/errors';
import { writeActivity } from '../../core/activity';
import { assertVersion } from '../../core/locking';
import { mergeCustomFields } from '../../core/customfields';
import { page } from '../../lib/http';
import * as svc from './service';

/** A deal may only link to a live project – the FK allows any id, deleted ones included. */
async function assertProjectExists(projectId: string): Promise<void> {
  const { db } = getDb();
  const [p] = await db.select({ id: schema.projects.id }).from(schema.projects)
    .where(and(eq(schema.projects.id, projectId), isNull(schema.projects.deletedAt)));
  if (!p) throw err.validation('Unknown project');
}

function parseCfFilters(c: any): CustomFieldFilter[] {
  const raw = c.req.query('cf');
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

export function crmRoutes() {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth);

  // ── Companies ──
  app.get('/companies', guard('crm.read'), async (c) => {
    const limit = Number(c.req.query('limit') ?? 50);
    const rows = await svc.listCompanies({
      q: c.req.query('q'), status: c.req.query('status'), ownerId: c.req.query('ownerId'),
      cfFilters: parseCfFilters(c), limit,
    });
    return c.json(page(rows, limit, (r) => ({ createdAt: r.createdAt })));
  });

  app.post('/companies', guard('crm.write'), async (c) => {
    const body = companyInputSchema.parse(await c.req.json());
    const id = await svc.createCompany(currentActor(c), body);
    return c.json({ id }, 201);
  });

  app.get('/companies/:id', guard('crm.read'), async (c) => c.json(await svc.getCompany(c.req.param('id'))));

  app.get('/companies/:id/overview', guard('crm.read'), async (c) =>
    c.json(await svc.companyOverview(currentActor(c), c.req.param('id'))));

  app.patch('/companies/:id', guard('crm.write'), async (c) => {
    const body = companyUpdateSchema.parse(await c.req.json());
    return c.json(await svc.updateCompany(currentActor(c), c.req.param('id'), body));
  });

  app.delete('/companies/:id', guard('crm.delete'), async (c) => {
    await svc.softDeleteCompany(currentActor(c), c.req.param('id'));
    return c.json({ ok: true });
  });

  app.post('/companies/:id/portal', guard('crm.write'), async (c) => {
    const { db } = getDb();
    const token = ulid();
    const enabled = (await c.req.json().catch(() => ({}))).enabled;
    await db.update(schema.companies).set({ portalToken: token, ...(enabled !== undefined ? { portalEnabled: enabled } : {}) })
      .where(eq(schema.companies.id, c.req.param('id')));
    return c.json({ portalToken: token });
  });

  // ── Contacts ──
  app.get('/contacts', guard('crm.read'), async (c) => {
    const companyId = c.req.query('companyId');
    if (!companyId) throw err.validation('companyId required');
    return c.json({ data: await svc.listContacts(companyId) });
  });

  // One contact by id: every other CRM record reads back on its own id, and a
  // caller holding a contactId should not have to know its company to look it up.
  app.get('/contacts/:id', guard('crm.read'), async (c) => {
    const { db } = getDb();
    const [contact] = await db.select().from(schema.contacts)
      .where(and(eq(schema.contacts.id, c.req.param('id')), isNull(schema.contacts.deletedAt)));
    if (!contact) throw err.notFound('Contact not found');
    return c.json(contact);
  });

  app.post('/contacts', guard('crm.write'), async (c) => {
    const body = contactInputSchema.parse(await c.req.json());
    const id = await svc.createContact(currentActor(c), body);
    return c.json({ id }, 201);
  });

  app.patch('/contacts/:id', guard('crm.write'), async (c) => {
    const body = contactUpdateSchema.parse(await c.req.json());
    const { db } = getDb();
    const [before] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, c.req.param('id')));
    if (!before) throw err.notFound();
    assertVersion(before, body.version, before);
    const patch: Record<string, unknown> = {};
    for (const k of ['firstName', 'lastName', 'email', 'phone', 'position', 'isPrimary']) {
      if ((body as any)[k] !== undefined) patch[k] = (body as any)[k];
    }
    if (body.customFields !== undefined) patch.customFields = mergeCustomFields(before.customFields, body.customFields);
    if (patch.isPrimary === true) {
      await db.update(schema.contacts).set({ isPrimary: false }).where(eq(schema.contacts.companyId, before.companyId));
    }
    await db.update(schema.contacts).set(patch).where(and(eq(schema.contacts.id, c.req.param('id')), eq(schema.contacts.version, before.version)));
    return c.json({ ok: true });
  });

  app.delete('/contacts/:id', guard('crm.write'), async (c) => {
    const { db } = getDb();
    await db.update(schema.contacts).set({ deletedAt: new Date() }).where(eq(schema.contacts.id, c.req.param('id')));
    return c.json({ ok: true });
  });

  // ── Deal stages (config) ──
  app.get('/deal-stages', guard('deals.read'), async (c) => {
    const { db } = getDb();
    return c.json({ data: await db.select().from(schema.dealStages).orderBy(schema.dealStages.position) });
  });

  app.post('/deal-stages', guard('settings.manage'), async (c) => {
    const body = dealStageInputSchema.parse(await c.req.json());
    const { db } = getDb();
    const id = ulid();
    await db.insert(schema.dealStages).values({ id, ...body });
    return c.json({ id }, 201);
  });

  app.patch('/deal-stages/:id', guard('settings.manage'), async (c) => {
    const body = dealStageInputSchema.partial().parse(await c.req.json());
    const { db } = getDb();
    await db.update(schema.dealStages).set(body).where(eq(schema.dealStages.id, c.req.param('id')));
    return c.json({ ok: true });
  });

  app.delete('/deal-stages/:id', guard('settings.manage'), async (c) => {
    const { db } = getDb();
    const id = c.req.param('id');
    const stageRows = await db.select({ count: sql<number>`count(*)::int` }).from(schema.deals).where(eq(schema.deals.stageId, id));
    if (Number(stageRows[0]?.count ?? 0) > 0) throw err.domain('Stage has deals; move them first');
    await db.delete(schema.dealStages).where(eq(schema.dealStages.id, id));
    return c.json({ ok: true });
  });

  // ── Deals ──
  app.get('/deals', guard('deals.read'), async (c) => {
    const { db } = getDb();
    const companyId = c.req.query('companyId');
    // projectId filter: a ulid narrows to that project, the literal 'none' to unlinked deals.
    const projectId = c.req.query('projectId');
    const rows = await db.select().from(schema.deals).where(and(
      isNull(schema.deals.deletedAt),
      companyId ? eq(schema.deals.companyId, companyId) : undefined,
      projectId === 'none' ? isNull(schema.deals.projectId)
        : projectId ? eq(schema.deals.projectId, projectId) : undefined,
    )).orderBy(desc(schema.deals.createdAt));
    return c.json({ data: rows });
  });

  app.post('/deals', guard('deals.write'), async (c) => {
    const body = dealInputSchema.parse(await c.req.json());
    const { db } = getDb();
    const actor = currentActor(c);
    if (body.projectId) await assertProjectExists(body.projectId);
    const id = ulid();
    await db.insert(schema.deals).values({
      id, companyId: body.companyId, projectId: body.projectId ?? null, title: body.title, stageId: body.stageId,
      amount: String(body.amount), currency: body.currency, expectedCloseDate: body.expectedCloseDate ?? null,
      ownerId: body.ownerId ?? null, customFields: body.customFields ?? {}, createdBy: actor.userId,
    });
    await writeActivity(db, { entityType: 'deal', entityId: id, action: 'created', after: body, actorId: actor.userId, actorType: actor.actorType });
    return c.json({ id }, 201);
  });

  app.get('/deals/:id', guard('deals.read'), async (c) => c.json(await svc.getDeal(c.req.param('id'))));

  app.patch('/deals/:id', guard('deals.write'), async (c) => {
    const body = dealUpdateSchema.parse(await c.req.json());
    const { db } = getDb();
    const deal = await svc.getDeal(c.req.param('id'));
    assertVersion(deal, body.version, deal);
    if (body.projectId) await assertProjectExists(body.projectId);
    const patch: Record<string, unknown> = {};
    for (const k of ['title', 'amount', 'currency', 'expectedCloseDate', 'ownerId', 'stageId', 'projectId']) {
      if ((body as any)[k] !== undefined) patch[k] = k === 'amount' ? String((body as any)[k]) : (body as any)[k];
    }
    if (body.customFields !== undefined) patch.customFields = mergeCustomFields(deal.customFields, body.customFields);
    await db.update(schema.deals).set(patch).where(and(eq(schema.deals.id, deal.id), eq(schema.deals.version, deal.version)));
    return c.json(await svc.getDeal(deal.id));
  });

  app.post('/deals/:id/move', guard('deals.write'), async (c) => {
    const body = dealMoveSchema.parse(await c.req.json());
    return c.json(await svc.moveDeal(currentActor(c), c.req.param('id'), body.stageId, body.lostReason, body.version));
  });

  app.delete('/deals/:id', guard('deals.delete'), async (c) => {
    const { db } = getDb();
    await db.update(schema.deals).set({ deletedAt: new Date() }).where(eq(schema.deals.id, c.req.param('id')));
    return c.json({ ok: true });
  });

  // ── Notes ──
  app.get('/notes', guard('crm.read'), async (c) => {
    const { db } = getDb();
    const companyId = c.req.query('companyId');
    const contactId = c.req.query('contactId');
    const dealId = c.req.query('dealId');
    const rows = await db.select().from(schema.notes).where(and(
      isNull(schema.notes.deletedAt),
      companyId ? eq(schema.notes.companyId, companyId) : undefined,
      contactId ? eq(schema.notes.contactId, contactId) : undefined,
      dealId ? eq(schema.notes.dealId, dealId) : undefined,
    )).orderBy(desc(schema.notes.pinned), desc(schema.notes.createdAt));
    return c.json({ data: rows });
  });

  app.post('/notes', guard('crm.write'), async (c) => {
    const body = noteInputSchema.parse(await c.req.json());
    const { db } = getDb();
    const actor = currentActor(c);
    const id = ulid();
    await db.insert(schema.notes).values({
      id, companyId: body.companyId ?? null, contactId: body.contactId ?? null, dealId: body.dealId ?? null,
      body: body.body, pinned: body.pinned, createdBy: actor.userId,
    });
    // Fact-only (like task comments): the note body itself stays out of the diff.
    await writeActivity(db, { entityType: 'note', entityId: id, action: 'created', actorId: actor.userId, actorType: actor.actorType });
    return c.json({ id }, 201);
  });

  app.patch('/notes/:id', guard('crm.write'), async (c) => {
    const body = await c.req.json();
    const { db } = getDb();
    const actor = currentActor(c);
    await db.update(schema.notes).set({
      ...(body.body !== undefined ? { body: body.body } : {}),
      ...(body.pinned !== undefined ? { pinned: body.pinned } : {}),
    }).where(eq(schema.notes.id, c.req.param('id')));
    await writeActivity(db, { entityType: 'note', entityId: c.req.param('id'), action: 'updated', actorId: actor.userId, actorType: actor.actorType });
    return c.json({ ok: true });
  });

  app.delete('/notes/:id', guard('crm.write'), async (c) => {
    const { db } = getDb();
    const actor = currentActor(c);
    await db.update(schema.notes).set({ deletedAt: new Date() }).where(eq(schema.notes.id, c.req.param('id')));
    await writeActivity(db, { entityType: 'note', entityId: c.req.param('id'), action: 'deleted', actorId: actor.userId, actorType: actor.actorType });
    return c.json({ ok: true });
  });

  return app;
}
