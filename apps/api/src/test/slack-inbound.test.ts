/**
 * Inbound Slack surface: the signed Events API handshake and the /ordi slash
 * command that files an intake item on the channel-bound project.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { getDb, schema, eq } from '@ordi/db';
import { app, resetDb, seedRolesAndUsers, reqAs, json } from './helpers';
import { encrypt, hmacSha256 } from '../lib/crypto';
import { invalidateRuntimeConfig } from '../lib/runtime-config';

const SECRET = 'test-signing-secret';
let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
let projectId: string;

function slackPost(path: string, raw: string, opts: { secret?: string; ts?: string; contentType?: string } = {}) {
  const ts = opts.ts ?? String(Math.floor(Date.now() / 1000));
  return app.request(path, {
    method: 'POST',
    headers: {
      'content-type': opts.contentType ?? 'application/x-www-form-urlencoded',
      'x-slack-request-timestamp': ts,
      'x-slack-signature': `v0=${hmacSha256(opts.secret ?? SECRET, `v0:${ts}:${raw}`)}`,
    },
    body: raw,
  });
}

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
  const { db } = getDb();
  await db.delete(schema.workspaceSettings);
  await db.insert(schema.workspaceSettings).values({
    id: 'workspace',
    integrations: { slack: { clientId: 'cid', clientSecret: encrypt('cs'), signingSecret: encrypt(SECRET) } },
  });
  invalidateRuntimeConfig();

  const owner = reqAs(users.owner!.cookie);
  const type = await json(owner.post('/project-types', { name: 'Ops', revenueSource: 'none' }));
  const project = await json(owner.post('/projects', { name: 'Ops', key: 'OPS', projectTypeId: type.id }));
  projectId = project.id;
  await db.update(schema.projects).set({ settings: { slackChannelId: 'C123' } })
    .where(eq(schema.projects.id, projectId));
});

describe('Slack events endpoint', () => {
  it('answers the url_verification handshake when the signature is valid', async () => {
    const raw = JSON.stringify({ type: 'url_verification', challenge: 'chal-42' });
    const res = await slackPost('/api/v1/integrations/slack/events', raw, { contentType: 'application/json' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: 'chal-42' });
  });

  it('rejects a wrong signature', async () => {
    const raw = JSON.stringify({ type: 'url_verification', challenge: 'x' });
    const res = await slackPost('/api/v1/integrations/slack/events', raw, { secret: 'wrong', contentType: 'application/json' });
    expect(res.status).toBe(401);
  });

  it('rejects a stale timestamp (replay window)', async () => {
    const raw = JSON.stringify({ type: 'url_verification', challenge: 'x' });
    const res = await slackPost('/api/v1/integrations/slack/events', raw, {
      ts: String(Math.floor(Date.now() / 1000) - 3600), contentType: 'application/json',
    });
    expect(res.status).toBe(401);
  });
});

describe('/ordi slash command', () => {
  it('files an intake item on the channel-bound project', async () => {
    const raw = new URLSearchParams({ channel_id: 'C123', user_name: 'vasyl', text: 'Need a new banner' }).toString();
    const res = await slackPost('/api/v1/integrations/slack/commands', raw);
    expect(res.status).toBe(200);
    const body = await res.json() as { response_type: string; text: string };
    expect(body.response_type).toBe('ephemeral');
    expect(body.text).toContain('Ops');

    const { db } = getDb();
    const items = await db.select().from(schema.intakeItems).where(eq(schema.intakeItems.projectId, projectId));
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe('Need a new banner');
    expect(items[0]!.source).toBe('slack');
    expect(items[0]!.requesterName).toBe('vasyl (Slack)');
    expect(items[0]!.status).toBe('pending');
  });

  it('explains itself in a channel no project is bound to', async () => {
    const raw = new URLSearchParams({ channel_id: 'C999', user_name: 'vasyl', text: 'hello' }).toString();
    const res = await slackPost('/api/v1/integrations/slack/commands', raw);
    expect(res.status).toBe(200);
    const body = await res.json() as { text: string };
    expect(body.text).toContain('not linked');
  });

  it('rejects an unsigned command', async () => {
    const raw = new URLSearchParams({ channel_id: 'C123', text: 'spoof' }).toString();
    const res = await app.request('/api/v1/integrations/slack/commands', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: raw,
    });
    expect(res.status).toBe(401);
  });
});
