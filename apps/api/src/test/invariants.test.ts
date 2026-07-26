import { describe, it, expect, beforeAll } from 'vitest';
import { getDb, schema, eq, and } from '@ordi/db';
import { ulid } from 'ulid';
import { app, resetDb, seedRolesAndUsers, reqAs, json } from './helpers';
import { processOutboxOnce } from '../workers/relay';
import { emit } from '../core/events';

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
});

describe('optimistic version locking (PRD §3.4)', () => {
  it('stale version update returns 409', async () => {
    const owner = reqAs(users.owner!.cookie);
    const created = await json(owner.post('/companies', { name: 'Lockco', defaultCurrency: 'USD' }));
    const company = await json(owner.get(`/companies/${created.id}`));
    expect(company.version).toBe(1);
    const ok = await owner.patch(`/companies/${created.id}`, { name: 'Lockco v2', version: 1 });
    expect(ok.status).toBe(200);
    const conflict = await owner.patch(`/companies/${created.id}`, { name: 'Lockco v3', version: 1 });
    expect(conflict.status).toBe(409);
    const body = await json(conflict);
    expect(body.error.code).toBe('version_conflict');
  });
});

describe('project types drive client + finance behaviour (PRD §5.4)', () => {
  it('rejects an invoice attached to a project whose type does not bill a client', async () => {
    const owner = reqAs(users.owner!.cookie);
    const types = (await json(owner.get('/project-types'))).data as any[];
    const nonBilling = types.find((x) => x.revenueSource === 'none');
    expect(nonBilling).toBeTruthy();
    const company = await json(owner.post('/companies', { name: 'IntCo', defaultCurrency: 'USD' }));
    const internal = await json(owner.post('/projects', { name: 'Ops', key: 'INT', projectTypeId: nonBilling.id }));
    expect(internal.id).toBeTruthy();
    const res = await owner.post('/invoices', {
      companyId: company.id, projectId: internal.id, currency: 'USD',
      issueDate: '2026-01-01', dueDate: '2026-02-01', items: [{ description: 'x', quantity: 1, unitPrice: 100 }],
    });
    expect([422, 400]).toContain(res.status);
  });

  it('a type that requires a client rejects creation without a company', async () => {
    const owner = reqAs(users.owner!.cookie);
    const types = (await json(owner.get('/project-types'))).data as any[];
    const clientType = types.find((x) => x.requiresClient);
    expect(clientType).toBeTruthy();
    const res = await owner.post('/projects', { name: 'No client', key: 'NOCL', projectTypeId: clientType.id });
    expect([422, 400]).toContain(res.status);
    const company = await json(owner.post('/companies', { name: 'CliCo', defaultCurrency: 'USD' }));
    const ok = await json(owner.post('/projects', { name: 'With client', key: 'WCL', projectTypeId: clientType.id, companyId: company.id }));
    expect(ok.id).toBeTruthy();
  });
});

describe('outbox idempotency + dedup (PRD §3.3)', () => {
  it('re-dispatching the same event does not double-process', async () => {
    const { db } = getDb();
    const aggId = ulid();
    await emit({ type: 'task.created', aggregateType: 'task', aggregateId: aggId, payload: { projectId: null } });
    await processOutboxOnce();
    const first = await db.select().from(schema.processedEvents);
    const firstCount = first.length;
    await processOutboxOnce();
    const second = await db.select().from(schema.processedEvents);
    expect(second.length).toBe(firstCount);
    const events = await db.select().from(schema.events).where(eq(schema.events.aggregateId, aggId));
    expect(events[0]?.publishedAt).not.toBeNull();
  });
});

describe('money totals are server-authoritative (PRD §11.3)', () => {
  it('computes invoice totals from items + tax', async () => {
    const owner = reqAs(users.owner!.cookie);
    const company = await json(owner.post('/companies', { name: 'MoneyCo', defaultCurrency: 'USD' }));
    const tax = await json(owner.post('/tax-rates', { name: 'VAT20', ratePercent: 20 }));
    const inv = await json(owner.post('/invoices', {
      companyId: company.id, currency: 'USD', issueDate: '2026-01-01', dueDate: '2026-02-01',
      items: [{ description: 'work', quantity: 2, unitPrice: 100, taxRateId: tax.id }],
    }));
    const full = await json(owner.get(`/invoices/${inv.id}`));
    const subtotal = Number(full.subtotal ?? full.invoice?.subtotal);
    expect(subtotal).toBe(200);
    const total = Number(full.total ?? full.invoice?.total);
    expect(total).toBe(240);
  });
});

describe('dead-letter replay (PRD §3.3)', () => {
  it('replayed event is re-dispatched and completes', async () => {
    const { db } = getDb();
    const owner = reqAs(users.owner!.cookie);
    // Simulate a dead event: outbox row + a dead_letter record with exhausted attempts.
    const eventId = ulid();
    await db.insert(schema.events).values({
      id: eventId, type: 'task.created', aggregateType: 'task', aggregateId: ulid(),
      payload: {}, actorType: 'system',
    });
    const dlqId = ulid();
    await db.insert(schema.deadLetterEvents).values({
      id: dlqId, consumer: 'webhooks', eventId, error: 'forced failure', attempts: 5, payload: {},
    });
    // Listed in the admin DLQ
    const list = await json(owner.get('/dlq'));
    expect((list.data as any[]).some((r) => r.id === dlqId)).toBe(true);
    // Replay resets the row; the relay must then process it (no active webhooks => no-op success)
    const res = await owner.post(`/dlq/${dlqId}/replay`);
    expect(res.status).toBe(200);
    await processOutboxOnce();
    const processed = await db.select().from(schema.processedEvents)
      .where(and(eq(schema.processedEvents.consumer, 'webhooks'), eq(schema.processedEvents.eventId, eventId)));
    expect(processed.length).toBe(1);
    const [ev] = await db.select().from(schema.events).where(eq(schema.events.id, eventId));
    expect(ev?.publishedAt).not.toBeNull();
  });

  it('DLQ admin requires audit.read + settings.manage', async () => {
    expect((await reqAs(users.member!.cookie).get('/dlq')).status).toBe(403);
    expect((await reqAs(users.finance!.cookie).get('/dlq')).status).toBe(403);
  });
});

describe('module toggles are enforced by the API, not just the navigation', () => {
  it('a disabled module stops answering, and settings stay reachable to re-enable it', async () => {
    const owner = reqAs(users.owner!.cookie);
    expect((await owner.get('/invoices')).status).toBe(200);

    await owner.patch('/settings/workspace', { modules: { finance: false } });
    const gated = await owner.get('/invoices');
    expect(gated.status).toBe(404);
    expect((await json(gated)).error.message).toMatch(/finance/i);

    // Turning it back on must never be gated by the thing you turned off.
    expect((await owner.get('/settings/workspace')).status).toBe(200);
    // Core work is not owned by any module.
    expect((await owner.get('/projects')).status).toBe(200);

    await owner.patch('/settings/workspace', { modules: { finance: true } });
    expect((await owner.get('/invoices')).status).toBe(200);
  });
});

describe('a client with records cannot be deleted out from under them', () => {
  it('refuses while a deal exists and allows it once the client is empty', async () => {
    const owner = reqAs(users.owner!.cookie);
    const company = await json(owner.post('/companies', { name: 'Deletable Ltd', defaultCurrency: 'USD' }));

    const empty = await owner.del(`/companies/${company.id}`);
    expect(empty.status).toBe(200);

    const withDeal = await json(owner.post('/companies', { name: 'Has A Deal Ltd', defaultCurrency: 'USD' }));
    const stage = await json(owner.post('/deal-stages', { name: 'Open', position: 0, probability: 10 }));
    const deal = await owner.post('/deals', { companyId: withDeal.id, title: 'Open deal', stageId: stage.id, amount: 1000, currency: 'USD' });
    expect(deal.status).toBe(201);

    const refused = await owner.del(`/companies/${withDeal.id}`);
    expect(refused.status).toBe(422);
    const body = await json(refused);
    expect(body.error.code).toBe('domain_rule');
    expect(body.error.details.deals).toBe(1);
  });
});

describe('a pending invite is visible until it is accepted', () => {
  it('lists, resends and revokes, and disappears once revoked', async () => {
    const owner = reqAs(users.owner!.cookie);
    const roles = await json(owner.get('/roles'));
    const roleId = (roles.data as any[]).find((r) => r.key === 'member')!.id;

    const created = await owner.post('/users/invite', { email: 'pending@example.com', name: 'Pending Person', roleId });
    expect(created.status).toBe(201);
    const invite = await json(created);

    const listed = await json(owner.get('/users/invites'));
    const row = (listed.data as any[]).find((r) => r.email === 'pending@example.com');
    expect(row).toBeTruthy();
    expect(row.name).toBe('Pending Person');
    expect(row.roleId).toBe(roleId);
    // The link is what an admin passes on by hand when email is unavailable.
    expect(row.inviteUrl).toBe(invite.inviteUrl);
    // The raw token never leaves the server in the listing payload.
    expect(row.token).toBeUndefined();

    expect((await owner.post(`/users/invites/${row.id}/resend`, {})).status).toBe(200);

    // Only people who manage users may see or touch invites.
    expect((await reqAs(users.member!.cookie).get('/users/invites')).status).toBe(403);
    expect((await reqAs(users.member!.cookie).del(`/users/invites/${row.id}`)).status).toBe(403);

    expect((await owner.del(`/users/invites/${row.id}`)).status).toBe(200);
    const after = await json(owner.get('/users/invites'));
    expect((after.data as any[]).some((r) => r.id === row.id)).toBe(false);
  });
});

describe('the server tells clients what version it runs', () => {
  it('healthz reports a semver, matching on both paths', async () => {
    const root = await (await app.request('/healthz')).json() as { status: string; version?: string };
    const proxied = await (await app.request('/api/v1/healthz')).json() as { status: string; version?: string };
    expect(root.status).toBe('ok');
    expect(root.version).toMatch(/^\d+\.\d+\.\d+$/);
    // The desktop instance gate reads the /api/v1 path – they must agree.
    expect(proxied.version).toBe(root.version);
  });
});
