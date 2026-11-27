/**
 * The live update stream sends only what the caller can see right now (ORD-37).
 *
 * A connection used to keep the access it opened with: someone taken off a
 * private project, switched off, or whose token was revoked kept hearing it
 * for as long as the tab stayed open. Events that named no project or space –
 * a project created or completed, an invoice paid – went to everyone, and a
 * KB page event went to anyone who could open its space, drafts and private
 * pages included.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { getDb, schema, eq } from '@ordi/db';
import { ulid } from 'ulid';
import { resetDb, seedRolesAndUsers, reqAs, json, app } from './helpers';
import { drainOutbox } from './agents-helpers';
import { broadcaster, emit } from '../core/events';
import { streamTiming } from '../domains/core/stream.routes';
import { generateToken } from '../lib/crypto';

/** Slow CI must not turn a late event into a failure. */
const WAIT = { timeout: 5000, interval: 20 };

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;

/** A user with exactly these permissions, signed in with a session of their own. */
async function customRole(name: string, permissions: string[]) {
  const { db } = getDb();
  const roleId = ulid();
  await db.insert(schema.roles).values({ id: roleId, key: `${name}-${roleId}`, name, description: 'custom', isSystem: false });
  if (permissions.length) {
    await db.insert(schema.rolePermissions).values(permissions.map((p) => ({ roleId, permission: p as any })));
  }
  const userId = ulid();
  await db.insert(schema.users).values({ id: userId, email: `${roleId}@test.local`, name, passwordHash: 'x', roleId });
  const token = generateToken();
  await db.insert(schema.sessions).values({ id: ulid(), userId, token, expiresAt: new Date(Date.now() + 3600_000) });
  return { userId, token, cookie: `ordi_session=${token}`, as: reqAs(`ordi_session=${token}`) };
}

interface Frame { event: string; data: any }

/** An open SSE connection: the frames it has received so far, and whether it ended. */
async function openStream(headers: Record<string, string>) {
  const res = await app.request('/api/v1/stream', { headers });
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const state = {
    frames: [] as Frame[],
    ended: false,
    close: () => reader.cancel().catch(() => {}),
    events: () => state.frames.map((f) => f.event),
    pings: () => state.frames.filter((f) => f.event === 'ping').length,
  };
  let buf = '';
  void (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let at: number;
      while ((at = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, at);
        buf = buf.slice(at + 2);
        const event = /^event: (.*)$/m.exec(frame)?.[1];
        const data = /^data: (.*)$/m.exec(frame)?.[1];
        if (event) state.frames.push({ event, data: data ? JSON.parse(data) : null });
      }
    }
  })().catch(() => {}).finally(() => { state.ended = true; });
  await vi.waitFor(() => expect(state.events()).toContain('connected'), WAIT);
  return state;
}
type Stream = Awaited<ReturnType<typeof openStream>>;

/** Two pings: one refresh of access, and time for any re-read the next event needs. */
async function pingsPass(...streams: Stream[]) {
  const seen = streams.map((s) => s.pings());
  await vi.waitFor(() => streams.forEach((s, i) => expect(s.pings()).toBeGreaterThanOrEqual(seen[i]! + 2)), WAIT);
}

const pingMs = streamTiming.pingMs;
afterAll(() => { streamTiming.pingMs = pingMs; });

let admin: ReturnType<typeof reqAs>;
let projectTypeId = '';

beforeAll(async () => {
  streamTiming.pingMs = 40;
  await resetDb();
  users = await seedRolesAndUsers();
  admin = reqAs(users.admin!.cookie);
  projectTypeId = (await json(admin.post('/project-types', { name: 'Stream type', revenueSource: 'none' }))).id;
});

async function privateProject(key: string) {
  const res = await admin.post('/projects', { name: `Closed ${key}`, key, projectTypeId, visibility: 'private' });
  expect(res.status).toBe(201);
  return (await json(res)).id as string;
}

describe('a connection follows the caller\'s access', () => {
  it('stops sending a private project\'s events once its member is taken off it', async () => {
    const projectId = await privateProject('RMV');
    const person = await customRole('Removed', ['projects.read']);
    expect((await admin.post(`/projects/${projectId}/members`, { userId: person.userId, role: 'member' })).status).toBeLessThan(300);
    const stream = await openStream({ cookie: person.cookie });
    try {
      broadcaster.broadcast({ event: 'task.before', data: { projectId }, projectScope: [projectId] });
      await vi.waitFor(() => expect(stream.events()).toContain('task.before'), WAIT);

      expect((await admin.del(`/projects/${projectId}/members/${person.userId}`)).status).toBeLessThan(300);
      await pingsPass(stream);
      broadcaster.broadcast({ event: 'task.after', data: { projectId }, projectScope: [projectId] });
      await pingsPass(stream);
      expect(stream.events()).not.toContain('task.after');
      expect(stream.ended).toBe(false);
    } finally { await stream.close(); }
  });

  it('ends when the API token it opened with is revoked', async () => {
    const person = await customRole('Token holder', ['projects.read']);
    const minted = await person.as.post('/auth/tokens', { name: 'cli', scopes: ['projects.read'], readOnly: true });
    expect(minted.status).toBe(201);
    const { id, token } = await json(minted);
    const stream = await openStream({ authorization: `Bearer ${token}` });
    try {
      await pingsPass(stream);
      expect(stream.ended).toBe(false);
      expect((await person.as.del(`/auth/tokens/${id}`)).status).toBe(200);
      await vi.waitFor(() => expect(stream.ended).toBe(true), WAIT);
    } finally { await stream.close(); }
  });

  it('ends when the session is signed out, or the user is switched off', async () => {
    const { db } = getDb();
    const signedOut = await customRole('Signed out', ['projects.read']);
    const switchedOff = await customRole('Switched off', ['projects.read']);
    const a = await openStream({ cookie: signedOut.cookie });
    const b = await openStream({ cookie: switchedOff.cookie });
    try {
      await pingsPass(a, b);
      await db.delete(schema.sessions).where(eq(schema.sessions.token, signedOut.token));
      await db.update(schema.users).set({ isActive: false }).where(eq(schema.users.id, switchedOff.userId));
      await vi.waitFor(() => { expect(a.ended).toBe(true); expect(b.ended).toBe(true); }, WAIT);
    } finally { await a.close(); await b.close(); }
  });
});

describe('news without a project or a space', () => {
  it('a private project\'s creation and completion reach its members, not everyone', async () => {
    const outsider = await customRole('Outsider', ['projects.read']);
    const inside = await openStream({ cookie: users.admin!.cookie });
    const outside = await openStream({ cookie: outsider.cookie });
    try {
      const projectId = await privateProject('SEC');
      await drainOutbox();
      await vi.waitFor(() => expect(inside.events()).toContain('project.created'), WAIT);

      expect((await admin.patch(`/projects/${projectId}`, { status: 'completed' })).status).toBe(200);
      await drainOutbox();
      await vi.waitFor(() => expect(inside.events()).toContain('project.completed'), WAIT);
      await pingsPass(outside);
      expect(outside.events()).not.toContain('project.created');
      expect(outside.events()).not.toContain('project.completed');
      expect(JSON.stringify(outside.frames)).not.toContain('SEC');
    } finally { await inside.close(); await outside.close(); }
  });

  it('finance news reaches those who read finance', async () => {
    const reader = await openStream({ cookie: users.finance!.cookie });
    const member = await openStream({ cookie: users.member!.cookie });
    try {
      await emit({ type: 'invoice.paid', aggregateType: 'invoice', aggregateId: ulid(), payload: { number: 'INV-0042', companyId: null } });
      await drainOutbox();
      await vi.waitFor(() => expect(reader.events()).toContain('invoice.paid'), WAIT);
      await pingsPass(member);
      expect(member.events()).not.toContain('invoice.paid');
    } finally { await reader.close(); await member.close(); }
  });

  it('someone else\'s time on a project reaches time.read_all and the person who logged it, not every member', async () => {
    const projectId = await privateProject('TIM');
    const logger = await customRole('Logger', ['projects.read', 'time.track']);
    const colleague = await customRole('Colleague', ['projects.read']);
    for (const u of [logger, colleague]) {
      expect((await admin.post(`/projects/${projectId}/members`, { userId: u.userId, role: 'member' })).status).toBeLessThan(300);
    }
    const mine = await openStream({ cookie: logger.cookie });
    const theirs = await openStream({ cookie: colleague.cookie });
    const all = await openStream({ cookie: users.admin!.cookie });
    try {
      await emit({ type: 'time.entry_created', aggregateType: 'time_entry', aggregateId: ulid(), payload: { taskId: ulid(), projectId, userId: logger.userId, durationSeconds: 3600, billable: true } });
      await emit({ type: 'task.updated', aggregateType: 'task', aggregateId: ulid(), payload: { projectId } });
      await drainOutbox();
      await vi.waitFor(() => expect(mine.events()).toContain('time.entry_created'), WAIT);
      await vi.waitFor(() => expect(all.events()).toContain('time.entry_created'), WAIT);
      // The colleague still hears the project's task work.
      await vi.waitFor(() => expect(theirs.events()).toContain('task.updated'), WAIT);
      await pingsPass(theirs);
      expect(theirs.events()).not.toContain('time.entry_created');
    } finally { await mine.close(); await theirs.close(); await all.close(); }
  });

  it('a message nobody scoped goes nowhere', async () => {
    const stream = await openStream({ cookie: users.owner!.cookie });
    try {
      broadcaster.broadcast({ event: 'project.created', data: { key: 'LEAK' } });
      broadcaster.broadcast({ event: 'role.updated', data: {}, workspaceWide: true });
      await vi.waitFor(() => expect(stream.events()).toContain('role.updated'), WAIT);
      await pingsPass(stream);
      expect(stream.events()).not.toContain('project.created');
    } finally { await stream.close(); }
  });
});

describe('knowledge-base pages', () => {
  it('a draft or private page\'s events reach its editors and author, not every reader of the space', async () => {
    const owner = reqAs(users.owner!.cookie);
    const reader = await customRole('Reader', ['kb.read']);
    const editor = await customRole('Editor', ['kb.read', 'kb.write']);
    const spaceId = (await json(owner.post('/spaces', { name: 'Handbook', visibility: 'workspace' }))).id;
    const draft = (await json(owner.post('/pages', { spaceId, title: 'Half-written', published: false }))).id;
    const hidden = (await json(owner.post('/pages', { spaceId, title: 'Just mine', visibility: 'private' }))).id;
    const open = (await json(owner.post('/pages', { spaceId, title: 'Everyone' }))).id;
    await drainOutbox();

    const readerStream = await openStream({ cookie: reader.cookie });
    const editorStream = await openStream({ cookie: editor.cookie });
    const authorStream = await openStream({ cookie: users.owner!.cookie });
    try {
      for (const id of [draft, hidden, open]) {
        expect((await owner.patch(`/pages/${id}`, { title: `Renamed ${id}` })).status).toBe(200);
      }
      await drainOutbox();
      const pagesOf = (s: Stream) => s.frames.filter((f) => f.event === 'page.updated').map((f) => f.data.pageId);
      await vi.waitFor(() => expect(pagesOf(editorStream)).toEqual(expect.arrayContaining([draft, hidden, open])), WAIT);
      await vi.waitFor(() => expect(pagesOf(authorStream)).toEqual(expect.arrayContaining([draft, hidden, open])), WAIT);
      await vi.waitFor(() => expect(pagesOf(readerStream)).toContain(open), WAIT);
      await pingsPass(readerStream);
      expect(pagesOf(readerStream)).not.toContain(draft);
      expect(pagesOf(readerStream)).not.toContain(hidden);
    } finally { await readerStream.close(); await editorStream.close(); await authorStream.close(); }
  });

  it('an event for a page deleted before it was sent goes nowhere', async () => {
    const owner = reqAs(users.owner!.cookie);
    const spaceId = (await json(owner.post('/spaces', { name: 'Archive', visibility: 'workspace' }))).id;
    const doomed = (await json(owner.post('/pages', { spaceId, title: 'Soon gone' }))).id;
    const kept = (await json(owner.post('/pages', { spaceId, title: 'Staying' }))).id;
    await drainOutbox();
    const stream = await openStream({ cookie: users.owner!.cookie });
    try {
      for (const id of [doomed, kept]) expect((await owner.patch(`/pages/${id}`, { title: `Renamed ${id}` })).status).toBe(200);
      await getDb().db.update(schema.kbPages).set({ deletedAt: new Date() }).where(eq(schema.kbPages.id, doomed));
      await drainOutbox();
      const pagesOf = () => stream.frames.filter((f) => f.event.startsWith('page.')).map((f) => f.data.pageId);
      await vi.waitFor(() => expect(pagesOf()).toContain(kept), WAIT);
      await pingsPass(stream);
      expect(pagesOf()).not.toContain(doomed);
    } finally { await stream.close(); }
  });
});
