import { describe, it, expect, beforeAll } from 'vitest';
import { getDb, schema, eq } from '@ordi/db';
import { ulid } from 'ulid';
import { resetDb, seedRolesAndUsers, reqAs, json } from './helpers';
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

describe('internal projects do not leak into finance (PRD §5.4)', () => {
  it('rejects an invoice attached to an internal project', async () => {
    const owner = reqAs(users.owner!.cookie);
    const company = await json(owner.post('/companies', { name: 'IntCo', defaultCurrency: 'USD' }));
    const internal = await json(owner.post('/projects', { name: 'Ops', key: 'INT', kind: 'internal' }));
    expect(internal.id).toBeTruthy();
    const res = await owner.post('/invoices', {
      companyId: company.id, projectId: internal.id, currency: 'USD',
      issueDate: '2026-01-01', dueDate: '2026-02-01', items: [{ description: 'x', quantity: 1, unitPrice: 100 }],
    });
    expect([422, 400]).toContain(res.status);
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
