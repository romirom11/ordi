/**
 * Deal ↔ project linking: a deal can point at the product/delivery project it
 * sells into (SaaS lead vs. services lead), the link is validated against live
 * projects, filterable, and clearable.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { getDb, schema, eq } from '@ordi/db';
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
  await db.insert(schema.dealStages).values({ id: stageId, name: 'Qualified', position: 0 });

  const typeId = ulid();
  await db.insert(schema.projectTypes).values({ id: typeId, name: 'Product' });
  projectId = ulid();
  await db.insert(schema.projects).values({
    id: projectId, name: 'Solovei', key: 'SOL', projectTypeId: typeId, createdBy: users.owner!.userId,
  });
  // Project writes require project-admin membership even for the workspace owner.
  await db.insert(schema.projectMembers).values({ projectId, userId: users.owner!.userId, role: 'admin' });
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

describe('project ↔ company link via PATCH', () => {
  it('links and unlinks a company on an existing project', async () => {
    const before = await json(reqAs(users.owner!.cookie).get(`/projects/${projectId}`));
    const link = await reqAs(users.owner!.cookie).patch(`/projects/${projectId}`, { companyId, version: before.version });
    expect(link.status).toBe(200);
    expect((await json(reqAs(users.owner!.cookie).get(`/projects/${projectId}`))).companyId).toBe(companyId);

    // The company's project list picks it up.
    const list = await json(reqAs(users.owner!.cookie).get(`/projects?companyId=${companyId}`));
    expect(list.data.map((p: any) => p.id)).toContain(projectId);

    const mid = await json(reqAs(users.owner!.cookie).get(`/projects/${projectId}`));
    const unlink = await reqAs(users.owner!.cookie).patch(`/projects/${projectId}`, { companyId: null, version: mid.version });
    expect(unlink.status).toBe(200);
    expect((await json(reqAs(users.owner!.cookie).get(`/projects/${projectId}`))).companyId).toBeNull();
  });

  it('refuses to unlink when the project type requires a client', async () => {
    const { db } = getDb();
    const typeId = ulid();
    await db.insert(schema.projectTypes).values({ id: typeId, name: 'Client work', requiresClient: true });
    const pid = ulid();
    await db.insert(schema.projects).values({
      id: pid, name: 'Client site', key: 'CLI', projectTypeId: typeId, companyId, createdBy: users.owner!.userId,
    });
    await db.insert(schema.projectMembers).values({ projectId: pid, userId: users.owner!.userId, role: 'admin' });
    const before = await json(reqAs(users.owner!.cookie).get(`/projects/${pid}`));
    const res = await reqAs(users.owner!.cookie).patch(`/projects/${pid}`, { companyId: null, version: before.version });
    expect(res.status).toBe(400);
  });
});

/**
 * A client is undeletable while live records still point at it – but only live
 * ones. Deleting a deal, or demoting it back to a lead (which soft-deletes the
 * deal), used to leave a ghost the guard still counted, so the client could
 * never be deleted and nothing on screen said why.
 */
describe('company deletion dependencies', () => {
  const owner = () => reqAs(users.owner!.cookie);
  let clientId: string;
  let dealId: string;

  beforeAll(async () => {
    clientId = (await json(owner().post('/companies', { name: 'Lea Hough & Co LLP' }))).id;
  });

  it('names what blocks the delete, with counts', async () => {
    dealId = (await json(owner().post('/deals', { companyId: clientId, stageId, title: 'Survey work' }))).id;

    const res = await owner().del(`/companies/${clientId}`);
    expect(res.status).toBe(422);
    const body = await json(res);
    expect(body.error.message).toContain('1 deal');
    expect(body.error.details).toMatchObject({ deals: 1, leads: 0, projects: 0, invoices: 0 });
  });

  it('lists every blocker, not a fixed sentence', async () => {
    await owner().post('/leads', { companyId: clientId, title: 'Retrofit survey' });
    const body = await json(owner().del(`/companies/${clientId}`));
    expect(body.error.message).toContain('1 lead and 1 deal');
  });

  it('a deleted deal and lead stop blocking – the client deletes cleanly', async () => {
    const leads = await json(owner().get(`/leads?companyId=${clientId}`));
    for (const lead of leads.data) expect((await owner().del(`/leads/${lead.id}`)).status).toBe(200);
    expect((await owner().del(`/deals/${dealId}`)).status).toBe(200);

    expect((await owner().del(`/companies/${clientId}`)).status).toBe(200);
    expect((await owner().get(`/companies/${clientId}`)).status).toBe(404);
  });

});

describe('entity attachments', () => {
  let fileId: string;

  it('registers and lists files on a company', async () => {
    const reg = await reqAs(users.owner!.cookie).post('/attachments/register', {
      entityType: 'company', entityId: companyId, fileKey: 'uploads/x/brief.pdf',
      filename: 'brief.pdf', size: 1234, mime: 'application/pdf',
    });
    expect(reg.status).toBe(201);
    fileId = (await json(reg)).id;

    const list = await json(reqAs(users.owner!.cookie).get(`/attachments?entityType=company&entityId=${companyId}`));
    expect(list.data).toHaveLength(1);
    expect(list.data[0].filename).toBe('brief.pdf');
  });

  it('guest (no crm.read) cannot list company files', async () => {
    const res = await reqAs(users.guest!.cookie).get(`/attachments?entityType=company&entityId=${companyId}`);
    expect(res.status).toBe(403);
  });

  it('member (no crm.write) cannot delete a company file; owner can', async () => {
    expect((await reqAs(users.member!.cookie).del(`/attachments/${fileId}`)).status).toBe(403);
    expect((await reqAs(users.owner!.cookie).del(`/attachments/${fileId}`)).status).toBe(200);
    const list = await json(reqAs(users.owner!.cookie).get(`/attachments?entityType=company&entityId=${companyId}`));
    expect(list.data).toHaveLength(0);
  });

  it('rejects unknown entity types', async () => {
    const res = await reqAs(users.owner!.cookie).get('/attachments?entityType=weird&entityId=x');
    expect(res.status).toBe(400);
  });
});

describe('bounded lists and portal tokens', () => {
  it('pages /deals instead of returning the whole pipeline', async () => {
    const pagedCompanyId = ulid();
    const { db } = getDb();
    await db.insert(schema.companies).values({
      id: pagedCompanyId,
      name: 'Paged Pipeline',
      createdBy: users.owner!.userId,
    });
    for (const title of ['One', 'Two', 'Three']) {
      const created = await reqAs(users.owner!.cookie).post('/deals', {
        companyId: pagedCompanyId, stageId, title,
      });
      expect(created.status).toBe(201);
    }

    const first = await json(reqAs(users.owner!.cookie)
      .get(`/deals?companyId=${pagedCompanyId}&limit=2`));
    expect(first.data).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();

    const second = await json(reqAs(users.owner!.cookie)
      .get(`/deals?companyId=${pagedCompanyId}&limit=2&cursor=${encodeURIComponent(first.nextCursor)}`));
    expect(second.data).toHaveLength(1);
    expect(second.nextCursor).toBeNull();

    // No row appears on both pages and none goes missing.
    const seen = [...first.data, ...second.data].map((row: any) => row.id);
    expect(new Set(seen).size).toBe(3);
  });

  it('refuses to mint a portal token for a company that does not exist', async () => {
    const missing = await reqAs(users.owner!.cookie).post(`/companies/${ulid()}/portal`, {});
    expect(missing.status).toBe(404);
  });

  it('rotates the portal token and records it in the company history', async () => {
    const { db } = getDb();
    const before = await json(reqAs(users.owner!.cookie).get(`/companies/${companyId}`));
    const rotated = await json(reqAs(users.owner!.cookie)
      .post(`/companies/${companyId}/portal`, { enabled: true }));
    expect(rotated.portalToken).toBeTruthy();
    expect(rotated.portalToken).not.toBe(before.portalToken);

    const after = await json(reqAs(users.owner!.cookie).get(`/companies/${companyId}`));
    expect(after.portalEnabled).toBe(true);

    const audit = await db.select().from(schema.activityLog)
      .where(eq(schema.activityLog.entityId, companyId));
    expect(audit.some((row) => row.action === 'portal_token_rotated')).toBe(true);
    // The token itself must never land in the audit diff.
    expect(JSON.stringify(audit)).not.toContain(rotated.portalToken);
  });
});

describe('company list paging', () => {
  it('honours the cursor it hands out instead of replaying page one', async () => {
    const first = await json(reqAs(users.owner!.cookie).get('/companies?limit=1'));
    expect(first.data).toHaveLength(1);
    expect(first.nextCursor).toBeTruthy();

    const second = await json(reqAs(users.owner!.cookie)
      .get(`/companies?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`));
    expect(second.data).toHaveLength(1);
    expect(second.data[0].id).not.toBe(first.data[0].id);
  });
});
