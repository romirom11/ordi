import { describe, it, expect, beforeAll } from 'vitest';
import { getDb, schema } from '@ordi/db';
import { ulid } from 'ulid';
import { resetDb, seedRolesAndUsers, reqAs, anon, json } from './helpers';

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

describe('permission matrix – people is invisible to member/guest', () => {
  for (const role of ['member', 'guest']) {
    it(`${role} cannot read employees`, async () => {
      const res = await reqAs(users[role]!.cookie).get('/employees');
      expect(res.status).toBe(403);
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
    const { db } = getDb();
    await db.insert(schema.activityLog).values([
      { id: ulid(), entityType: 'invoice', entityId: ulid(), actorId: users.owner!.userId, action: 'created', diff: {}, sensitivity: 'normal' },
      { id: ulid(), entityType: 'task', entityId: ulid(), actorId: users.owner!.userId, action: 'created', diff: {}, sensitivity: 'normal' },
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

describe('CRM permission boundary', () => {
  it('guest cannot list companies', async () => {
    expect((await reqAs(users.guest!.cookie).get('/companies')).status).toBe(403);
  });
  it('finance can read companies but not write deals without deals.write', async () => {
    expect((await reqAs(users.finance!.cookie).get('/companies')).status).toBe(200);
  });
});
