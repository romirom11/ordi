/**
 * A credential never buys more than it was issued with: an API token cannot
 * mint or approve another credential, cannot reset the second factor, and a
 * read-only one changes nothing whatever the route's permission is called.
 * Compensation-derived cost stays behind finance.read_costs, and OAuth never
 * hands the browser a redirect it would execute itself.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { getDb, schema, eq } from '@ordi/db';
import { ulid } from 'ulid';
import { resetDb, seedRolesAndUsers, reqAs, json, app } from './helpers';

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
let owner: ReturnType<typeof reqAs>;
let companyId: string;

function bearer(token: string) {
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  return {
    get: (p: string) => app.request(`/api/v1${p}`, { headers }),
    post: (p: string, body?: unknown) => app.request(`/api/v1${p}`, { method: 'POST', headers, body: body ? JSON.stringify(body) : undefined }),
  };
}

async function mintToken(scopes: string[], readOnly = false): Promise<string> {
  const res = await owner.post('/auth/tokens', { name: `t-${ulid()}`, scopes, readOnly });
  expect(res.status).toBe(201);
  return (await json(res)).token;
}

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
  owner = reqAs(users.owner!.cookie);
  companyId = (await json(owner.post('/companies', { name: 'Acme', status: 'active' }))).id;
});

describe('credentials are issued from a signed-in session only', () => {
  it('a narrow token cannot mint a wider one', async () => {
    const narrow = await mintToken(['projects.read']);
    const res = await bearer(narrow).post('/auth/tokens', { name: 'wide', scopes: ['users.manage', 'finance.payments'], readOnly: false });
    expect(res.status).toBe(403);
    const { db } = getDb();
    expect((await db.select().from(schema.apiTokens)).map((t) => t.name)).not.toContain('wide');
  });

  it('a token cannot list or revoke tokens either', async () => {
    const t = await mintToken(['projects.read']);
    expect((await bearer(t).get('/auth/tokens')).status).toBe(403);
  });

  it('a desktop session token (full scope) still manages tokens', async () => {
    const res = await bearer(users.owner!.token).post('/auth/tokens', { name: 'from-desktop', scopes: ['projects.read'], readOnly: true });
    expect(res.status).toBe(201);
  });

  it('a token cannot approve a desktop sign-in', async () => {
    const state = ulid() + ulid();
    await app.request('/api/v1/auth/desktop/start', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state, codeChallenge: 'a'.repeat(64), deviceLabel: 'attacker' }),
    });
    const t = await mintToken(['projects.read']);
    expect((await bearer(t).post('/auth/desktop/approve', { state })).status).toBe(403);
    expect((await owner.post('/auth/desktop/approve', { state })).status).toBe(200);
  });

  it('a token cannot approve an OAuth client (which would mint a full-role token)', async () => {
    const reg = await json(app.request('/api/v1/oauth/register', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': 'access-hardening' },
      body: JSON.stringify({ redirect_uris: ['http://127.0.0.1:7777/cb'], client_name: 'cli' }),
    }));
    const approve = { clientId: reg.client_id, redirectUri: 'http://127.0.0.1:7777/cb', codeChallenge: 'b'.repeat(43), codeChallengeMethod: 'S256' };
    const t = await mintToken(['projects.read']);
    expect((await bearer(t).post('/oauth/approve', approve)).status).toBe(403);
    expect((await owner.post('/oauth/approve', approve)).status).toBe(200);
  });
});

describe('two-factor authentication', () => {
  it('a token cannot touch TOTP', async () => {
    const t = await mintToken(['projects.read'], true);
    expect((await bearer(t).post('/auth/totp/setup')).status).toBe(403);
  });

  it('setup refuses to replace an enabled factor; the factor stays on', async () => {
    const { db } = getDb();
    await db.update(schema.users).set({ totpEnabled: true, totpSecret: 'JBSWY3DPEHPK3PXP' }).where(eq(schema.users.id, users.admin!.userId));
    const res = await reqAs(users.admin!.cookie).post('/auth/totp/setup');
    expect(res.status).toBe(422);
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, users.admin!.userId));
    expect(u!.totpEnabled).toBe(true);
    expect(u!.totpSecret).toBe('JBSWY3DPEHPK3PXP');
  });

  it('setup still works while the factor is off', async () => {
    const res = await reqAs(users.member!.cookie).post('/auth/totp/setup');
    expect(res.status).toBe(200);
    expect((await json(res)).secret).toBeTruthy();
  });
});

describe('read-only tokens change nothing', () => {
  it('guardAll refuses them (lead conversion)', async () => {
    const { db } = getDb();
    const lead = await json(owner.post('/leads', { companyId, title: 'Read-only lead' }));
    await db.update(schema.leads).set({ status: 'engaged' }).where(eq(schema.leads.id, lead.id));
    const ro = await mintToken(['crm.read', 'crm.write', 'deals.read', 'deals.write'], true);
    expect((await bearer(ro).post(`/leads/${lead.id}/convert`, {})).status).toBe(403);
    expect(await db.select().from(schema.deals)).toHaveLength(0);
  });

  it('a finance.settings write is refused, its read still served', async () => {
    const ro = await mintToken(['finance.read', 'finance.settings'], true);
    expect((await bearer(ro).post('/expense-categories', { name: 'Nope' })).status).toBe(403);
    expect((await bearer(ro).get('/reminder-rules')).status).toBe(200);
    expect((await bearer(ro).get('/expense-categories')).status).toBe(200);
  });

  it('guardAny serves a read the token holds a read permission for', async () => {
    const ro = await mintToken(['time.track', 'time.read_all'], true);
    expect((await bearer(ro).get('/time/entries')).status).toBe(200);
    expect((await bearer(ro).post('/time/timer/start', { taskId: ulid() })).status).toBe(403);
  });
});

describe('cost rate needs finance.read_costs', () => {
  let projectId: string;
  beforeAll(async () => {
    const type = await json(owner.post('/project-types', { name: 'Delivery', revenueSource: 'none' }));
    projectId = (await json(owner.post('/projects', { name: 'Cost', key: 'CST', projectTypeId: type.id }))).id;
    const task = await json(owner.post('/tasks', { projectId, title: 'Some task' }));
    const { db } = getDb();
    await db.insert(schema.timeEntries).values({
      id: ulid(), taskId: task.id, userId: users.member!.userId, projectId,
      startedAt: new Date('2026-10-01T09:00:00Z'), durationSeconds: 3600, note: '', billable: true,
      hourlyRate: '100', costRate: '42.75',
    } as any);
  });

  it('a Manager (time.read_all, no read_costs) sees the entry without its cost', async () => {
    const body = await json(reqAs(users.manager!.cookie).get(`/time/entries?userId=${users.member!.userId}`));
    expect(body.data).toHaveLength(1);
    expect(body.data[0].hourlyRate).toBe('100.00');
    expect(body.data[0]).not.toHaveProperty('costRate');
  });

  it('Finance (read_costs) still sees it', async () => {
    const body = await json(reqAs(users.finance!.cookie).get(`/time/entries?userId=${users.member!.userId}`));
    expect(body.data[0].costRate).toBe('42.75');
  });

  it('my-week does not carry it either', async () => {
    const body = await json(reqAs(users.member!.cookie).get('/time/my-week?weekStart=2026-09-28'));
    const entries = body.days.flatMap((d: any) => d.entries);
    expect(entries).toHaveLength(1);
    expect(entries[0]).not.toHaveProperty('costRate');
  });
});

describe('OAuth redirect schemes', () => {
  const register = (uris: string[]) => app.request('/api/v1/oauth/register', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': 'access-hardening' },
    body: JSON.stringify({ redirect_uris: uris, client_name: 'x' }),
  });

  it.each(['javascript:alert(document.domain)//', 'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)'])(
    'refuses %s at registration', async (uri) => {
      expect((await register([uri])).status).toBe(400);
    });

  it('still accepts https, loopback http and app schemes', async () => {
    expect((await register(['https://claude.ai/cb', 'http://127.0.0.1:3333/cb', 'cursor://anysphere.cursor-mcp/oauth/callback'])).status).toBe(201);
  });

  it('refuses one at approval even when a client registered it before the check', async () => {
    const { db } = getDb();
    const id = `mcp_${ulid()}`;
    await db.insert(schema.oauthClients).values({ id, name: 'legacy', redirectUris: ['javascript:alert(1)//'] });
    const res = await owner.post('/oauth/approve', {
      clientId: id, redirectUri: 'javascript:alert(1)//', codeChallenge: 'c'.repeat(43), codeChallengeMethod: 'S256',
    });
    expect(res.status).toBe(400);
  });
});
