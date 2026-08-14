/**
 * One-click Slack setup: an app configuration token goes in, the server calls
 * apps.manifest.create with this instance's URLs baked into the manifest, and
 * the returned credentials (client id/secret, signing secret) are stored
 * encrypted with no manual copying.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { resetDb, seedRolesAndUsers, reqAs, json } from './helpers';
import { buildSlackManifest, slackCommandsUrl } from '../domains/integrations/slack-app';
import { invalidateRuntimeConfig, runtimeConfig } from '../lib/runtime-config';

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
});

afterEach(() => {
  vi.unstubAllGlobals();
  invalidateRuntimeConfig();
});

describe('manifest content', () => {
  it('registers the slash command, OAuth redirect and bot scopes for this instance', () => {
    const m = buildSlackManifest('KDN') as any;
    expect(m.features.slash_commands[0].command).toBe('/ordi');
    expect(m.features.slash_commands[0].url).toBe(slackCommandsUrl());
    expect(m.features.slash_commands[0].url).toContain('/api/v1/integrations/slack/commands');
    expect(m.oauth_config.redirect_urls[0]).toContain('/api/v1/integrations/slack/oauth/callback');
    expect(m.oauth_config.scopes.bot).toEqual(['channels:read', 'groups:read', 'chat:write', 'commands']);
    // Slack verifies an events URL at save time – before the signing secret
    // could be stored – so the manifest must not declare event subscriptions.
    expect(m.settings.event_subscriptions).toBeUndefined();
  });
});

describe('POST /settings/integrations-config/slack-app', () => {
  it('requires settings.manage', async () => {
    const member = reqAs(users.member!.cookie);
    expect((await member.post('/settings/integrations-config/slack-app', { configToken: 'xoxe.xoxp-1' })).status).toBe(403);
  });

  it('rejects an empty token', async () => {
    const owner = reqAs(users.owner!.cookie);
    expect((await owner.post('/settings/integrations-config/slack-app', {})).status).toBe(400);
  });

  it('creates the app via the Manifest API and stores the credentials', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe('https://slack.com/api/apps.manifest.create');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer xoxe.xoxp-config-token');
      const body = JSON.parse(String(init?.body)) as { manifest: string };
      const manifest = JSON.parse(body.manifest);
      expect(manifest.features.slash_commands[0].url).toContain('/api/v1/integrations/slack/commands');
      return new Response(JSON.stringify({
        ok: true,
        app_id: 'A0TEST',
        credentials: {
          client_id: '1234.5678',
          client_secret: 'shhh-client',
          signing_secret: 'shhh-signing',
        },
      }), { status: 200 });
    }));

    const owner = reqAs(users.owner!.cookie);
    const res = await owner.post('/settings/integrations-config/slack-app', { configToken: 'xoxe.xoxp-config-token' });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ ok: true, appId: 'A0TEST' });

    vi.unstubAllGlobals();
    invalidateRuntimeConfig();
    const cfg = await runtimeConfig();
    expect(cfg.slack).toEqual({ clientId: '1234.5678', clientSecret: 'shhh-client', signingSecret: 'shhh-signing' });
    expect(cfg.slackSource).toBe('db');

    const shown = await json(owner.get('/settings/integrations-config'));
    expect(shown.slack).toEqual({ clientId: '1234.5678', hasSecret: true, hasSigningSecret: true });
  });

  it('surfaces Slack errors without storing anything', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ ok: false, error: 'invalid_auth' }), { status: 200 })));
    const owner = reqAs(users.owner!.cookie);
    const res = await owner.post('/settings/integrations-config/slack-app', { configToken: 'xoxe.xoxp-expired' });
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error.message).toContain('invalid_auth');

    // The credentials stored by the previous test survive a failed attempt.
    vi.unstubAllGlobals();
    invalidateRuntimeConfig();
    expect((await runtimeConfig()).slack?.clientId).toBe('1234.5678');
  });
});
