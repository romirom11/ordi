/**
 * GitHub App integration: the manifest flow hands us the app credentials, an
 * `installation` webhook creates the connection and syncs repos with no manual
 * step, and regular push deliveries signed with the app-level secret drive the
 * same task-linking pipeline as legacy per-connection webhooks.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { generateKeyPairSync, createVerify, createHmac } from 'node:crypto';
import { getDb, schema, eq } from '@ordi/db';
import { app, resetDb, seedRolesAndUsers, reqAs, json } from './helpers';
import { buildAppJwt, githubAppSetupUrl, githubAppWebhookUrl } from '../domains/integrations/github-app';
import { normalizeApiUrl } from '../env';
import { storeGithubAppConfig, invalidateRuntimeConfig } from '../lib/runtime-config';

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;

const { privateKey: PEM, publicKey: PUB } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const APP = {
  appId: '4242',
  slug: 'ordi-test-app',
  privateKey: PEM as string,
  webhookSecret: 'app-hook-secret',
  htmlUrl: 'https://github.com/apps/ordi-test-app',
};

function signAppDelivery(body: string): string {
  return `sha256=${createHmac('sha256', APP.webhookSecret).update(body).digest('hex')}`;
}

function delivery(event: string, payload: unknown, id: string) {
  const body = JSON.stringify(payload);
  return app.request('/api/v1/integrations/git/github/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': event,
      'x-github-delivery': id,
      'x-hub-signature-256': signAppDelivery(body),
    },
    body,
  });
}

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
  await storeGithubAppConfig(APP);
});

afterEach(() => {
  vi.unstubAllGlobals();
  invalidateRuntimeConfig();
});

describe('app JWT', () => {
  it('is a valid RS256 token with the app id as issuer', () => {
    const jwt = buildAppJwt(APP.appId, APP.privateKey, 1_700_000_000_000);
    const [header, payload, signature] = jwt.split('.');
    expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString());
    expect(claims.iss).toBe(APP.appId);
    expect(claims.exp - claims.iat).toBe(600);
    const ok = createVerify('RSA-SHA256')
      .update(`${header}.${payload}`)
      .verify(PUB, Buffer.from(signature!, 'base64url'));
    expect(ok).toBe(true);
  });
});

describe('callback URLs', () => {
  // Deployments naturally write API_URL as "<origin>/api" (that is the path the
  // router forwards), and the builders append "/api/v1/..." – the two together
  // used to produce ".../api/api/v1/..." and 404 every GitHub redirect.
  it('normalises an API_URL that already points at the /api path', () => {
    expect(normalizeApiUrl('https://ordi.example.com/api')).toBe('https://ordi.example.com');
    expect(normalizeApiUrl('https://ordi.example.com/api/')).toBe('https://ordi.example.com');
    expect(normalizeApiUrl('https://ordi.example.com/')).toBe('https://ordi.example.com');
    expect(normalizeApiUrl('http://localhost:3000')).toBe('http://localhost:3000');
  });

  it('never doubles the /api segment', () => {
    for (const url of [githubAppSetupUrl(), githubAppWebhookUrl()]) {
      expect(url).not.toContain('/api/api/');
      expect(url.match(/\/api\//g)).toHaveLength(1);
    }
  });
});

describe('manifest flow', () => {
  it('returns a manifest with the webhook and setup URLs baked in', async () => {
    const owner = reqAs(users.owner!.cookie);
    const res = await json(owner.post('/integrations/github-app/manifest', {}));
    expect(res.actionUrl).toContain('https://github.com/settings/apps/new?state=');
    const manifest = JSON.parse(res.manifest);
    expect(manifest.hook_attributes.url).toContain('/api/v1/integrations/git/github/webhook');
    expect(manifest.redirect_url).toContain('/api/v1/integrations/github-app/setup');
    expect(manifest.default_events).toEqual(['push', 'pull_request']);
    expect(manifest.default_permissions).toEqual({ contents: 'read', metadata: 'read', pull_requests: 'read' });
  });

  it('targets the organization form when one is given', async () => {
    const owner = reqAs(users.owner!.cookie);
    const res = await json(owner.post('/integrations/github-app/manifest', { organization: 'kdnx' }));
    expect(res.actionUrl).toContain('https://github.com/organizations/kdnx/settings/apps/new?state=');
  });

  it('requires integrations.manage', async () => {
    const guest = reqAs(users.guest!.cookie);
    expect((await guest.post('/integrations/github-app/manifest', {})).status).toBe(403);
  });

  it('setup callback rejects a forged state', async () => {
    const res = await app.request('/api/v1/integrations/github-app/setup?code=abc&state=forged.sig');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('githubApp=error');
  });

  it('setup callback converts the code and stores the app credentials', async () => {
    const owner = reqAs(users.owner!.cookie);
    const { actionUrl } = await json(owner.post('/integrations/github-app/manifest', {}));
    const state = new URL(actionUrl).searchParams.get('state')!;

    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      expect(String(url)).toContain('/app-manifests/one-time-code/conversions');
      return new Response(JSON.stringify({
        id: 777, slug: 'converted-app', pem: PEM, webhook_secret: 'converted-secret',
        html_url: 'https://github.com/apps/converted-app',
      }), { status: 201 });
    }));
    const res = await app.request(
      `/api/v1/integrations/github-app/setup?code=one-time-code&state=${encodeURIComponent(state)}`,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('githubApp=created');

    vi.unstubAllGlobals();
    invalidateRuntimeConfig();
    const owner2 = reqAs(users.owner!.cookie);
    const status = await json(owner2.get('/integrations/github-app/status'));
    expect(status).toMatchObject({
      configured: true,
      slug: 'converted-app',
      installUrl: 'https://github.com/apps/converted-app/installations/new',
    });
    // Restore the fixture app for the webhook tests below.
    await storeGithubAppConfig(APP);
  });
});

describe('installation webhooks', () => {
  it('installation created -> connection + repos appear with no manual step', async () => {
    const res = await delivery('installation', {
      action: 'created',
      installation: { id: 90001, account: { login: 'kdnx' } },
      repositories: [
        { id: 1, full_name: 'kdnx/site' },
        { id: 2, full_name: 'kdnx/api' },
      ],
    }, 'd-install-1');
    expect(res.status).toBe(200);

    const owner = reqAs(users.owner!.cookie);
    const conns = (await json(owner.get('/integrations/git/connections'))).data as any[];
    const conn = conns.find((c) => c.accountLogin === 'kdnx');
    expect(conn).toMatchObject({ provider: 'github', kind: 'app', status: 'connected' });
    const repos = (await json(owner.get(`/integrations/git/repositories?connectionId=${conn.id}`))).data as any[];
    expect(repos.map((r) => r.fullName).sort()).toEqual(['kdnx/api', 'kdnx/site']);
  });

  it('installation_repositories added -> new repo rows, idempotently', async () => {
    for (const id of ['d-repos-1', 'd-repos-2']) {
      const res = await delivery('installation_repositories', {
        action: 'added',
        installation: { id: 90001, account: { login: 'kdnx' } },
        repositories_added: [{ id: 3, full_name: 'kdnx/mobile' }],
      }, id);
      expect(res.status).toBe(200);
    }
    const { db } = getDb();
    const [conn] = await db.select().from(schema.gitConnections)
      .where(eq(schema.gitConnections.installationId, '90001'));
    const repos = await db.select().from(schema.gitRepositories)
      .where(eq(schema.gitRepositories.connectionId, conn!.id));
    expect(repos.filter((r) => r.fullName === 'kdnx/mobile')).toHaveLength(1);
  });

  it('a push signed with the app secret links tasks end to end', async () => {
    const owner = reqAs(users.owner!.cookie);
    const type = await json(owner.post('/project-types', { name: 'GH app test', revenueSource: 'none' }));
    const project = await json(owner.post('/projects', { name: 'App Flow', key: 'GHA', projectTypeId: type.id }));
    const task = await json(owner.post('/tasks', {
      projectId: project.id, title: 'Wire the app', priority: 'none', assigneeIds: [], labelIds: [],
    }));

    const { db } = getDb();
    const [conn] = await db.select().from(schema.gitConnections)
      .where(eq(schema.gitConnections.installationId, '90001'));
    const [repo] = await db.select().from(schema.gitRepositories)
      .where(eq(schema.gitRepositories.connectionId, conn!.id));
    await owner.post(`/projects/${project.id}/repositories`, { repositoryId: repo!.id });

    const res = await delivery('push', {
      ref: `refs/heads/feature/gha-${task.number}-wire`,
      created: true,
      installation: { id: 90001 },
      repository: { full_name: repo!.fullName },
      pusher: { name: 'dev' },
    }, 'd-push-1');
    expect(res.status).toBe(200);

    const links = await db.select().from(schema.gitLinks).where(eq(schema.gitLinks.taskId, task.id));
    expect(links).toHaveLength(1);
    expect(links[0]!.type).toBe('branch');
  });

  it('a delivery with a wrong signature changes nothing', async () => {
    const body = JSON.stringify({
      action: 'created',
      installation: { id: 90002, account: { login: 'evil' } },
      repositories: [],
    });
    const res = await app.request('/api/v1/integrations/git/github/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'installation',
        'x-github-delivery': 'd-forged-1',
        'x-hub-signature-256': `sha256=${createHmac('sha256', 'wrong-secret').update(body).digest('hex')}`,
      },
      body,
    });
    expect(res.status).toBe(200); // always 200, but nothing is created
    const { db } = getDb();
    const rows = await db.select().from(schema.gitConnections)
      .where(eq(schema.gitConnections.installationId, '90002'));
    expect(rows).toHaveLength(0);
  });

  it('installation deleted -> connection revoked, repos and links survive', async () => {
    const res = await delivery('installation', {
      action: 'deleted',
      installation: { id: 90001, account: { login: 'kdnx' } },
    }, 'd-uninstall-1');
    expect(res.status).toBe(200);
    const { db } = getDb();
    const [conn] = await db.select().from(schema.gitConnections)
      .where(eq(schema.gitConnections.installationId, '90001'));
    expect(conn!.status).toBe('revoked');
    const repos = await db.select().from(schema.gitRepositories)
      .where(eq(schema.gitRepositories.connectionId, conn!.id));
    expect(repos.length).toBeGreaterThan(0);
  });
});
