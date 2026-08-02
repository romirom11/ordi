import { Hono } from 'hono';
import { getDb, schema, eq, and, isNull, desc, sql } from '@ordi/db';
import { ulid } from 'ulid';
import {
  companyInputSchema, companyUpdateSchema, contactInputSchema, contactUpdateSchema,
  dealStageInputSchema, dealInputSchema, dealUpdateSchema, dealMoveSchema, noteInputSchema,
  leadInputSchema, leadUpdateSchema, leadBulkUpdateSchema, salesActivityInputSchema,
  salesActivityUpdateSchema, salesActivityCancelSchema, salesActivityCompleteSchema, leadConvertSchema,
  salesMessageTemplateInputSchema, salesMessageTemplateUpdateSchema,
  salesSequenceInputSchema, salesSequenceUpdateSchema, salesSequenceEnrollSchema, salesSequenceStopSchema,
  type CustomFieldFilter,
} from '@ordi/shared';
import type { AppEnv } from '../../context';
import { requireAuth, currentActor } from '../../core/auth';
import { guard, guardAll } from '../../core/rbac';
import { err } from '../../lib/errors';
import { writeActivity } from '../../core/activity';
import { idPage, pageById } from '../../lib/http';
import * as svc from './service';
import * as playbooks from './playbooks';
import { assertSalesWrite } from './sales-access';

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
    const { limit, cursor } = idPage(c, 50, 200);
    const rows = await svc.listCompanies({
      q: c.req.query('q'), status: c.req.query('status'), ownerId: c.req.query('ownerId'),
      cfFilters: parseCfFilters(c), cursor, limit,
    });
    return c.json(pageById(rows, limit));
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
    const enabled = (await c.req.json().catch(() => ({}))).enabled;
    return c.json(await svc.rotatePortalToken(currentActor(c), c.req.param('id'), enabled));
  });

  // ── Contacts ──
  app.get('/contacts', guard('crm.read'), async (c) => {
    const companyId = c.req.query('companyId');
    if (!companyId) throw err.validation('companyId required');
    return c.json({ data: await svc.listContacts(companyId) });
  });

  // One contact by id: every other CRM record reads back on its own id, and a
  // caller holding a contactId should not have to know its company to look it up.
  app.get('/contacts/:id', guard('crm.read'), async (c) =>
    c.json(await svc.getContact(c.req.param('id'))));

  app.post('/contacts', guard('crm.write'), async (c) => {
    const body = contactInputSchema.parse(await c.req.json());
    const id = await svc.createContact(currentActor(c), body);
    return c.json({ id }, 201);
  });

  app.patch('/contacts/:id', guard('crm.write'), async (c) => {
    const body = contactUpdateSchema.parse(await c.req.json());
    await svc.updateContact(currentActor(c), c.req.param('id'), body);
    return c.json({ ok: true });
  });

  app.delete('/contacts/:id', guard('crm.write'), async (c) => {
    await svc.softDeleteContact(currentActor(c), c.req.param('id'));
    return c.json({ ok: true });
  });

  // ── Leads ──
  app.get('/leads', guard('crm.read'), async (c) => {
    // listLeads returns { data, truncated } – the bounded list says when it is cut.
    return c.json(await svc.listLeads({
      q: c.req.query('q'),
      status: c.req.query('status'),
      companyId: c.req.query('companyId'),
      ownerId: c.req.query('ownerId'),
      limit: Number(c.req.query('limit') ?? 100),
    }));
  });

  app.post('/leads', guard('crm.write'), async (c) => {
    const body = leadInputSchema.parse(await c.req.json());
    const id = await svc.createLead(currentActor(c), body);
    return c.json({ id }, 201);
  });

  // Before /leads/:id so the path segment 'bulk' is not read as a lead id.
  app.post('/leads/bulk', guard('crm.write'), async (c) => {
    const body = leadBulkUpdateSchema.parse(await c.req.json());
    return c.json(await svc.bulkUpdateLeads(currentActor(c), body));
  });

  app.get('/leads/:id', guard('crm.read'), async (c) => c.json(await svc.getLead(c.req.param('id'))));

  app.patch('/leads/:id', guard('crm.write'), async (c) => {
    const body = leadUpdateSchema.parse(await c.req.json());
    return c.json(await svc.updateLead(currentActor(c), c.req.param('id'), body));
  });

  app.post('/leads/:id/convert', guardAll('crm.write', 'deals.write'), async (c) => {
    const body = leadConvertSchema.parse(await c.req.json().catch(() => ({})));
    return c.json(await svc.convertLead(currentActor(c), c.req.param('id'), body));
  });

  app.delete('/leads/:id', guard('crm.delete'), async (c) => {
    await svc.softDeleteLead(currentActor(c), c.req.param('id'));
    return c.json({ ok: true });
  });

  // ── Deal stages (config) ──
  app.get('/deal-stages', guard('deals.read'), async (c) => {
    const { db } = getDb();
    return c.json({
      data: await db.select().from(schema.dealStages).orderBy(schema.dealStages.position),
    });
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
    const { limit, cursor } = idPage(c, 100, 200);
    const rows = await svc.listDeals({
      companyId: c.req.query('companyId'),
      projectId: c.req.query('projectId'),
      cursor, limit,
    });
    return c.json(pageById(rows, limit));
  });

  app.post('/deals', guard('deals.write'), async (c) => {
    const body = dealInputSchema.parse(await c.req.json());
    const id = await svc.createDeal(currentActor(c), body);
    return c.json({ id }, 201);
  });

  app.get('/deals/:id', guard('deals.read'), async (c) => c.json(await svc.getDeal(c.req.param('id'))));

  app.patch('/deals/:id', guard('deals.write'), async (c) => {
    const body = dealUpdateSchema.parse(await c.req.json());
    return c.json(await svc.updateDeal(currentActor(c), c.req.param('id'), body));
  });

  app.post('/deals/:id/move', guard('deals.write'), async (c) => {
    const body = dealMoveSchema.parse(await c.req.json());
    return c.json(await svc.moveDeal(currentActor(c), c.req.param('id'), body.stageId, body.lostReason, body.version));
  });

  app.delete('/deals/:id', guard('deals.delete'), async (c) => {
    await svc.softDeleteDeal(currentActor(c), c.req.param('id'));
    return c.json({ ok: true });
  });

  // ── Sales activities and Work queue ──
  app.get('/sales-work', guard('crm.read'), async (c) => {
    const scope = c.req.query('scope') === 'all' ? 'all' : 'mine';
    return c.json(await svc.salesWork(currentActor(c), {
      scope,
      limit: Number(c.req.query('limit') ?? 50),
    }));
  });

  app.get('/sales-analytics', guard('crm.read'), async (c) => {
    const actor = currentActor(c);
    return c.json(await svc.salesAnalytics({
      includeDeals: actor.access.permissions.has('deals.read'),
    }));
  });

  app.get('/sales-activities', async (c) => {
    const actor = currentActor(c);
    const leadId = c.req.query('leadId');
    const dealId = c.req.query('dealId');
    const canReadLeads = actor.access.permissions.has('crm.read');
    const canReadDeals = actor.access.permissions.has('deals.read');
    if (leadId && !canReadLeads) throw err.forbidden('Missing permission crm.read', 'crm.read');
    if (dealId && !canReadDeals) throw err.forbidden('Missing permission deals.read', 'deals.read');
    if (!canReadLeads && !canReadDeals) throw err.forbidden('Missing CRM or deals read permission');
    return c.json({ data: await svc.listSalesActivities({
      leadId,
      dealId,
      companyId: c.req.query('companyId'),
      ownerId: c.req.query('ownerId'),
      status: c.req.query('status'),
      includeLeads: canReadLeads,
      includeDeals: canReadDeals,
      limit: Number(c.req.query('limit') ?? 100),
    }) });
  });

  // ── Sales playbooks: reusable copy and manual-action sequences ──
  app.get('/sales-message-templates', guard('crm.read'), async (c) => {
    return c.json({
      data: await playbooks.listSalesMessageTemplates(c.req.query('active') !== 'true'),
    });
  });

  app.post('/sales-message-templates', guard('crm.write'), async (c) => {
    const body = salesMessageTemplateInputSchema.parse(await c.req.json());
    const id = await playbooks.createSalesMessageTemplate(currentActor(c), body);
    return c.json({ id }, 201);
  });

  app.patch('/sales-message-templates/:id', guard('crm.write'), async (c) => {
    const body = salesMessageTemplateUpdateSchema.parse(await c.req.json());
    return c.json(await playbooks.updateSalesMessageTemplate(
      currentActor(c),
      c.req.param('id'),
      body,
    ));
  });

  app.get('/sales-sequences', guard('crm.read'), async (c) => {
    return c.json({
      data: await playbooks.listSalesSequences(c.req.query('active') !== 'true'),
    });
  });

  app.post('/sales-sequences', guard('crm.write'), async (c) => {
    const body = salesSequenceInputSchema.parse(await c.req.json());
    const id = await playbooks.createSalesSequence(currentActor(c), body);
    return c.json({ id }, 201);
  });

  app.patch('/sales-sequences/:id', guard('crm.write'), async (c) => {
    const body = salesSequenceUpdateSchema.parse(await c.req.json());
    return c.json(await playbooks.updateSalesSequence(currentActor(c), c.req.param('id'), body));
  });

  app.post('/sales-sequences/:id/enroll', async (c) => {
    const actor = currentActor(c);
    const body = salesSequenceEnrollSchema.parse(await c.req.json());
    assertSalesWrite(actor, body.dealId);
    return c.json(await playbooks.enrollSalesSequence(actor, c.req.param('id'), body), 201);
  });

  app.get('/sales-sequence-enrollments', async (c) => {
    const actor = currentActor(c);
    const leadId = c.req.query('leadId');
    const dealId = c.req.query('dealId');
    if (!leadId && !dealId) throw err.validation('leadId or dealId required');
    if (leadId && !actor.access.permissions.has('crm.read')) {
      throw err.forbidden('Missing permission crm.read', 'crm.read');
    }
    if (dealId && !actor.access.permissions.has('deals.read')) {
      throw err.forbidden('Missing permission deals.read', 'deals.read');
    }
    return c.json({ data: await playbooks.listSalesSequenceEnrollments({ leadId, dealId }) });
  });

  app.post('/sales-sequence-enrollments/:id/stop', async (c) => {
    const actor = currentActor(c);
    const body = salesSequenceStopSchema.parse(await c.req.json().catch(() => ({})));
    return c.json(await playbooks.stopSalesSequenceEnrollment(
      actor,
      c.req.param('id'),
      body.version,
    ));
  });

  app.post('/sales-activities', async (c) => {
    const actor = currentActor(c);
    const body = salesActivityInputSchema.parse(await c.req.json());
    assertSalesWrite(actor, body.dealId);
    const id = await svc.createSalesActivity(actor, body);
    return c.json({ id }, 201);
  });

  app.patch('/sales-activities/:id', async (c) => {
    const actor = currentActor(c);
    const body = salesActivityUpdateSchema.parse(await c.req.json());
    const activity = await svc.getSalesActivity(c.req.param('id'));
    assertSalesWrite(actor, activity.dealId);
    return c.json(await svc.updateSalesActivity(actor, activity.id, body));
  });

  app.post('/sales-activities/:id/complete', async (c) => {
    const actor = currentActor(c);
    const body = salesActivityCompleteSchema.parse(await c.req.json().catch(() => ({})));
    const activity = await svc.getSalesActivity(c.req.param('id'));
    assertSalesWrite(actor, activity.dealId);
    return c.json(await svc.completeSalesActivity(actor, activity.id, body));
  });

  app.post('/sales-activities/:id/cancel', async (c) => {
    const actor = currentActor(c);
    const body = salesActivityCancelSchema.parse(await c.req.json().catch(() => ({})));
    const activity = await svc.getSalesActivity(c.req.param('id'));
    assertSalesWrite(actor, activity.dealId);
    await svc.cancelSalesActivity(actor, activity.id, body.version);
    return c.json({ ok: true });
  });

  // ── Notes ──
  app.get('/notes', guard('crm.read'), async (c) => {
    const { db } = getDb();
    const companyId = c.req.query('companyId');
    const contactId = c.req.query('contactId');
    const leadId = c.req.query('leadId');
    const dealId = c.req.query('dealId');
    const rows = await db.select().from(schema.notes).where(and(
      isNull(schema.notes.deletedAt),
      companyId ? eq(schema.notes.companyId, companyId) : undefined,
      contactId ? eq(schema.notes.contactId, contactId) : undefined,
      leadId ? eq(schema.notes.leadId, leadId) : undefined,
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
      id, companyId: body.companyId ?? null, contactId: body.contactId ?? null,
      leadId: body.leadId ?? null, dealId: body.dealId ?? null,
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
