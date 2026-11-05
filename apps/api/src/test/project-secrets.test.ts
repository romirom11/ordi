/**
 * Project secrets (plan 2026-11-05-001, U1).
 *
 * Access is three layers that must all agree – the workspace role
 * (secrets.*), the project role, and the secret's own audience – and a value
 * leaves the server only through the reveal endpoint, logged, never through
 * a list, a get, the resources list or the activity trail.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { getDb, schema, eq } from '@ordi/db';
import { ulid } from 'ulid';
import { resetDb, seedRolesAndUsers, reqAs, json, app } from './helpers';
import { runSecretExpiry } from '../domains/secrets/service';

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
let owner: ReturnType<typeof reqAs>;
let manager: ReturnType<typeof reqAs>;
let member: ReturnType<typeof reqAs>;
let projectId: string;
let engineering: string;
let frontend: string;

const PASSWORD = 'pa55-Very-Secret-Value';
const API_KEY = 'sk_test_51NnAbCdEfGhIjKl9z8Y';

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
  owner = reqAs(users.owner!.cookie);
  manager = reqAs(users.manager!.cookie);
  member = reqAs(users.member!.cookie);
  const type = await json(owner.post('/project-types', { name: 'Delivery', revenueSource: 'none' }));
  projectId = (await json(owner.post('/projects', { name: 'Acme', key: 'ACM', projectTypeId: type.id }))).id;
  for (const key of ['member', 'guest', 'agent'] as const) {
    await json(owner.post(`/projects/${projectId}/members`, { userId: users[key]!.userId, role: 'member', canWriteTasks: true }));
  }

  // Engineering > Frontend; the manager works in Frontend, the member has no employee record.
  const { db } = getDb();
  engineering = ulid();
  frontend = ulid();
  await db.insert(schema.departments).values([
    { id: engineering, name: 'Engineering' },
    { id: frontend, name: 'Frontend', parentId: engineering },
  ]);
  await db.insert(schema.employees).values({ id: ulid(), userId: users.manager!.userId, firstName: 'Manager', departmentId: frontend });
  // The seed gives every role a person; a real agent is an agent user.
  await db.update(schema.users).set({ actorType: 'agent' }).where(eq(schema.users.id, users.agent!.userId));
});

const create = (who: ReturnType<typeof reqAs>, body: Record<string, unknown>) => who.post(`/projects/${projectId}/secrets`, {
  environment: 'test',
  audience: [{ type: 'project' }],
  fields: [
    { key: 'login', label: 'Login', type: 'text', value: 'admin@acme.test' },
    { key: 'password', label: 'Password', type: 'password', value: PASSWORD },
    { key: 'url', label: 'URL', type: 'url', value: 'https://admin.acme.test' },
  ],
  ...body,
});
const reveal = (who: ReturnType<typeof reqAs>, id: string, field: string, purpose = 'reveal') =>
  who.post(`/project-secrets/${id}/reveal`, { field, purpose });
const listNames = async (who: ReturnType<typeof reqAs>) =>
  ((await json(who.get(`/projects/${projectId}/secrets`))).data as any[]).map((s) => s.name);
const resourceNames = async (who: ReturnType<typeof reqAs>) =>
  ((await json(who.get(`/projects/${projectId}/resources`))).data as any[]).filter((r) => r.kind === 'secret').map((r) => r.label);

describe('a project-wide secret', () => {
  let id: string;

  beforeAll(async () => {
    const res = await create(manager, { name: 'ACME_ADMIN', description: 'Client admin panel' });
    expect(res.status).toBe(201);
    id = (await json(res)).id;
  });

  it('lists metadata, shows url and text, and never a secret value', async () => {
    const secret = await json(member.get(`/project-secrets/${id}`));
    expect(secret.fields).toEqual([
      { key: 'login', label: 'Login', type: 'text', hasValue: true, value: 'admin@acme.test' },
      { key: 'password', label: 'Password', type: 'password', hasValue: true },
      { key: 'url', label: 'URL', type: 'url', hasValue: true, value: 'https://admin.acme.test' },
    ]);
    expect(secret.access).toEqual({ reveal: true, write: false, manage: false });
    for (const path of [`/project-secrets/${id}`, `/projects/${projectId}/secrets`, `/projects/${projectId}/resources`]) {
      const body = JSON.stringify(await json(owner.get(path)));
      expect(body).not.toContain(PASSWORD);
    }
    expect(await resourceNames(member)).toContain('ACME_ADMIN');
  });

  it('reveals one field to a member, without caching, and logs it without the value', async () => {
    const res = await reveal(member, id, 'password', 'copy');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await json(res)).toEqual({ field: 'password', value: PASSWORD });

    const trail = (await json(manager.get(`/project-secrets/${id}/activity`))).data as any[];
    const copied = trail.find((a) => a.action === 'copied');
    expect(copied).toMatchObject({ actorId: users.member!.userId, sensitivity: 'sensitive', diff: { field: { to: 'password' } } });
    expect(JSON.stringify(trail)).not.toContain(PASSWORD);
    const after = await json(owner.get(`/project-secrets/${id}`));
    expect(after.lastRevealedBy).toBe(users.member!.userId);
    // Revealing is not an edit: whoever is editing the secret keeps their version.
    expect(after.version).toBe(1);
  });

  it('is announced in the project activity by name only', async () => {
    const audit = JSON.stringify(await json(member.get(`/audit/entity/project/${projectId}`)));
    expect(audit).toContain('ACME_ADMIN');
    expect(audit).not.toContain(PASSWORD);
  });

  it('keeps out roles without secrets permissions, even on the project', async () => {
    const guest = reqAs(users.guest!.cookie);
    expect(await listNames(guest)).toEqual([]);
    expect((await guest.get(`/project-secrets/${id}`)).status).toBe(404);
    expect((await reveal(guest, id, 'password')).status).toBe(404);
    // An agent reaches values only through its runs, never the API.
    expect((await reveal(reqAs(users.agent!.cookie), id, 'password')).status).toBe(404);
  });

  it('refuses a reveal over an API token', async () => {
    const minted = await json(member.post('/auth/tokens', { name: 'mcp', scopes: ['projects.read', 'secrets.read', 'secrets.reveal'] }));
    const res = await app.request(`/api/v1/project-secrets/${id}/reveal`, {
      method: 'POST',
      headers: { authorization: `Bearer ${minted.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ field: 'password' }),
    });
    expect(res.status).toBe(403);
  });
});

describe('tokens and general feeds', () => {
  it('refuses writes over a read-only token', async () => {
    const minted = await json(owner.post('/auth/tokens', { name: 'ro', scopes: ['projects.read', 'secrets.read', 'secrets.write'], readOnly: true }));
    const res = await app.request(`/api/v1/projects/${projectId}/secrets`, {
      method: 'POST',
      headers: { authorization: `Bearer ${minted.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'READ_ONLY_WRITE', environment: 'test', audience: [{ type: 'project' }], fields: [{ key: 'v', label: 'V', type: 'password', value: 'x' }] }),
    });
    expect(res.status).toBe(403);
  });

  it('keeps secret trails out of the audit log and the home feed, even for audit.read', async () => {
    const { id } = await json(create(owner, { name: 'HIDDEN_TRAIL', audience: [{ type: 'user', id: users.owner!.userId }] }));
    await reveal(owner, id, 'password');
    const audit = await json(owner.get('/audit'));
    expect((audit.data as any[]).some((a) => a.entityType === 'project_secret')).toBe(false);
    expect(JSON.stringify(audit)).not.toContain('HIDDEN_TRAIL');
    expect((await json(owner.get(`/audit/entity/project_secret/${id}`))).data).toEqual([]);
    expect(JSON.stringify(await json(owner.get('/dashboard')))).not.toContain('HIDDEN_TRAIL');
    // The secret itself still answers for its trail.
    expect(((await json(owner.get(`/project-secrets/${id}/activity`))).data as any[]).length).toBeGreaterThan(0);
  });
});

describe('the project role', () => {
  it('lets a viewer list but not reveal', async () => {
    const type = await json(owner.post('/project-types', { name: 'Private', revenueSource: 'none' }));
    const priv = (await json(owner.post('/projects', { name: 'Hidden', key: 'HID', projectTypeId: type.id, visibility: 'private' }))).id;
    await json(owner.post(`/projects/${priv}/members`, { userId: users.member!.userId, role: 'viewer', canWriteTasks: false }));
    const { id } = await json(owner.post(`/projects/${priv}/secrets`, {
      name: 'VIEWER_TEST', environment: 'test', audience: [{ type: 'project' }],
      fields: [{ key: 'password', label: 'Password', type: 'password', value: 'x-1234567890' }],
    }));
    expect((await json(member.get(`/project-secrets/${id}`))).access.reveal).toBe(false);
    expect((await reveal(member, id, 'password')).status).toBe(403);
    // Someone not on the private project does not learn it exists.
    expect((await reqAs(users.manager!.cookie).get(`/project-secrets/${id}`)).status).toBe(404);
  });
});

describe('a restricted audience', () => {
  it('hides a secret shared with named people from everyone else, title included', async () => {
    const { id } = await json(create(owner, {
      name: 'PROD_ROOT', environment: 'production',
      audience: [{ type: 'user', id: users.owner!.userId }, { type: 'user', id: users.manager!.userId }],
    }));
    expect(await listNames(manager)).toContain('PROD_ROOT');
    expect((await reveal(manager, id, 'password')).status).toBe(200);

    expect(await listNames(member)).not.toContain('PROD_ROOT');
    expect(await resourceNames(member)).not.toContain('PROD_ROOT');
    expect((await member.get(`/project-secrets/${id}`)).status).toBe(404);
    expect(JSON.stringify(await json(member.get(`/audit/entity/project/${projectId}`)))).not.toContain('PROD_ROOT');
    // An admin of every workspace project (projects.write) is still outside the audience.
    expect((await reqAs(users.admin!.cookie).get(`/project-secrets/${id}`)).status).toBe(404);
  });

  it('matches a department and its sub-departments, and nobody without an employee record', async () => {
    const { id } = await json(create(owner, {
      name: 'ENG_STAGING', environment: 'staging',
      audience: [{ type: 'user', id: users.owner!.userId }, { type: 'department', id: engineering }],
    }));
    expect((await reveal(manager, id, 'password')).status).toBe(200);
    expect((await member.get(`/project-secrets/${id}`)).status).toBe(404);
  });

  it('refuses an audience that leaves out the person saving it, or names nobody real', async () => {
    const res = await create(manager, { name: 'NOT_MINE', audience: [{ type: 'user', id: users.member!.userId }] });
    expect(res.status).toBe(422);
    expect((await create(manager, { name: 'GHOSTS', audience: [{ type: 'user', id: ulid() }] })).status).toBe(400);
    expect((await create(manager, { name: 'NOBODY', audience: [] })).status).toBe(400);
  });
});

describe('secrets.manage', () => {
  it('governs a secret it is not in the audience of, without seeing values, and the creator hears of it', async () => {
    const { id } = await json(create(manager, { name: 'LEAD_ONLY', audience: [{ type: 'user', id: users.manager!.userId }] }));
    // The Owner holds secrets.manage but is not in this audience.
    const seen = await json(owner.get(`/project-secrets/${id}`));
    expect(seen.access).toEqual({ reveal: false, write: false, manage: true });
    expect((await reveal(owner, id, 'password')).status).toBe(403);

    const patched = await owner.patch(`/project-secrets/${id}`, {
      audience: [{ type: 'user', id: users.manager!.userId }, { type: 'user', id: users.owner!.userId }],
    });
    expect(patched.status).toBe(200);
    expect((await reveal(owner, id, 'password')).status).toBe(200);

    const trail = (await json(manager.get(`/project-secrets/${id}/activity`))).data as any[];
    expect(trail.map((a) => a.action)).toContain('access_overridden');
    const { db } = getDb();
    const notes = await db.select().from(schema.notifications).where(eq(schema.notifications.userId, users.manager!.userId));
    expect(notes.some((n) => n.type === 'secret.access_overridden' && n.entityRef === `project_secret:${id}`)).toBe(true);
  });
});

describe('choosing an audience', () => {
  it('offers the people who work on the project and every department', async () => {
    const options = await json(manager.get(`/projects/${projectId}/secret-audience`));
    const names = (options.people as any[]).map((p) => p.id);
    expect(names).toContain(users.member!.userId);
    expect(names).not.toContain(users.agent!.userId);
    expect((options.departments as any[]).map((d) => d.name)).toEqual(expect.arrayContaining(['Engineering', 'Frontend']));
    expect((await reqAs(users.guest!.cookie).get(`/projects/${projectId}/secret-audience`)).status).toBe(403);
  });

  it('previews who really gets in, with all three layers applied', async () => {
    const preview = async (audience: unknown[]) =>
      ((await json(manager.post(`/projects/${projectId}/secret-audience/preview`, { audience }))).canReveal as any[]).map((p) => p.id);
    const whole = await preview([{ type: 'project' }]);
    expect(whole).toEqual(expect.arrayContaining([users.member!.userId, users.manager!.userId, users.owner!.userId]));
    // On the project, but the Guest role holds no secrets permissions.
    expect(whole).not.toContain(users.guest!.userId);
    const dept = await preview([{ type: 'department', id: engineering }]);
    expect(dept).toEqual([users.manager!.userId]);
  });
});

describe('editing', () => {
  it('keeps a value the edit leaves out, replaces one it sets, and drops removed fields', async () => {
    const { id, version } = await json(create(manager, {
      name: 'STRIPE_TEST',
      fields: [
        { key: 'api_key', label: 'API key', type: 'api_key', value: API_KEY },
        { key: 'webhook_secret', label: 'Webhook secret', type: 'password', value: 'whsec_old_value' },
      ],
    }));
    const updated = await json(manager.patch(`/project-secrets/${id}`, {
      version,
      fields: [
        { key: 'api_key', label: 'Secret key', type: 'api_key' },
        { key: 'publishable', label: 'Publishable key', type: 'text', value: 'pk_test_123' },
      ],
    }));
    expect(updated.fields).toEqual([
      { key: 'api_key', label: 'Secret key', type: 'api_key', hasValue: true, hint: API_KEY.slice(-4) },
      { key: 'publishable', label: 'Publishable key', type: 'text', hasValue: true, value: 'pk_test_123' },
    ]);
    expect((await json(reveal(manager, id, 'api_key'))).value).toBe(API_KEY);
    expect((await reveal(manager, id, 'webhook_secret')).status).toBe(404);
    // A stale version is refused.
    expect((await manager.patch(`/project-secrets/${id}`, { version, description: 'late' })).status).toBe(409);
  });

  it('needs secrets.write for content and refuses names that clash', async () => {
    const { id } = await json(create(manager, { name: 'MEMBER_CANNOT_EDIT' }));
    expect((await member.patch(`/project-secrets/${id}`, { description: 'x' })).status).toBe(403);
    expect((await create(member, { name: 'MEMBER_CANNOT_ADD' })).status).toBe(403);
    expect((await create(manager, { name: 'MEMBER_CANNOT_EDIT' })).status).toBe(422);
    expect((await create(manager, { name: 'ANTHROPIC_API_KEY' })).status).toBe(400);
    expect((await create(manager, { name: 'lower_case' })).status).toBe(400);
  });

  it('leaves agent use of a production secret to secrets.manage', async () => {
    const { id } = await json(create(manager, { name: 'AGENT_KEY', availableToAgents: true }));
    // Moving it to production switches agent use off ...
    const prod = await json(manager.patch(`/project-secrets/${id}`, { environment: 'production' }));
    expect(prod.availableToAgents).toBe(false);
    // ... and only a manager may switch it back on.
    expect((await manager.patch(`/project-secrets/${id}`, { availableToAgents: true })).status).toBe(403);
    expect((await create(manager, { name: 'PROD_AGENT', environment: 'production', availableToAgents: true })).status).toBe(403);
    await owner.patch(`/project-secrets/${id}`, { audience: [{ type: 'project' }] });
    expect((await json(owner.patch(`/project-secrets/${id}`, { availableToAgents: true }))).availableToAgents).toBe(true);
  });

  it('refuses an audience change that would lock the editor out', async () => {
    const { id } = await json(create(manager, { name: 'SELF_LOCK' }));
    expect((await manager.patch(`/project-secrets/${id}`, { audience: [{ type: 'user', id: users.member!.userId }] })).status).toBe(422);
  });
});

describe('deleting and limits', () => {
  it('deletes through the resources list too, payload and all', async () => {
    const { id } = await json(create(manager, { name: 'TEMP_ACCESS' }));
    const row = ((await json(manager.get(`/projects/${projectId}/resources`))).data as any[]).find((r) => r.secret?.id === id);
    // A member who may reveal but not write cannot delete it from the list.
    expect((await member.del(`/project-resources/${row.id}`)).status).toBe(403);
    expect((await manager.del(`/project-resources/${row.id}`)).status).toBe(200);
    const { db } = getDb();
    expect(await db.select().from(schema.projectSecretPayloads).where(eq(schema.projectSecretPayloads.secretId, id))).toEqual([]);
    expect((await manager.get(`/project-secrets/${id}`)).status).toBe(404);
  });

  it('rate-limits reveals per person', async () => {
    const { id } = await json(create(manager, { name: 'RATE_LIMITED' }));
    let last = 200;
    for (let i = 0; i < 40 && last === 200; i++) last = (await reveal(owner, id, 'password')).status;
    expect(last).toBe(429);
  });
});

describe('expiry reminders', () => {
  it('reminds the creator and project admins it is open to, two weeks ahead and on the day, once', async () => {
    const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
    const soon = await json(create(manager, { name: 'TRIAL_KEY', expiresAt: day(14) }));
    const hidden = await json(create(owner, { name: 'HIDDEN_EXPIRY', expiresAt: day(0), audience: [{ type: 'user', id: users.owner!.userId }] }));
    // `member` is a project admin here, so it would be told – but not about a secret it cannot see.
    await json(owner.post(`/projects/${projectId}/members`, { userId: users.member!.userId, role: 'admin', canWriteTasks: true }));

    const first = await runSecretExpiry();
    expect(first.notified).toBeGreaterThan(0);
    expect((await runSecretExpiry()).notified).toBe(0);

    const { db } = getDb();
    const notes = await db.select().from(schema.notifications);
    const about = (secretId: string) => notes.filter((n) => n.entityRef === `project_secret:${secretId}`);
    expect(about(soon.id).map((n) => n.type)).toContain('secret.expiring');
    expect(about(soon.id).map((n) => n.userId)).toEqual(expect.arrayContaining([users.manager!.userId, users.member!.userId]));
    expect(about(hidden.id).map((n) => n.userId)).toEqual([users.owner!.userId]);
    expect(about(hidden.id)[0]!.type).toBe('secret.expired');
    await json(owner.post(`/projects/${projectId}/members`, { userId: users.member!.userId, role: 'member', canWriteTasks: true }));
  });
});
