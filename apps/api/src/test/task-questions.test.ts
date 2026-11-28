/**
 * "Waiting on": an agent (or a person) asks one person for input on a task
 * without changing its status. Under test: who the question goes to (each
 * branch of the addressee rule), who may ask and who may be asked, that the
 * addressee's first comment answers it and nobody else's does, what
 * list_answered shows to whom, and that the addressee is notified even when
 * the asker is their own agent.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { getDb, schema, eq, and } from '@ordi/db';
import { resetDb, seedRolesAndUsers, reqAs, json, app } from './helpers';
import { setupWorkspace, addProjectMember, drainOutbox, type Workspace } from './agents-helpers';

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
let ws: Workspace;
/** A team bot owned by the manager, a member of the project. */
let botId: string;
let botToken: string;
/** The member's own agent. */
let mineId: string;
let mineToken: string;

const owner = () => reqAs(users.owner!.cookie);
const member = () => reqAs(users.member!.cookie);

function bearer(raw: string) {
  const headers = (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${raw}`, ...extra });
  return {
    get: (path: string) => app.request(`/api/v1${path}`, { headers: headers() }),
    post: (path: string, body?: unknown) => app.request(`/api/v1${path}`, {
      method: 'POST', headers: headers({ 'content-type': 'application/json' }), body: body ? JSON.stringify(body) : undefined,
    }),
  };
}
const bot = () => bearer(botToken);
const mine = () => bearer(mineToken);

const doc = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

async function newTask(input: Record<string, unknown> = {}, projectId = ws.projectId): Promise<{ id: string; ref: string }> {
  const res = await owner().post('/tasks', { projectId, title: 'Something to do', ...input });
  expect(res.status).toBe(201);
  const t = await json(res);
  return { id: t.id, ref: t.ref };
}

async function ask(as: { post: (p: string, b?: unknown) => Response | Promise<Response> }, task: string, body: Record<string, unknown>) {
  return as.post(`/tasks/${task}/question`, { question: 'Which colour should the button be?', ...body });
}

async function openQuestion(taskId: string) {
  const [row] = await getDb().db.select().from(schema.taskQuestions)
    .where(and(eq(schema.taskQuestions.taskId, taskId), eq(schema.taskQuestions.status, 'open')));
  return row;
}

async function notificationsOf(userId: string, type: string) {
  return getDb().db.select().from(schema.notifications)
    .where(and(eq(schema.notifications.userId, userId), eq(schema.notifications.type, type)));
}

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
  ws = await setupWorkspace(users, 'ASK');

  const created = await json(owner().post('/external-agents', { name: 'Builder bot', ownerUserId: users.manager!.userId }));
  botId = created.id;
  await addProjectMember(users, ws.projectId, botId, 'member');
  botToken = (await json(owner().post(`/external-agents/${botId}/tokens`, { expiresInDays: 30 }))).token;

  const myAgent = await member().post('/my-agent', { name: 'Jarvis' });
  expect(myAgent.status).toBe(201);
  mineId = (await json(myAgent)).id;
  mineToken = (await json(member().post('/my-agent/tokens', { client: 'Codex', expiresInDays: 30 }))).token;
});

beforeEach(async () => {
  await drainOutbox();
  await getDb().db.delete(schema.notifications);
});

describe('who a question goes to', () => {
  it('goes to the person named', async () => {
    const t = await newTask({ assigneeIds: [users.member!.userId] });
    const res = await ask(bot(), t.id, { addresseeId: users.manager!.userId });
    expect(res.status).toBe(201);
    expect((await json(res)).addressee.id).toBe(users.manager!.userId);
  });

  it('refuses a named agent, and a named person who cannot open the project', async () => {
    const t = await newTask();
    expect((await ask(owner(), t.id, { addresseeId: botId })).status).toBe(400);
    expect((await ask(owner(), t.id, { addresseeId: mineId })).status).toBe(400);
    const type = await json(owner().post('/project-types', { name: 'Closed type', revenueSource: 'none' }));
    const priv = await json(owner().post('/projects', { name: 'Closed', key: 'CLS', projectTypeId: type.id, visibility: 'private' }));
    const closed = await newTask({}, priv.id);
    const refused = await ask(owner(), closed.id, { addresseeId: users.member!.userId });
    expect(refused.status).toBe(400);
    expect(await openQuestion(closed.id)).toBeUndefined();
  });

  it('otherwise goes to the task\'s human assignee, the first by name of several', async () => {
    // Seeded names are the role names: "Admin" sorts before "Member".
    const t = await newTask({ assigneeIds: [users.member!.userId, users.admin!.userId, botId] });
    const res = await json(ask(bot(), t.id, {}));
    expect(res.addressee.id).toBe(users.admin!.userId);
  });

  it('from a personal agent on its owner\'s task, goes to its owner', async () => {
    const assigned = await newTask({ assigneeIds: [users.admin!.userId, users.member!.userId] });
    expect((await json(ask(mine(), assigned.id, {}))).addressee.id).toBe(users.member!.userId);
    const reported = await newTask({ reporterId: users.member!.userId, assigneeIds: [users.admin!.userId] });
    expect((await json(ask(mine(), reported.id, {}))).addressee.id).toBe(users.member!.userId);
    // Someone else named still wins.
    const named = await newTask({ assigneeIds: [users.member!.userId] });
    expect((await json(ask(mine(), named.id, { addresseeId: users.owner!.userId }))).addressee.id).toBe(users.owner!.userId);
  });

  it('otherwise goes to the reporter', async () => {
    const t = await newTask({ reporterId: users.manager!.userId });
    expect((await json(ask(bot(), t.id, {}))).addressee.id).toBe(users.manager!.userId);
  });

  it('goes to the owner of an agent that reported the task', async () => {
    const t = await newTask({ reporterId: botId });
    // The bot is the reporter; its owner, the manager, is who set it really.
    expect((await json(ask(owner(), t.id, {}))).addressee.id).toBe(users.manager!.userId);
  });

  it('otherwise goes to the asking agent\'s owner', async () => {
    const t = await newTask({ reporterId: null });
    expect((await json(ask(bot(), t.id, {}))).addressee.id).toBe(users.manager!.userId);
  });

  it('is refused when there is nobody to ask', async () => {
    const t = await newTask({ reporterId: null });
    const res = await ask(owner(), t.id, {});
    expect(res.status).toBe(422);
    expect(await openQuestion(t.id)).toBeUndefined();
  });

  it('takes a task ref as well as an id', async () => {
    const t = await newTask({ assigneeIds: [users.member!.userId] });
    const res = await ask(bot(), t.ref, {});
    expect(res.status).toBe(201);
    expect((await json(res)).taskId).toBe(t.id);
  });
});

describe('who may ask', () => {
  it('refuses someone who cannot write to the project', async () => {
    const t = await newTask({ assigneeIds: [users.member!.userId] });
    // Sales reads projects and writes none.
    const res = await ask(reqAs(users.sales!.cookie), t.id, {});
    expect(res.status).toBe(403);
    expect(await openQuestion(t.id)).toBeUndefined();
  });

  it('refuses an agent outside the project as not found', async () => {
    const type = await json(owner().post('/project-types', { name: 'Off type', revenueSource: 'none' }));
    const off = await json(owner().post('/projects', { name: 'Off limits', key: 'OFFL', projectTypeId: type.id, visibility: 'private' }));
    const t = await newTask({}, off.id);
    expect((await ask(bot(), t.id, { addresseeId: users.owner!.userId })).status).toBe(404);
  });

  it('replaces the asker\'s own open question, and refuses to replace someone else\'s', async () => {
    const t = await newTask({ assigneeIds: [users.member!.userId] });
    const first = await json(ask(bot(), t.id, { question: 'First?' }));
    const second = await json(ask(bot(), t.id, { question: 'Second?' }));
    expect(second.replaced).toBe(first.id);
    expect((await openQuestion(t.id))!.question).toBe('Second?');
    const other = await ask(owner(), t.id, { question: 'Mine?' });
    expect(other.status).toBe(422);
    expect((await openQuestion(t.id))!.question).toBe('Second?');
  });

  it('leaves the task\'s status alone', async () => {
    const t = await newTask({ assigneeIds: [users.member!.userId] });
    const before = await json(owner().get(`/tasks/${t.id}`));
    await ask(bot(), t.id, {});
    const after = await json(owner().get(`/tasks/${t.id}`));
    expect(after.statusId).toBe(before.statusId);
    expect(after.openQuestion).toMatchObject({ addressee: { id: users.member!.userId }, askedBy: { id: botId } });
  });
});

describe('answering', () => {
  it('is the addressee\'s first comment; anyone else\'s leaves it open', async () => {
    const t = await newTask({ assigneeIds: [users.member!.userId] });
    const q = await json(ask(bot(), t.id, {}));
    await owner().post(`/tasks/${t.id}/comments`, { body: doc('Not my call') });
    // The addressee's own agent is not the addressee.
    await mine().post(`/tasks/${t.id}/comments`, { body: doc('My owner will answer') });
    expect((await openQuestion(t.id))?.id).toBe(q.id);

    const answer = await json(member().post(`/tasks/${t.id}/comments`, { body: doc('Blue') }));
    expect(await openQuestion(t.id)).toBeUndefined();
    const [row] = await getDb().db.select().from(schema.taskQuestions).where(eq(schema.taskQuestions.id, q.id));
    expect(row).toMatchObject({ status: 'answered', answerCommentId: answer.id, answeredBy: users.member!.userId });
    expect((await json(owner().get(`/tasks/${t.id}`))).openQuestion).toBeNull();
  });

  it('can be marked by the addressee, without a comment', async () => {
    const t = await newTask({ assigneeIds: [users.member!.userId] });
    await ask(bot(), t.id, {});
    const view = (await json(member().get(`/tasks/${t.id}`))).openQuestion;
    expect(view).toMatchObject({ canMarkAnswered: true, canWithdraw: false });
    expect((await member().post(`/tasks/${t.id}/question/withdraw`)).status).toBe(403);
    expect((await member().post(`/tasks/${t.id}/question/answered`)).status).toBe(200);
    expect(await openQuestion(t.id)).toBeUndefined();
  });

  it('can be withdrawn by the asker or the project lead, nobody else', async () => {
    const t = await newTask({ assigneeIds: [users.member!.userId] });
    await ask(bot(), t.id, {});
    // A colleague who can write to the project is neither; nor is a project
    // admin, nor the owner of the team bot that asked.
    await addProjectMember(users, ws.projectId, users.hr!.userId, 'member');
    expect((await reqAs(users.hr!.cookie).post(`/tasks/${t.id}/question/withdraw`)).status).toBe(403);
    expect((await reqAs(users.hr!.cookie).post(`/tasks/${t.id}/question/answered`)).status).toBe(403);
    expect((await owner().post(`/tasks/${t.id}/question/withdraw`)).status).toBe(403);
    expect((await reqAs(users.manager!.cookie).post(`/tasks/${t.id}/question/withdraw`)).status).toBe(403);

    await owner().patch(`/projects/${ws.projectId}`, { leadId: users.hr!.userId });
    expect((await reqAs(users.hr!.cookie).post(`/tasks/${t.id}/question/withdraw`)).status).toBe(200);
    expect(await openQuestion(t.id)).toBeUndefined();
    await owner().patch(`/projects/${ws.projectId}`, { leadId: null });
  });

  it('from a personal agent, can be withdrawn by the person it acts for', async () => {
    const t = await newTask({ assigneeIds: [users.admin!.userId] });
    await ask(mine(), t.id, { addresseeId: users.admin!.userId });
    expect((await member().post(`/tasks/${t.id}/question/withdraw`)).status).toBe(200);
  });

  it('can be marked answered by an addressee who may only read the project', async () => {
    const t = await newTask({ assigneeIds: [users.member!.userId] });
    // Sales reads workspace projects and writes none: it cannot comment.
    await ask(owner(), t.id, { addresseeId: users.sales!.userId });
    const sales = reqAs(users.sales!.cookie);
    expect((await json(sales.get(`/tasks/${t.id}`))).openQuestion).toMatchObject({ canMarkAnswered: true, canWithdraw: false });
    expect((await sales.post(`/tasks/${t.id}/question/answered`)).status).toBe(200);
  });

  it('refuses to close a question that was replaced since the page loaded', async () => {
    const t = await newTask({ assigneeIds: [users.member!.userId] });
    const first = await json(ask(bot(), t.id, { question: 'First?' }));
    await ask(bot(), t.id, { question: 'Second?' });
    const stale = await member().post(`/tasks/${t.id}/question/answered`, { questionId: first.id });
    expect(stale.status).toBe(409);
    expect((await openQuestion(t.id))!.question).toBe('Second?');
  });
});

describe('refs', () => {
  it('answer a task in a closed project exactly like a task that does not exist', async () => {
    const type = await json(owner().post('/project-types', { name: 'Hidden type', revenueSource: 'none' }));
    const hidden = await json(owner().post('/projects', { name: 'Hidden', key: 'HID', projectTypeId: type.id, visibility: 'private' }));
    const t = await newTask({}, hidden.id);
    const existing = await ask(bot(), t.ref, { addresseeId: users.owner!.userId });
    const missing = await ask(bot(), 'NOPE-1', { addresseeId: users.owner!.userId });
    expect(existing.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await json(existing)).toEqual(await json(missing));
    expect((await ask(bot(), 'ASK-99999999999', {})).status).toBe(404);
  });
});

describe('list_answered', () => {
  it('lists only the caller\'s own questions, with the answering comment', async () => {
    const byBot = await newTask({ assigneeIds: [users.member!.userId] });
    const byMine = await newTask({ assigneeIds: [users.member!.userId] });
    const before = new Date().toISOString();
    const botQ = await json(ask(bot(), byBot.id, { question: 'Bot asks?' }));
    const mineQ = await json(ask(mine(), byMine.id, { question: 'Jarvis asks?' }));
    await member().post(`/tasks/${byBot.id}/comments`, { body: doc('Answer for the bot') });
    await member().post(`/tasks/${byMine.id}/comments`, { body: doc('Answer for Jarvis') });

    const forBot = (await json(bot().get(`/me/questions/answered?since=${encodeURIComponent(before)}`))).data;
    expect(forBot.map((q: { id: string }) => q.id)).toEqual([botQ.id]);
    expect(forBot[0]).toMatchObject({ ref: byBot.ref, question: 'Bot asks?' });
    expect(JSON.stringify(forBot[0].answer.body)).toContain('Answer for the bot');

    const forMine = (await json(mine().get(`/me/questions/answered?since=${encodeURIComponent(before)}`))).data;
    expect(forMine.map((q: { id: string }) => q.id)).toEqual([mineQ.id]);
    // The owner did not ask, so sees neither; a later `since` sees nothing.
    expect((await json(member().get('/me/questions/answered'))).data).toEqual([]);
    const later = new Date(Date.now() + 60_000).toISOString();
    expect((await json(bot().get(`/me/questions/answered?since=${encodeURIComponent(later)}`))).data).toEqual([]);
  });

  it('pages a long list with a cursor, and shows a hand-marked answer without a comment', async () => {
    const before = new Date().toISOString();
    const made: string[] = [];
    for (let i = 0; i < 3; i++) {
      const t = await newTask({ assigneeIds: [users.member!.userId] });
      made.push((await json(ask(bot(), t.id, { question: `Q${i}?` }))).id);
      await member().post(`/tasks/${t.id}/question/answered`);
    }
    const { listAnswered } = await import('../domains/projects/questions');
    const { buildAccessContext } = await import('../core/access');
    const { loadRolePermissions } = await import('../core/rbac');
    const [row] = await getDb().db.select().from(schema.users).where(eq(schema.users.id, botId));
    const actor = {
      userId: botId, actorType: 'agent' as const, roleId: row!.roleId, roleName: 'agent', email: '', name: '', locale: 'en', timezone: 'UTC',
      readOnly: false, tokenScopes: null, access: await buildAccessContext(botId, await loadRolePermissions(row!.roleId), false, 'agent'),
    };
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: { data: { id: string; answer: unknown }[]; nextCursor: string | null } = await listAnswered(actor, { since: new Date(before), cursor, limit: 2 });
      seen.push(...page.data.map((q) => q.id));
      for (const q of page.data) expect(q.answer).toBeNull();
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(made);
    // Over HTTP the cursor comes back when a page is full.
    expect((await bot().get('/me/questions/answered?cursor=bogus')).status).toBe(400);
  });

  it('drops a task the asker can no longer open', async () => {
    const type = await json(owner().post('/project-types', { name: 'Leaving type', revenueSource: 'none' }));
    const p = await json(owner().post('/projects', { name: 'Leaving', key: 'LVG', projectTypeId: type.id, visibility: 'private' }));
    await addProjectMember(users, p.id, botId, 'member');
    await addProjectMember(users, p.id, users.member!.userId, 'member');
    const t = await newTask({ assigneeIds: [users.member!.userId] }, p.id);
    const q = await json(ask(bot(), t.id, {}));
    await member().post(`/tasks/${t.id}/comments`, { body: doc('Done') });
    const ids = () => json(bot().get('/me/questions/answered')).then((r) => r.data.map((x: { id: string }) => x.id));
    expect(await ids()).toContain(q.id);
    await owner().del(`/projects/${p.id}/members/${botId}`);
    expect(await ids()).not.toContain(q.id);
  });
});

describe('telling the addressee', () => {
  it('reaches the owner of the personal agent that asked, past its quiet rule', async () => {
    const t = await newTask({ assigneeIds: [users.member!.userId] });
    await ask(mine(), t.id, {});
    // Its routine work stays quiet for its owner…
    await mine().post(`/tasks/${t.id}/comments`, { body: doc('Progress note') });
    await drainOutbox();
    expect(await notificationsOf(users.member!.userId, 'comment.created')).toHaveLength(0);
    // …but the question is what the owner wants to see.
    const rows = await notificationsOf(users.member!.userId, 'task.input_requested');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toMatchObject({ taskId: t.id, question: 'Which colour should the button be?' });
    // The asker hears nothing back.
    await member().post(`/tasks/${t.id}/comments`, { body: doc('Blue') });
    await drainOutbox();
    const all = await getDb().db.select().from(schema.notifications).where(eq(schema.notifications.userId, mineId));
    expect(all).toHaveLength(0);
  });

  it('never reaches someone who can no longer open the project', async () => {
    const type = await json(owner().post('/project-types', { name: 'Gate type', revenueSource: 'none' }));
    const p = await json(owner().post('/projects', { name: 'Gated', key: 'GTE', projectTypeId: type.id, visibility: 'private' }));
    await addProjectMember(users, p.id, users.member!.userId, 'member');
    const t = await newTask({}, p.id);
    expect((await ask(owner(), t.id, { addresseeId: users.member!.userId })).status).toBe(201);
    await owner().del(`/projects/${p.id}/members/${users.member!.userId}`);
    await drainOutbox();
    expect(await notificationsOf(users.member!.userId, 'task.input_requested')).toHaveLength(0);
  });
});

describe('when the addressee can no longer answer', () => {
  it('tells nobody about a question a move withdrew before it was delivered', async () => {
    const type = await json(owner().post('/project-types', { name: 'Late type', revenueSource: 'none' }));
    const target = await json(owner().post('/projects', { name: 'Late', key: 'LTE', projectTypeId: type.id, visibility: 'private' }));
    const t = await newTask({ assigneeIds: [users.member!.userId] });
    await ask(owner(), t.id, { addresseeId: users.member!.userId });
    await owner().post(`/tasks/${t.id}/move`, { targetProjectId: target.id });
    await drainOutbox();
    expect(await notificationsOf(users.member!.userId, 'task.input_requested')).toHaveLength(0);
  });

  it('withdraws what waits on someone removed from a private project', async () => {
    const type = await json(owner().post('/project-types', { name: 'Removal type', revenueSource: 'none' }));
    const p = await json(owner().post('/projects', { name: 'Removal', key: 'RMV', projectTypeId: type.id, visibility: 'private' }));
    await addProjectMember(users, p.id, users.member!.userId, 'member');
    const t = await newTask({}, p.id);
    const q = await json(ask(owner(), t.id, { addresseeId: users.member!.userId }));
    await owner().del(`/projects/${p.id}/members/${users.member!.userId}`);
    const [row] = await getDb().db.select().from(schema.taskQuestions).where(eq(schema.taskQuestions.id, q.id));
    expect(row!.status).toBe('withdrawn');
  });

  it('withdraws what waits on someone deactivated', async () => {
    const t = await newTask({ assigneeIds: [users.finance!.userId] });
    const q = await json(ask(owner(), t.id, { addresseeId: users.finance!.userId }));
    const res = await owner().post(`/users/${users.finance!.userId}/deactivate`, {});
    expect(res.status).toBe(200);
    const [row] = await getDb().db.select().from(schema.taskQuestions).where(eq(schema.taskQuestions.id, q.id));
    expect(row!.status).toBe('withdrawn');
  });
});

describe('the lists', () => {
  it('mark a waiting task and filter to what waits on me', async () => {
    const waiting = await newTask({ assigneeIds: [users.member!.userId], title: 'Waits on the member' });
    await newTask({ assigneeIds: [users.member!.userId], title: 'Does not wait' });
    await ask(bot(), waiting.id, {});
    const all = (await json(member().get(`/tasks?projectId=${ws.projectId}&limit=200`))).data as { id: string; waitingOnUserId: string | null }[];
    expect(all.find((t) => t.id === waiting.id)?.waitingOnUserId).toBe(users.member!.userId);
    const mineOnly = (await json(member().get(`/tasks?projectId=${ws.projectId}&waitingOn=me`))).data as { id: string }[];
    expect(mineOnly.map((t) => t.id)).toContain(waiting.id);
    expect(mineOnly.every((t) => all.find((a) => a.id === t.id)?.waitingOnUserId === users.member!.userId)).toBe(true);
    // A personal agent's "me" is its owner, as in my tasks.
    const forAgent = (await json(mine().get(`/tasks?projectId=${ws.projectId}&waitingOn=me`))).data as { id: string }[];
    expect(forAgent.map((t) => t.id)).toContain(waiting.id);
  });

  it('follow a moved task, and withdraw a question whose addressee cannot follow', async () => {
    const type = await json(owner().post('/project-types', { name: 'Move type', revenueSource: 'none' }));
    const target = await json(owner().post('/projects', { name: 'Target', key: 'TGT', projectTypeId: type.id, visibility: 'private' }));
    const t = await newTask({ assigneeIds: [users.member!.userId] });
    const q = await json(ask(owner(), t.id, { addresseeId: users.member!.userId }));
    const moved = await json(owner().post(`/tasks/${t.id}/move`, { targetProjectId: target.id }));
    const [row] = await getDb().db.select().from(schema.taskQuestions).where(eq(schema.taskQuestions.id, q.id));
    expect(row).toMatchObject({ taskId: moved.id, status: 'withdrawn' });
  });
});
