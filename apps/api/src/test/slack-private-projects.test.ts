/**
 * A private project's work is for its members, so its Slack messages go only
 * to a target set on the project itself – its channel (with a usable bot
 * token) or its own webhook – and never fall back to the workspace webhook,
 * the shared channel everyone reads. With no own target, nothing is posted.
 * Public projects keep the fallback.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { getDb, schema, eq } from '@ordi/db';
import { ulid } from 'ulid';
import { resetDb, seedRolesAndUsers, reqAs, json } from './helpers';
import { drainOutbox } from './agents-helpers';
import { encrypt } from '../lib/crypto';

const WORKSPACE_HOOK = 'https://hooks.slack.com/services/T000/B000/workspace';
const OWN_HOOK = 'https://hooks.slack.com/services/T000/B000/own-project';
const CHAT_POST = 'https://slack.com/api/chat.postMessage';

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
let typeId: string;
let posts: { url: string; body: { text?: string; channel?: string } }[] = [];

const owner = () => reqAs(users.owner!.cookie);

const mentioning = (userId: string, s: string) => ({
  type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'mention', attrs: { id: userId, label: 'Member' } }, { type: 'text', text: ` ${s}` }] }],
});

async function setWorkspaceHook(url: string | null) {
  const { db } = getDb();
  const [ws] = await db.select().from(schema.workspaceSettings).where(eq(schema.workspaceSettings.id, 'workspace'));
  const integrations = { ...((ws?.integrations as Record<string, unknown>) ?? {}) };
  if (url) integrations.slackWebhookUrl = url;
  else delete integrations.slackWebhookUrl;
  if (ws) await db.update(schema.workspaceSettings).set({ integrations }).where(eq(schema.workspaceSettings.id, 'workspace'));
  else await db.insert(schema.workspaceSettings).values({ id: 'workspace', integrations });
}

let keySeq = 0;
/** SLA, SLB, … SLAA: project keys are letters only. */
function nextKey(): string {
  keySeq += 1;
  let n = keySeq;
  let suffix = '';
  while (n > 0) { n -= 1; suffix = String.fromCharCode(65 + (n % 26)) + suffix; n = Math.floor(n / 26); }
  return `SL${suffix}`;
}
async function project(visibility: 'workspace' | 'private', settings: Record<string, unknown> = {}): Promise<string> {
  const key = nextKey();
  const res = await owner().post('/projects', { name: `Slack ${visibility} ${key}`, key, projectTypeId: typeId, visibility });
  expect(res.status).toBe(201);
  const p = await json(res);
  // The member is on every project, so a mention of them is delivered.
  await owner().post(`/projects/${p.id}/members`, { userId: users.member!.userId, role: 'member', canWriteTasks: true });
  if (Object.keys(settings).length) {
    await getDb().db.update(schema.projects).set({ settings }).where(eq(schema.projects.id, p.id));
  }
  return p.id;
}

async function task(projectId: string, title: string): Promise<string> {
  const res = await owner().post('/tasks', { projectId, title });
  expect(res.status).toBe(201);
  return (await json(res)).id;
}

async function doneStatusId(projectId: string): Promise<string> {
  const statuses = await json(owner().get(`/projects/${projectId}/task-statuses`));
  return statuses.data.find((s: { category: string }) => s.category === 'done').id;
}

/** Run what is queued, then forget what it posted: the next step's posts are the ones asserted. */
async function settle() {
  await drainOutbox();
  posts = [];
}

/**
 * Each event that resolves a project target, set up on `projectId` and then
 * fired. Only what the fire step posts is asserted.
 */
const EVENTS: { name: string; setup: (projectId: string) => Promise<unknown>; fire: (projectId: string, ctx: any) => Promise<void> }[] = [
  {
    name: 'task.created',
    setup: async () => null,
    fire: async (projectId) => { await task(projectId, 'Secret launch plan'); },
  },
  {
    name: 'task.created by a duplicate',
    setup: async (projectId) => task(projectId, 'Secret launch plan'),
    fire: async (_projectId, taskId: string) => {
      expect((await owner().post(`/tasks/${taskId}/duplicate`)).status).toBe(201);
    },
  },
  {
    name: 'task.created by a move into the project',
    setup: async () => task(await project('workspace', { slackWebhookUrl: 'https://hooks.slack.com/services/T000/B000/source' }), 'Secret launch plan'),
    fire: async (projectId, taskId: string) => {
      expect((await owner().post(`/tasks/${taskId}/move`, { targetProjectId: projectId })).status).toBe(200);
    },
  },
  {
    name: 'task.status_changed',
    setup: async (projectId) => task(projectId, 'Secret launch plan'),
    fire: async (projectId, taskId: string) => {
      expect((await owner().patch(`/tasks/${taskId}`, { statusId: await doneStatusId(projectId) })).status).toBe(200);
    },
  },
  {
    name: 'comment.mentioned',
    setup: async (projectId) => task(projectId, 'Secret launch plan'),
    fire: async (_projectId, taskId: string) => {
      expect((await owner().post(`/tasks/${taskId}/comments`, { body: mentioning(users.member!.userId, 'have a look') })).status).toBe(201);
    },
  },
  {
    name: 'project.completed',
    setup: async () => null,
    fire: async (projectId) => {
      expect((await owner().patch(`/projects/${projectId}`, { status: 'completed' })).status).toBe(200);
    },
  },
];

/** Only the posts that came from the fire step, minus a moved task's old project. */
const sent = () => posts.filter((p) => !p.url.endsWith('/source'));

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
  typeId = ulid();
  await getDb().db.insert(schema.projectTypes).values({ id: typeId, name: 'Service' });
  await setWorkspaceHook(WORKSPACE_HOOK);
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
    posts.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : {} });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
});

beforeEach(async () => {
  await getDb().db.delete(schema.slackConnections);
  await settle();
});

afterAll(async () => {
  // workspace_settings outlives resetDb(): leave no shared channel behind.
  await setWorkspaceHook(null);
  await getDb().db.delete(schema.slackConnections);
  vi.unstubAllGlobals();
});

describe.each(EVENTS)('$name', ({ setup, fire }) => {
  it('from a private project with no target of its own posts nothing', async () => {
    const projectId = await project('private');
    const ctx = await setup(projectId);
    await settle();
    await fire(projectId, ctx);
    await drainOutbox();
    expect(sent()).toEqual([]);
  });

  it('from a private project goes to its own webhook', async () => {
    const projectId = await project('private', { slackWebhookUrl: OWN_HOOK });
    const ctx = await setup(projectId);
    await settle();
    await fire(projectId, ctx);
    await drainOutbox();
    expect(sent().length).toBeGreaterThan(0);
    expect(sent().every((p) => p.url === OWN_HOOK)).toBe(true);
  });

  it('from a private project with a channel but no bot token posts nothing', async () => {
    const projectId = await project('private', { slackChannelId: 'C0PRIVATE' });
    const ctx = await setup(projectId);
    await settle();
    await fire(projectId, ctx);
    await drainOutbox();
    expect(sent()).toEqual([]);
  });

  it('from a public project with no target of its own still falls back to the workspace webhook', async () => {
    const projectId = await project('workspace');
    const ctx = await setup(projectId);
    await settle();
    await fire(projectId, ctx);
    await drainOutbox();
    expect(sent().length).toBeGreaterThan(0);
    expect(sent().every((p) => p.url === WORKSPACE_HOOK)).toBe(true);
  });
});

describe('a private project with a Slack channel', () => {
  it('posts there through the bot when a token is connected', async () => {
    await getDb().db.insert(schema.slackConnections).values({
      id: ulid(), teamId: 'T000', teamName: 'Test', botToken: encrypt('xoxb-test-token'), scope: 'chat:write',
    });
    const projectId = await project('private', { slackChannelId: 'C0PRIVATE' });
    await settle();
    await task(projectId, 'Secret launch plan');
    await drainOutbox();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe(CHAT_POST);
    expect(posts[0]!.body.channel).toBe('C0PRIVATE');
  });

  it('uses its own webhook when the bot token is gone', async () => {
    const projectId = await project('private', { slackChannelId: 'C0PRIVATE', slackWebhookUrl: OWN_HOOK });
    await settle();
    await task(projectId, 'Secret launch plan');
    await drainOutbox();
    expect(posts.map((p) => p.url)).toEqual([OWN_HOOK]);
  });
});

describe('a public project with a channel but no bot token', () => {
  it('falls back to the workspace webhook, as before', async () => {
    const projectId = await project('workspace', { slackChannelId: 'C0PUBLIC' });
    await settle();
    await task(projectId, 'Open plan');
    await drainOutbox();
    expect(posts.map((p) => p.url)).toEqual([WORKSPACE_HOOK]);
  });
});

describe('workspace events', () => {
  it('a won deal still goes to the workspace webhook', async () => {
    // deal.won carries no project: the workspace channel is its only target.
    const { db } = getDb();
    const { publishEvent } = await import('../core/events');
    await db.transaction(async (tx) => {
      await publishEvent(tx, { type: 'deal.won', aggregateType: 'deal', aggregateId: ulid(), payload: { title: 'Big one' }, actorId: users.owner!.userId, actorType: 'user' });
    });
    await drainOutbox();
    expect(posts.map((p) => p.url)).toEqual([WORKSPACE_HOOK]);
  });
});
