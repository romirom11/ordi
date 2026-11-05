/**
 * Project secrets from Doppler (plan 2026-11-05-001, U5, R30-R38), against a
 * fake Doppler API on `fetch`.
 *
 * A workspace admin connects a service token and links projects to it.
 * People on a linked project add secrets by picking names; the values stay in
 * Doppler and are fetched for each reveal and each run, never stored. A
 * revoked token, a renamed secret or a removed connection shows on the secret
 * and leaves its metadata in place.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { getDb, schema, eq } from '@ordi/db';
import { resetDb, seedRolesAndUsers, reqAs, json } from './helpers';
import { forgetNames } from '../domains/secrets/providers';
import { resolveRunSecrets } from '../domains/secrets/service';

const TOKEN = 'dp.st.dev.GoodServiceToken0123456789';

/** The fake: one project/config, its secrets, and every request it received. */
const doppler = {
  revoked: false,
  secrets: {} as Record<string, string>,
  requests: [] as URL[],
  reset() {
    this.revoked = false;
    this.requests = [];
    this.secrets = {
      STRIPE_KEY: 'sk_test_from_doppler_1111',
      ACME_LOGIN: 'ops@acme.test',
      ACME_PASSWORD: 'd0ppler-Pa55word',
      UNRELATED: 'another-value-ordi-never-asks-for',
      DOPPLER_PROJECT: 'acme', DOPPLER_CONFIG: 'dev', DOPPLER_ENVIRONMENT: 'dev',
    };
  },
};

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.host !== 'api.doppler.com') throw new Error(`unexpected request to ${url.host}`);
  doppler.requests.push(url);
  const auth = new Headers(init?.headers).get('authorization');
  if (doppler.revoked || auth !== `Bearer ${TOKEN}`) return reply(401, { messages: ['Invalid Service token'], success: false });
  const project = url.searchParams.get('project');
  const config = url.searchParams.get('config');
  if ((project && project !== 'acme') || (config && config !== 'dev')) return reply(404, { messages: ['Could not find requested config'], success: false });

  if (url.pathname === '/v3/configs/config/secrets/names') {
    if (!project || !config) return reply(400, { messages: ['Missing project or config'], success: false });
    const managed = url.searchParams.get('include_managed_secrets') !== 'false';
    return reply(200, { names: Object.keys(doppler.secrets).filter((n) => managed || !n.startsWith('DOPPLER_')) });
  }
  if (url.pathname === '/v3/configs/config/secrets/download') {
    const wanted = url.searchParams.get('secrets')?.split(',') ?? Object.keys(doppler.secrets);
    const unknown = wanted.filter((n) => !(n in doppler.secrets));
    if (unknown.length) return reply(400, { messages: [`Secret not found: ${unknown[0]}`], success: false });
    return reply(200, Object.fromEntries(wanted.map((n) => [n, doppler.secrets[n]])));
  }
  return reply(404, { messages: ['Not found'], success: false });
}

const downloads = () => doppler.requests.filter((u) => u.pathname.endsWith('/download'));

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
let owner: ReturnType<typeof reqAs>;
let manager: ReturnType<typeof reqAs>;
let member: ReturnType<typeof reqAs>;
let projectId: string;
let otherProjectId: string;
let connectionId: string;

beforeAll(async () => {
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
  doppler.reset();
  await resetDb();
  users = await seedRolesAndUsers();
  owner = reqAs(users.owner!.cookie);
  manager = reqAs(users.manager!.cookie);
  member = reqAs(users.member!.cookie);
  const type = await json(owner.post('/project-types', { name: 'Delivery', revenueSource: 'none' }));
  projectId = (await json(owner.post('/projects', { name: 'Acme', key: 'ACM', projectTypeId: type.id }))).id;
  otherProjectId = (await json(owner.post('/projects', { name: 'Other', key: 'OTH', projectTypeId: type.id }))).id;
  for (const key of ['manager', 'member', 'agent'] as const) {
    await json(owner.post(`/projects/${projectId}/members`, { userId: users[key]!.userId, role: 'member', canWriteTasks: true }));
  }
  const { db } = getDb();
  await db.update(schema.users).set({ actorType: 'agent' }).where(eq(schema.users.id, users.agent!.userId));
});

afterAll(() => { vi.unstubAllGlobals(); });

beforeEach(() => { forgetNames(); doppler.requests = []; });

const addFromDoppler = (who: ReturnType<typeof reqAs>, body: Record<string, unknown>) => who.post(`/projects/${projectId}/secrets`, {
  environment: 'test', audience: [{ type: 'project' }], source: 'provider', connectionId, availableToAgents: true, ...body,
});
const reveal = (who: ReturnType<typeof reqAs>, id: string, field: string) => who.post(`/project-secrets/${id}/reveal`, { field });
const run = () => resolveRunSecrets({ id: 'run-1', projectId, agentUserId: users.agent!.userId, taskId: 'task-1', requestedBy: users.owner!.userId });

describe('connecting Doppler', () => {
  it('refuses a token Doppler refuses, and stores nothing', async () => {
    const res = await owner.post('/secret-providers', { kind: 'doppler', token: 'dp.st.dev.WrongToken000000' });
    expect(res.status).toBe(422);
    expect((await json(res)).error.message).toContain('Doppler refused the token');
    const { db } = getDb();
    expect(await db.select().from(schema.secretProviderConnections)).toHaveLength(0);
  });

  it('is for integrations.manage only', async () => {
    expect((await manager.post('/secret-providers', { kind: 'doppler', token: TOKEN })).status).toBe(403);
    expect((await member.get('/secret-providers')).status).toBe(403);
  });

  it('reads the project and config back from the token, and never returns or stores the token in the clear', async () => {
    const res = await owner.post('/secret-providers', { kind: 'doppler', token: TOKEN });
    expect(res.status).toBe(201);
    const conn = await json(res);
    connectionId = conn.id;
    expect(conn).toMatchObject({ kind: 'doppler', label: 'Doppler · acme/dev', project: 'acme', config: 'dev', status: 'ok' });
    // Detection asked for Doppler's own variables only, never the whole config.
    const detect = downloads()[0]!;
    expect(detect.searchParams.get('secrets')).toBe('DOPPLER_PROJECT,DOPPLER_CONFIG');

    const listed = JSON.stringify(await json(owner.get('/secret-providers')));
    expect(listed).not.toContain(TOKEN);
    const { db } = getDb();
    const [row] = await db.select().from(schema.secretProviderConnections);
    expect(row!.credentials).not.toContain(TOKEN);
    const audit = JSON.stringify(await db.select().from(schema.activityLog).where(eq(schema.activityLog.entityType, 'secret_provider_connection')));
    expect(audit).toContain('connected');
    expect(audit).not.toContain(TOKEN);
  });
});

describe('adding secrets from a linked connection', () => {
  it('offers nothing to a project that is not linked', async () => {
    expect((await json(manager.get(`/projects/${projectId}/secret-providers`))).data).toEqual([]);
    expect((await manager.get(`/projects/${projectId}/secret-providers/${connectionId}/names`)).status).toBe(422);
    expect((await addFromDoppler(manager, { name: 'STRIPE_TEST', fields: [{ key: 'api_key', label: 'Key', type: 'api_key', ref: 'STRIPE_KEY' }] })).status).toBe(422);
  });

  it('lists the names of a linked config – names only, without Doppler’s own – to those who may add secrets', async () => {
    const linked = await json(owner.put(`/secret-providers/${connectionId}/projects`, { projectIds: [projectId] }));
    expect(linked.projectIds).toEqual([projectId]);
    expect((await json(manager.get(`/projects/${projectId}/secret-providers`))).data).toMatchObject([{ id: connectionId, label: 'Doppler · acme/dev' }]);
    const { names } = await json(manager.get(`/projects/${projectId}/secret-providers/${connectionId}/names`));
    expect(names).toEqual(['ACME_LOGIN', 'ACME_PASSWORD', 'STRIPE_KEY', 'UNRELATED']);
    expect(downloads()).toHaveLength(0);
    // Listing a config's names is for those who may add secrets to the project.
    expect((await member.get(`/projects/${projectId}/secret-providers/${connectionId}/names`)).status).toBe(403);
  });

  it('refuses a name Doppler does not have, and a value', async () => {
    const unknown = await addFromDoppler(manager, { name: 'STRIPE_TEST', fields: [{ key: 'api_key', label: 'Key', type: 'api_key', ref: 'NOPE' }] });
    expect(unknown.status).toBe(400);
    expect((await json(unknown)).error.message).toContain('no secret named NOPE');
    const withValue = await addFromDoppler(manager, { name: 'STRIPE_TEST', fields: [{ key: 'api_key', label: 'Key', type: 'api_key', ref: 'STRIPE_KEY', value: 'x' }] });
    expect(withValue.status).toBe(400);
  });

  it('keeps a reference and no value: nothing of Doppler’s is stored', async () => {
    const res = await addFromDoppler(manager, { name: 'STRIPE_TEST', fields: [{ key: 'api_key', label: 'Secret key', type: 'api_key', ref: 'STRIPE_KEY' }] });
    expect(res.status).toBe(201);
    const secret = await json(res);
    expect(secret).toMatchObject({
      source: 'provider',
      fields: [{ key: 'api_key', label: 'Secret key', type: 'api_key', hasValue: true, ref: 'STRIPE_KEY' }],
      provider: { connectionId, kind: 'doppler', label: 'Doppler · acme/dev', state: 'ok', missing: [] },
    });
    const { db } = getDb();
    expect(await db.select().from(schema.projectSecretPayloads).where(eq(schema.projectSecretPayloads.secretId, secret.id))).toHaveLength(0);
    expect(downloads()).toHaveLength(0);
  });
});

describe('values come from Doppler at the moment they are needed', () => {
  let stripeId: string;
  let adminId: string;

  beforeAll(async () => {
    const { db } = getDb();
    stripeId = (await db.select().from(schema.projectSecrets).where(eq(schema.projectSecrets.name, 'STRIPE_TEST')))[0]!.id;
    const res = await addFromDoppler(manager, {
      name: 'ACME_ADMIN',
      fields: [
        { key: 'login', label: 'Login', type: 'text', ref: 'ACME_LOGIN' },
        { key: 'password', label: 'Password', type: 'password', ref: 'ACME_PASSWORD' },
      ],
    });
    expect(res.status).toBe(201);
    adminId = (await json(res)).id;
  });

  it('reveals by asking Doppler for that one name, every time', async () => {
    expect(await json(reveal(member, stripeId, 'api_key'))).toEqual({ field: 'api_key', value: 'sk_test_from_doppler_1111' });
    await json(reveal(member, stripeId, 'api_key'));
    expect(downloads()).toHaveLength(2);
    expect(downloads().every((u) => u.searchParams.get('secrets') === 'STRIPE_KEY')).toBe(true);
    // The trail notes it, without the value.
    const trail = JSON.stringify(await json(manager.get(`/project-secrets/${stripeId}/activity`)));
    expect(trail).toContain('revealed');
    expect(trail).not.toContain('sk_test_from_doppler_1111');
  });

  it('gets a rotated value with no action in ordi', async () => {
    doppler.secrets.STRIPE_KEY = 'sk_test_rotated_2222';
    expect((await json(reveal(member, stripeId, 'api_key'))).value).toBe('sk_test_rotated_2222');
  });

  it('gives a run every value in one request per connection, and only the names it uses', async () => {
    const resolved = await run();
    expect(Object.fromEntries(resolved.vars.map((v) => [v.variable, v.value]))).toEqual({
      SECRET_STRIPE_TEST: 'sk_test_rotated_2222',
      SECRET_ACME_ADMIN__LOGIN: 'ops@acme.test',
      SECRET_ACME_ADMIN__PASSWORD: 'd0ppler-Pa55word',
    });
    expect(resolved.used).toEqual(['ACME_ADMIN', 'STRIPE_TEST']);
    expect(downloads()).toHaveLength(1);
    expect(downloads()[0]!.searchParams.get('secrets')!.split(',').sort()).toEqual(['ACME_LOGIN', 'ACME_PASSWORD', 'STRIPE_KEY']);
  });

  it('shows a secret renamed in Doppler on the secret, refuses its reveal, and leaves only it out of a run', async () => {
    const { STRIPE_KEY, ...rest } = doppler.secrets;
    doppler.secrets = { ...rest, STRIPE_LIVE_KEY: STRIPE_KEY! };

    const secret = await json(member.get(`/project-secrets/${stripeId}`));
    expect(secret.provider).toMatchObject({ state: 'ok', missing: ['STRIPE_KEY'] });
    const res = await reveal(member, stripeId, 'api_key');
    expect(res.status).toBe(422);
    expect((await json(res)).error.message).toContain('no secret named STRIPE_KEY');

    const resolved = await run();
    expect(resolved.vars.map((v) => v.variable).sort()).toEqual(['SECRET_ACME_ADMIN__LOGIN', 'SECRET_ACME_ADMIN__PASSWORD']);
    expect(resolved.skipped).toContainEqual({ name: 'STRIPE_TEST', reason: 'the provider has no secret named STRIPE_KEY' });
  });

  it('is fixed by pointing the field at the new name', async () => {
    const current = await json(manager.get(`/project-secrets/${stripeId}`));
    const res = await manager.patch(`/project-secrets/${stripeId}`, {
      version: current.version, fields: [{ key: 'api_key', label: 'Secret key', type: 'api_key', ref: 'STRIPE_LIVE_KEY' }],
    });
    expect(res.status).toBe(200);
    expect((await json(res)).fields[0].ref).toBe('STRIPE_LIVE_KEY');
    expect((await json(reveal(member, stripeId, 'api_key'))).value).toBe('sk_test_rotated_2222');
  });

  it('marks a revoked token on the connection and its secrets, keeps their metadata, and a run still starts without them', async () => {
    doppler.revoked = true;
    const res = await reveal(member, adminId, 'password');
    expect(res.status).toBe(422);
    expect((await json(res)).error.message).toContain('Doppler refused the token');

    const [conn] = (await json(owner.get('/secret-providers'))).data;
    expect(conn).toMatchObject({ status: 'error', lastError: expect.stringContaining('Doppler refused the token') });
    const listed = (await json(member.get(`/projects/${projectId}/secrets`))).data as any[];
    expect(listed.map((s) => [s.name, s.provider.state])).toEqual([['ACME_ADMIN', 'error'], ['STRIPE_TEST', 'error']]);

    const resolved = await run();
    expect(resolved.vars).toEqual([]);
    expect(resolved.skipped.map((s) => s.name).sort()).toEqual(['ACME_ADMIN', 'STRIPE_TEST']);
    expect(resolved.skipped[0]!.reason).toContain('Doppler refused the token');

    // Recovers on its own once Doppler answers again.
    doppler.revoked = false;
    expect((await reveal(member, adminId, 'password')).status).toBe(200);
    expect((await json(owner.get('/secret-providers'))).data[0].status).toBe('ok');
  });

  it('a new token is verified before it replaces the old one', async () => {
    const bad = await owner.patch(`/secret-providers/${connectionId}`, { token: 'dp.st.dev.WrongToken000000' });
    expect(bad.status).toBe(422);
    const good = await owner.patch(`/secret-providers/${connectionId}`, { token: TOKEN, label: 'Acme dev' });
    expect(good.status).toBe(200);
    expect(await json(good)).toMatchObject({ label: 'Acme dev', project: 'acme', config: 'dev', status: 'ok' });
  });
});

describe('unlinking and removing', () => {
  it('a project unlinked from the connection keeps its secrets, disconnected', async () => {
    await json(owner.put(`/secret-providers/${connectionId}/projects`, { projectIds: [otherProjectId] }));
    const listed = (await json(member.get(`/projects/${projectId}/secrets`))).data as any[];
    expect(listed.every((s) => s.provider.state === 'disconnected')).toBe(true);
    const { db } = getDb();
    const [stripe] = await db.select().from(schema.projectSecrets).where(eq(schema.projectSecrets.name, 'STRIPE_TEST'));
    expect((await reveal(member, stripe!.id, 'api_key')).status).toBe(422);
    const resolved = await run();
    expect(resolved.vars).toEqual([]);
    expect(resolved.skipped).toContainEqual({ name: 'STRIPE_TEST', reason: 'its provider connection was removed or unlinked' });
    expect(downloads()).toHaveLength(0);
    await json(owner.put(`/secret-providers/${connectionId}/projects`, { projectIds: [projectId] }));
  });

  it('removing the connection keeps the secrets with their names and fields, marked disconnected', async () => {
    expect((await owner.del(`/secret-providers/${connectionId}`)).status).toBe(200);
    const listed = (await json(member.get(`/projects/${projectId}/secrets`))).data as any[];
    expect(listed.map((s) => s.name)).toEqual(['ACME_ADMIN', 'STRIPE_TEST']);
    expect(listed[0]).toMatchObject({
      source: 'provider',
      fields: [{ key: 'login', ref: 'ACME_LOGIN' }, { key: 'password', ref: 'ACME_PASSWORD' }],
      provider: { connectionId: null, state: 'disconnected', error: 'The connection was removed' },
    });
    expect((await reveal(member, listed[0].id, 'password')).status).toBe(422);
    // They can still be deleted by those who may write them.
    expect((await manager.del(`/project-secrets/${listed[0].id}`)).status).toBe(200);
  });
});
