/**
 * Deal ↔ project linking: a deal can point at the product/delivery project it
 * sells into (SaaS lead vs. services lead), the link is validated against live
 * projects, filterable, and clearable.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { getDb, schema } from '@ordi/db';
import { ulid } from 'ulid';
import { resetDb, seedRolesAndUsers, reqAs, json } from './helpers';

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
let companyId: string;
let projectId: string;
let stageId: string;

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
  const { db } = getDb();

  companyId = ulid();
  await db.insert(schema.companies).values({ id: companyId, name: 'Kdn Agency', createdBy: users.owner!.userId });

  stageId = ulid();
  await db.insert(schema.dealStages).values({ id: stageId, name: 'Lead', position: 0 });

  const typeId = ulid();
  await db.insert(schema.projectTypes).values({ id: typeId, name: 'Product' });
  projectId = ulid();
  await db.insert(schema.projects).values({
    id: projectId, name: 'Solovei', key: 'SOL', projectTypeId: typeId, createdBy: users.owner!.userId,
  });
});

describe('deal ↔ project link', () => {
  let dealId: string;

  it('creates a deal linked to a project', async () => {
    const res = await reqAs(users.owner!.cookie).post('/deals', {
      companyId, stageId, projectId, title: 'Solovei lead: EMA Training', amount: 500,
    });
    expect(res.status).toBe(201);
    dealId = (await json(res)).id;

    const deal = await json(reqAs(users.owner!.cookie).get(`/deals/${dealId}`));
    expect(deal.projectId).toBe(projectId);
  });

  it('rejects a link to an unknown project', async () => {
    const res = await reqAs(users.owner!.cookie).post('/deals', {
      companyId, stageId, projectId: ulid(), title: 'Bad link',
    });
    expect(res.status).toBe(400);
  });

  it('filters deals by project and by "none"', async () => {
    await reqAs(users.owner!.cookie).post('/deals', { companyId, stageId, title: 'Website lead' });

    const linked = await json(reqAs(users.owner!.cookie).get(`/deals?projectId=${projectId}`));
    expect(linked.data).toHaveLength(1);
    expect(linked.data[0].title).toBe('Solovei lead: EMA Training');

    const unlinked = await json(reqAs(users.owner!.cookie).get('/deals?projectId=none'));
    expect(unlinked.data).toHaveLength(1);
    expect(unlinked.data[0].title).toBe('Website lead');

    const all = await json(reqAs(users.owner!.cookie).get('/deals'));
    expect(all.data).toHaveLength(2);
  });

  it('clears the link via PATCH projectId=null', async () => {
    const before = await json(reqAs(users.owner!.cookie).get(`/deals/${dealId}`));
    const res = await reqAs(users.owner!.cookie).patch(`/deals/${dealId}`, { projectId: null, version: before.version });
    expect(res.status).toBe(200);
    expect((await json(reqAs(users.owner!.cookie).get(`/deals/${dealId}`))).projectId).toBeNull();
  });

  it('member (deals.write, no settings) can link too – it is a deal write, not admin', async () => {
    const res = await reqAs(users.member!.cookie).post('/deals', {
      companyId, stageId, projectId, title: 'Member-created Solovei lead',
    });
    expect(res.status).toBe(201);
  });
});
