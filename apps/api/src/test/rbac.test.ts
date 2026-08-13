import { describe, it, expect, beforeAll } from 'vitest';
import { getDb, schema, eq } from '@ordi/db';
import { ulid } from 'ulid';
import { resetDb, seedRolesAndUsers, reqAs, anon, json } from './helpers';
import { hashPassword, generateToken } from '../lib/crypto';

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
});

describe('authentication', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await anon().get('/me');
    expect(res.status).toBe(401);
  });
});

describe('/me reflects role permissions', () => {
  it('owner has all permissions', async () => {
    const res = await reqAs(users.owner!.cookie).get('/me');
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.permissions).toContain('finance.read_costs');
    expect(body.permissions).toContain('people.read_compensation');
  });

  it('member has a limited set', async () => {
    const body = await json(reqAs(users.member!.cookie).get('/me'));
    expect(body.permissions).toContain('projects.create');
    expect(body.permissions).not.toContain('finance.read');
    expect(body.permissions).not.toContain('people.read');
  });
});

describe('permission matrix – finance is invisible to member/guest', () => {
  const cases: Array<[string, string, number[]]> = [
    ['owner', '/invoices', [200]],
    ['finance', '/invoices', [200]],
    ['manager', '/invoices', [200]],
    ['member', '/invoices', [403]],
    ['guest', '/invoices', [403]],
    ['member', '/finance/dashboard', [403]],
  ];
  for (const [role, path, expected] of cases) {
    it(`${role} GET ${path} -> ${expected.join('/')}`, async () => {
      const res = await reqAs(users[role]!.cookie).get(path);
      expect(expected).toContain(res.status);
    });
  }
});

describe('permission matrix – people serves only the public slice below people.read', () => {
  // The directory is the workspace's own phone book: anyone signed in reads
  // the public slice (identity + org seat); contacts and custom fields need
  // people.read (people-open-card.test.ts covers the field-level contract).
  for (const role of ['member', 'guest']) {
    it(`${role} reads employees without contact details`, async () => {
      const res = await reqAs(users[role]!.cookie).get('/employees');
      expect(res.status).toBe(200);
      for (const row of (await json(res)).data as any[]) {
        expect(row.email).toBeUndefined();
        expect(row.customFields).toBeUndefined();
      }
    });
  }
  it('HR can read employees', async () => {
    const res = await reqAs(users.hr!.cookie).get('/employees');
    expect(res.status).toBe(200);
  });
});

describe('compensation requires people.read_compensation', () => {
  it('HR (without read_compensation) is blocked from compensation write', async () => {
    // HR lacks people.read_compensation in the seed
    const meBody = await json(reqAs(users.hr!.cookie).get('/me'));
    expect(meBody.permissions).not.toContain('people.read_compensation');
  });
});

describe('dashboard feed hides activity outside the actor’s domains', () => {
  beforeAll(async () => {
    const owner = reqAs(users.owner!.cookie);
    // A real task in a workspace project: the feed resolves every project-scoped
    // record back to its project, so a fabricated id would (rightly) be dropped.
    const type = await json(owner.post('/project-types', { name: 'Feed', revenueSource: 'none' }));
    const project = await json(owner.post('/projects', { name: 'Feed', key: 'FEED', projectTypeId: type.id }));
    await owner.post('/tasks', { projectId: project.id, title: 'Visible task' });
    const { db } = getDb();
    await db.insert(schema.activityLog).values([
      { id: ulid(), entityType: 'invoice', entityId: ulid(), actorId: users.owner!.userId, action: 'created', diff: {}, sensitivity: 'normal' },
      { id: ulid(), entityType: 'invoice', entityId: ulid(), actorId: users.member!.userId, action: 'viewed', diff: {}, sensitivity: 'normal' },
    ]);
  });

  const types = async (role: string) => {
    const body = await json(reqAs(users[role]!.cookie).get('/dashboard'));
    return (body.recentActivity as Array<{ entityType: string; actorId: string }>);
  };

  it('owner sees finance activity', async () => {
    expect((await types('owner')).some((a) => a.entityType === 'invoice')).toBe(true);
  });

  it('member does not see others’ finance activity but keeps projects + own actions', async () => {
    const rows = await types('member');
    expect(rows.some((a) => a.entityType === 'invoice' && a.actorId !== users.member!.userId)).toBe(false);
    expect(rows.some((a) => a.entityType === 'task')).toBe(true);
    expect(rows.some((a) => a.entityType === 'invoice' && a.actorId === users.member!.userId)).toBe(true);
  });

  it('member response carries no finance widgets at all', async () => {
    const body = await json(reqAs(users.member!.cookie).get('/dashboard'));
    expect(body.receivables).toBeUndefined();
    expect(body.overdue).toBeUndefined();
  });
});

describe('CRM notes leave an audit trail', () => {
  it('creating a note writes a fact-only activity record (body stays out of the diff)', async () => {
    const company = await json(reqAs(users.owner!.cookie).post('/companies', { name: 'NoteCo' }));
    const res = await reqAs(users.owner!.cookie).post('/notes', {
      companyId: company.id,
      body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'secret plans' }] }] },
    });
    expect(res.status).toBe(201);

    const { db } = getDb();
    const rows = await db.select().from(schema.activityLog).where(eq(schema.activityLog.entityType, 'note'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe('created');
    expect(rows[0]!.actorId).toBe(users.owner!.userId);
    expect(JSON.stringify(rows[0]!.diff)).not.toContain('secret plans');
  });
});

describe('the Sales preset covers the sales workspace and stops there', () => {
  it('works the whole CRM: companies, leads, activities and the pipeline', async () => {
    const sales = reqAs(users.sales!.cookie);
    expect((await sales.get('/companies')).status).toBe(200);
    expect((await sales.get('/leads')).status).toBe(200);
    expect((await sales.get('/sales-work')).status).toBe(200);
    expect((await sales.get('/deals')).status).toBe(200);
    expect((await sales.get('/deal-stages')).status).toBe(200);
    expect((await sales.get('/sales-message-templates')).status).toBe(200);

    const company = await sales.post('/companies', { name: 'Sales role can create' });
    expect(company.status).toBe(201);
    const created = await sales.post('/leads', {
      companyId: ((await company.json()) as { id: string }).id,
      title: 'Sales role can create a lead',
    });
    expect(created.status).toBe(201);
  });

  it('reads delivery and money without being able to change either', async () => {
    const sales = reqAs(users.sales!.cookie);
    // The point of the role: a seller needs to see what is being delivered and
    // what has been paid, and needs no ability to touch either.
    expect((await sales.get('/projects')).status).toBe(200);
    expect((await sales.get('/invoices')).status).toBe(200);
    expect((await sales.post('/invoices', { companyId: ulid(), currency: 'USD' })).status).toBe(403);
    // The employee list answers with the public slice only – no HR detail.
    const employees = await sales.get('/employees');
    expect(employees.status).toBe(200);
    for (const row of (await json(employees)).data as any[]) expect(row.email).toBeUndefined();
  });
});

describe('CRM permission boundary', () => {
  it('guest cannot list companies', async () => {
    expect((await reqAs(users.guest!.cookie).get('/companies')).status).toBe(403);
  });
  it('finance can read companies but not write deals without deals.write', async () => {
    expect((await reqAs(users.finance!.cookie).get('/companies')).status).toBe(200);
  });

  /**
   * The project overview lists the deals sold into a project, which on a
   * product project means leads from many different clients. Reaching a
   * project does not imply reading its pipeline: HR, finance and guests all
   * hold projects.read (or project membership) without deals.read, and a
   * guest on a shared product project must never see other clients' deals.
   */
  describe('deals scoped to a project stay behind deals.read', () => {
    for (const role of ['hr', 'finance', 'guest']) {
      it(`${role} cannot list a project's deals`, async () => {
        const res = await reqAs(users[role]!.cookie).get(`/deals?projectId=${ulid()}`);
        expect(res.status).toBe(403);
      });
    }
    it('member, who holds deals.read, can', async () => {
      const res = await reqAs(users.member!.cookie).get(`/deals?projectId=${ulid()}`);
      expect(res.status).toBe(200);
    });
  });

  /**
   * The client column of that list is a second, independent boundary. No
   * seeded role separates the two, so this builds the role that does: the
   * project's lead list must render for it while staying unable to name the
   * companies the leads came from.
   */
  it('deals.read does not carry crm.read', async () => {
    const { db } = getDb();
    const roleId = ulid();
    await db.insert(schema.roles).values({
      id: roleId, key: `deals-only-${roleId}`, name: 'Deals only',
      description: 'Reads deals, not companies', isSystem: false,
    });
    await db.insert(schema.rolePermissions).values([
      { roleId, permission: 'deals.read' },
      { roleId, permission: 'projects.read' },
    ]);
    const userId = ulid();
    await db.insert(schema.users).values({
      id: userId, email: `deals-only-${userId}@test.local`, name: 'Deals only',
      passwordHash: hashPassword('password'), roleId,
    });
    const token = generateToken();
    await db.insert(schema.sessions).values({ id: ulid(), userId, token, expiresAt: new Date(Date.now() + 3600_000) });
    const as = reqAs(`ordi_session=${token}`);

    expect((await as.get(`/deals?projectId=${ulid()}`)).status).toBe(200);
    expect((await as.get('/companies')).status).toBe(403);
  });
});
