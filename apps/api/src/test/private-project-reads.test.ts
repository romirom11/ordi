/**
 * A private project stays private on the read routes that hang off it but
 * check something else first: a workspace capability (kb.manage_spaces,
 * agents.manage, settings.manage), a space, a file or a related task.
 *
 * Two people hold the same broad role – every one of those capabilities, but
 * no audit.read – and differ only in being on the private project. The
 * outsider must learn nothing about it (not its key, its task refs, its file
 * names, its fields or its notes); the member must see what they always saw.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { getDb, schema, eq } from '@ordi/db';
import { ulid } from 'ulid';
import { resetDb, seedRolesAndUsers, reqAs, json } from './helpers';
import { generateToken } from '../lib/crypto';

vi.mock('../lib/s3', () => import('./s3-mock'));

const BROAD = [
  'projects.read', 'crm.read', 'kb.read', 'kb.write', 'kb.manage_spaces', 'agents.manage', 'settings.manage',
  'time.read_all', 'integrations.manage',
];

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
let owner: ReturnType<typeof reqAs>;
let insider: { userId: string; as: ReturnType<typeof reqAs> };
let outsider: { userId: string; as: ReturnType<typeof reqAs> };
let roleId = '';

let openProject = '';
let secretProject = '';
let openTask = '';
let secretTask = '';

async function person(name: string) {
  const { db } = getDb();
  const userId = ulid();
  await db.insert(schema.users).values({ id: userId, email: `${userId}@test.local`, name, passwordHash: 'x', roleId });
  const token = generateToken();
  await db.insert(schema.sessions).values({ id: ulid(), userId, token, expiresAt: new Date(Date.now() + 3600_000) });
  return { userId, as: reqAs(`ordi_session=${token}`) };
}

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
  owner = reqAs(users.owner!.cookie);
  const { db } = getDb();
  roleId = ulid();
  await db.insert(schema.roles).values({ id: roleId, key: `broad-${roleId}`, name: 'Broad', description: 'custom', isSystem: false });
  await db.insert(schema.rolePermissions).values(BROAD.map((p) => ({ roleId, permission: p as any })));
  insider = await person('Insider');
  outsider = await person('Outsider');

  const typeId = (await json(owner.post('/project-types', { name: 'Leaks', revenueSource: 'none' }))).id;
  openProject = (await json(owner.post('/projects', { name: 'Open', key: 'OPN', projectTypeId: typeId, visibility: 'workspace' }))).id;
  secretProject = (await json(owner.post('/projects', { name: 'Skunkworks', key: 'SKW', projectTypeId: typeId, visibility: 'private' }))).id;
  expect((await owner.post(`/projects/${secretProject}/members`, { userId: insider.userId, role: 'member', canWriteTasks: true })).status).toBe(201);
  openTask = (await json(owner.post('/tasks', { projectId: openProject, title: 'Public chore' }))).id;
  secretTask = (await json(owner.post('/tasks', { projectId: secretProject, title: 'Launch codename Falcon' }))).id;
});

describe('KB: a private project\'s space', () => {
  let space = '';
  beforeAll(async () => {
    // Workspace visibility is the default for a new space.
    space = (await json(owner.post('/spaces', { name: 'Skunkworks notes', projectId: secretProject, visibility: 'workspace' }))).id;
    await owner.post('/pages', { spaceId: space, title: 'Falcon launch plan' });
  });

  it('is not listed or opened through kb.read, however the space is set', async () => {
    const listed = (await json(outsider.as.get('/spaces'))).data as { id: string }[];
    expect(listed.some((s) => s.id === space)).toBe(false);
    expect((await outsider.as.get(`/spaces/${space}`)).status).toBe(404);
    expect((await outsider.as.get(`/spaces/${space}/pages`)).status).toBe(404);
  });

  it('is not the kb.manage_spaces holder\'s to manage, rename or join', async () => {
    expect((await outsider.as.get(`/spaces/${space}/members`)).status).toBe(404);
    expect((await outsider.as.patch(`/spaces/${space}`, { name: 'Renamed' })).status).toBe(404);
    expect((await outsider.as.post(`/spaces/${space}/members`, { userId: outsider.userId, role: 'editor' })).status).toBe(404);
    // ...so no self-added membership opens the pages either.
    expect((await outsider.as.get(`/spaces/${space}/pages`)).status).toBe(404);
  });

  it('cannot be pulled out of the project by someone who does not run it', async () => {
    const { version } = await json(insider.as.get(`/spaces/${space}`));
    expect((await insider.as.patch(`/spaces/${space}`, { projectId: null, version })).status).toBe(403);
  });

  it('stays open to the project\'s member', async () => {
    const listed = (await json(insider.as.get('/spaces'))).data as { id: string }[];
    expect(listed.some((s) => s.id === space)).toBe(true);
    const pages = (await json(insider.as.get(`/spaces/${space}/pages`))).data as { title: string }[];
    expect(pages.map((p) => p.title)).toContain('Falcon launch plan');
    expect((await insider.as.get(`/spaces/${space}/members`)).status).toBe(200);
  });

  it('closes to someone taken off the project, whatever space membership they kept', async () => {
    const leaver = await person('Leaver');
    expect((await owner.post(`/projects/${secretProject}/members`, { userId: leaver.userId, role: 'member', canWriteTasks: true })).status).toBe(201);
    expect((await owner.post(`/spaces/${space}/members`, { userId: leaver.userId, role: 'editor' })).status).toBe(201);
    expect((await leaver.as.get(`/spaces/${space}/pages`)).status).toBe(200);
    expect((await owner.del(`/projects/${secretProject}/members/${leaver.userId}`)).status).toBe(200);
    expect((await leaver.as.get(`/spaces/${space}`)).status).toBe(404);
    expect((await leaver.as.get(`/spaces/${space}/pages`)).status).toBe(404);
    const listed = (await json(leaver.as.get('/spaces'))).data as { id: string }[];
    expect(listed.some((s) => s.id === space)).toBe(false);
  });

  it('a workspace project\'s space still opens through kb rights and kb.manage_spaces', async () => {
    const openSpace = (await json(owner.post('/spaces', { name: 'Open notes', projectId: openProject, visibility: 'workspace' }))).id;
    expect((await outsider.as.get(`/spaces/${openSpace}`)).status).toBe(200);
    expect((await outsider.as.get(`/spaces/${openSpace}/members`)).status).toBe(200);
  });
});

describe('activity of a file in a private project', () => {
  let fileId = '';
  beforeAll(async () => {
    const fd = new FormData();
    fd.append('file', new File([new Uint8Array([1, 2, 3])], 'falcon-pricing.pdf', { type: 'application/pdf' }), 'falcon-pricing.pdf');
    fd.append('entityType', 'task');
    fd.append('entityId', secretTask);
    const res = await owner.postForm('/attachments', fd);
    expect(res.status).toBe(201);
    fileId = (await json(res)).id;
  });

  const namesFile = (rows: { entityType: string; entityId: string }[]) =>
    rows.some((r) => r.entityType === 'attachment' && r.entityId === fileId);

  it('is not on the outsider\'s home feed or entity trail', async () => {
    expect(namesFile((await json(outsider.as.get('/dashboard'))).recentActivity)).toBe(false);
    expect(namesFile((await json(outsider.as.get(`/audit/entity/attachment/${fileId}`))).data)).toBe(false);
  });

  it('is on the member\'s', async () => {
    expect(namesFile((await json(insider.as.get('/dashboard'))).recentActivity)).toBe(true);
    expect(namesFile((await json(insider.as.get(`/audit/entity/attachment/${fileId}`))).data)).toBe(true);
  });

  it('stays hidden once the file is deleted (read from its created record)', async () => {
    expect((await owner.del(`/attachments/${fileId}`)).status).toBe(200);
    const trail = (await json(outsider.as.get(`/audit/entity/attachment/${fileId}`))).data;
    expect(namesFile(trail)).toBe(false);
    const forMember = (await json(insider.as.get(`/audit/entity/attachment/${fileId}`))).data as { action: string }[];
    expect(forMember.map((r) => r.action).sort()).toEqual(['created', 'deleted']);
  });
});

describe('a file whose task moved into a private project', () => {
  it('takes its later trail with it, once deleted', async () => {
    const moving = (await json(owner.post('/tasks', { projectId: openProject, title: 'To be moved' }))).id;
    const fd = new FormData();
    fd.append('file', new File([new Uint8Array([1])], 'draft.pdf', { type: 'application/pdf' }), 'draft.pdf');
    fd.append('entityType', 'task');
    fd.append('entityId', moving);
    const fileId = (await json(owner.postForm('/attachments', fd))).id;
    expect((await owner.post(`/tasks/${moving}/move`, { targetProjectId: secretProject })).status).toBe(200);
    expect((await owner.patch(`/attachments/${fileId}`, { filename: 'falcon-term-sheet.pdf' })).status).toBe(200);
    expect((await owner.del(`/attachments/${fileId}`)).status).toBe(200);
    const trail = (await json(outsider.as.get(`/audit/entity/attachment/${fileId}`))).data;
    expect(JSON.stringify(trail)).not.toContain('falcon-term-sheet');
    const forMember = (await json(insider.as.get(`/audit/entity/attachment/${fileId}`))).data as { action: string }[];
    expect(forMember.map((r) => r.action).sort()).toEqual(['created', 'deleted', 'updated']);
  });
});

describe('agents on a private project', () => {
  it('do not name it to an agents.manage holder outside it', async () => {
    const res = await owner.post('/agents', { name: 'Falcon bot', runtime: 'claude_code' });
    expect(res.status).toBe(201);
    const agentId = (await json(res)).id;
    expect((await owner.post(`/projects/${secretProject}/members`, { userId: agentId, role: 'member', canWriteTasks: true })).status).toBe(201);
    const seen = async (who: typeof outsider) => {
      const list = (await json(who.as.get('/agents'))).data as { id: string; projectIds: string[] }[];
      const one = await json(who.as.get(`/agents/${agentId}`));
      return [list.find((a) => a.id === agentId)!.projectIds, one.projectIds];
    };
    expect(await seen(outsider)).toEqual([[], []]);
    expect(await seen(insider)).toEqual([[secretProject], [secretProject]]);
  });
});

describe('shared saved views of a private project', () => {
  it('are listed only for those who can open it, and none can be saved onto it from outside', async () => {
    const res = await insider.as.post('/saved-views', { entityType: 'tasks', name: 'Falcon blockers', isShared: true, projectId: secretProject });
    expect(res.status).toBe(201);
    const viewId = (await json(res)).id;
    const ids = async (who: typeof outsider) => ((await json(who.as.get('/saved-views'))).data as { id: string }[]).map((v) => v.id);
    expect(await ids(outsider)).not.toContain(viewId);
    expect(await ids(insider)).toContain(viewId);
    expect((await outsider.as.post('/saved-views', { entityType: 'tasks', name: 'Probe', projectId: secretProject })).status).toBe(404);
  });
});

describe('activity of a file on an intake item', () => {
  let fileId = '';
  beforeAll(async () => {
    const { db } = getDb();
    const itemId = ulid();
    await db.insert(schema.intakeItems).values({ id: itemId, projectId: openProject, source: 'email', status: 'pending', title: 'Request', description: '' });
    expect((await owner.post(`/projects/${openProject}/members`, { userId: insider.userId, role: 'member', canWriteTasks: true })).status).toBe(201);
    const fd = new FormData();
    fd.append('file', new File([new Uint8Array([1])], 'client-brief.pdf', { type: 'application/pdf' }), 'client-brief.pdf');
    fd.append('entityType', 'intake_item');
    fd.append('entityId', itemId);
    const res = await owner.postForm('/attachments', fd);
    expect(res.status).toBe(201);
    fileId = (await json(res)).id;
  });

  it('follows the triage queue: a workspace viewer does not see it, a project member does', async () => {
    const trail = (id: string, who: typeof outsider) => json(who.as.get(`/audit/entity/attachment/${id}`));
    expect((await trail(fileId, outsider)).data).toEqual([]);
    expect((await trail(fileId, insider)).data).toHaveLength(1);
  });
});

describe('relations to a task in a private project', () => {
  beforeAll(async () => {
    // The owner is on both projects and links them.
    expect((await owner.post(`/tasks/${openTask}/relations`, { relatedTaskId: secretTask, type: 'blocks' })).status).toBe(201);
    expect((await owner.post(`/tasks/${secretTask}/relations`, { relatedTaskId: openTask, type: 'relates' })).status).toBe(201);
  });

  it('are left out of the task for someone who cannot open the other end', async () => {
    const task = await json(outsider.as.get(`/tasks/${openTask}?include=relations`));
    expect(task.relations.outgoing).toEqual([]);
    expect(task.relations.incoming).toEqual([]);
    expect(JSON.stringify(task)).not.toContain('SKW');
    expect(JSON.stringify(task)).not.toContain(secretTask);
  });

  it('are all there for a member of both', async () => {
    const task = await json(insider.as.get(`/tasks/${openTask}?include=relations`));
    expect(task.relations.outgoing.map((r: { relatedRef: string }) => r.relatedRef)).toEqual(['SKW-1']);
    expect(task.relations.incoming.map((r: { relatedRef: string }) => r.relatedRef)).toEqual(['SKW-1']);
  });
});

describe('agent runs across tasks', () => {
  beforeAll(async () => {
    const { db } = getDb();
    const agentId = ulid();
    await db.insert(schema.users).values({ id: agentId, email: `${agentId}@agents.local`, name: 'Bot', passwordHash: 'x', roleId, actorType: 'agent' });
    await db.insert(schema.agentRuns).values([
      { id: ulid(), agentUserId: agentId, taskId: openTask, projectId: openProject, trigger: 'assigned', status: 'failed', runtime: 'claude_code' },
      { id: ulid(), agentUserId: agentId, taskId: secretTask, projectId: secretProject, trigger: 'assigned', status: 'failed', runtime: 'claude_code' },
    ]);
  });

  it('list only runs in projects the agents.manage holder can open', async () => {
    const runs = (await json(outsider.as.get('/agent-runs'))).data as { projectId: string }[];
    expect(runs.map((r) => r.projectId)).toEqual([openProject]);
  });

  it('of one private task are a 404 for the outsider', async () => {
    expect((await outsider.as.get(`/agent-runs?taskId=${secretTask}`)).status).toBe(404);
    expect((await insider.as.get(`/agent-runs?taskId=${secretTask}`)).status).toBe(200);
  });

  it('list both for a member of the private project', async () => {
    const runs = (await json(insider.as.get('/agent-runs'))).data as { projectId: string }[];
    expect(runs.map((r) => r.projectId).sort()).toEqual([openProject, secretProject].sort());
  });
});

describe('a private project\'s custom fields', () => {
  let fieldId = '';
  beforeAll(async () => {
    const res = await owner.post('/custom-fields', {
      entityType: 'tasks', key: 'falcon_budget', label: 'Falcon budget', type: 'text', projectId: secretProject,
    });
    expect(res.status).toBe(201);
    fieldId = (await json(res)).id;
  });

  it('are a 404 for someone who cannot open the project', async () => {
    expect((await outsider.as.get(`/custom-fields?entityType=tasks&projectId=${secretProject}`)).status).toBe(404);
  });

  it('do not narrate themselves through settings.manage activity', async () => {
    const trail = (await json(outsider.as.get(`/audit/entity/custom_field/${fieldId}`))).data;
    expect(trail).toEqual([]);
    const feed = (await json(outsider.as.get('/dashboard'))).recentActivity as { entityId: string }[];
    expect(feed.some((r) => r.entityId === fieldId)).toBe(false);
  });

  it('stay hidden once the field is deleted (read from its created record)', async () => {
    const res = await owner.post('/custom-fields', { entityType: 'tasks', key: 'falcon_gone', label: 'Gone', type: 'text', projectId: secretProject });
    const goneId = (await json(res)).id;
    expect((await owner.del(`/custom-fields/${goneId}`)).status).toBe(200);
    expect((await json(outsider.as.get(`/audit/entity/custom_field/${goneId}`))).data).toEqual([]);
    expect((await json(insider.as.get(`/audit/entity/custom_field/${goneId}`))).data).toHaveLength(2);
  });

  it('read as before for the member, workspace fields for everyone', async () => {
    const forMember = (await json(insider.as.get(`/custom-fields?entityType=tasks&projectId=${secretProject}`))).data as { key: string }[];
    expect(forMember.map((f) => f.key)).toContain('falcon_budget');
    expect((await json(insider.as.get(`/audit/entity/custom_field/${fieldId}`))).data).toHaveLength(1);
    expect((await outsider.as.get('/custom-fields?entityType=tasks')).status).toBe(200);
    expect((await outsider.as.get(`/custom-fields?entityType=tasks&projectId=${openProject}`)).status).toBe(200);
  });
});

describe('time logged on a private project', () => {
  it('does not narrate itself through time.read_all activity, before or after it is deleted', async () => {
    const res = await owner.post('/time/entries', { taskId: secretTask, startedAt: new Date().toISOString(), durationSeconds: 600, note: 'Falcon pricing call' });
    expect(res.status).toBe(201);
    const entryId = (await json(res)).id;
    const trail = async (who: typeof outsider) => (await json(who.as.get(`/audit/entity/time_entry/${entryId}`))).data as unknown[];
    expect(await trail(outsider)).toEqual([]);
    expect(await trail(insider)).toHaveLength(1);
    expect((await owner.del(`/time/entries/${entryId}`)).status).toBe(200);
    expect(await trail(outsider)).toEqual([]);
    expect(await trail(insider)).toHaveLength(2);
  });
});

describe('secret provider connections', () => {
  it('name only the projects the integrations.manage holder can open, and keep the others on save', async () => {
    const { db } = getDb();
    const id = ulid();
    await db.insert(schema.secretProviderConnections).values({ id, kind: 'doppler', label: 'Doppler', credentials: 'x' });
    await db.insert(schema.projectSecretProviderLinks).values([
      { projectId: openProject, connectionId: id }, { projectId: secretProject, connectionId: id },
    ]);
    const linked = async (who: typeof outsider) =>
      ((await json(who.as.get('/secret-providers'))).data as { id: string; projectIds: string[] }[]).find((c) => c.id === id)!.projectIds.sort();
    expect(await linked(outsider)).toEqual([openProject]);
    expect(await linked(insider)).toEqual([openProject, secretProject].sort());
    // The outsider saves the list it was shown, minus the open project: the hidden link stays.
    expect((await outsider.as.put(`/secret-providers/${id}/projects`, { projectIds: [] })).status).toBe(200);
    expect(await linked(insider)).toEqual([secretProject]);
    // ...and a project it cannot open is one that does not exist.
    expect((await outsider.as.put(`/secret-providers/${id}/projects`, { projectIds: [secretProject] })).status).toBe(400);
  });
});

describe('an older trail of a file whose task moved', () => {
  it('follows the task to where it went, even without the record named on the delete', async () => {
    const moving = (await json(owner.post('/tasks', { projectId: openProject, title: 'Legacy move' }))).id;
    const fd = new FormData();
    fd.append('file', new File([new Uint8Array([1])], 'legacy.pdf', { type: 'application/pdf' }), 'legacy.pdf');
    fd.append('entityType', 'task');
    fd.append('entityId', moving);
    const fileId = (await json(owner.postForm('/attachments', fd))).id;
    expect((await owner.post(`/tasks/${moving}/move`, { targetProjectId: secretProject })).status).toBe(200);
    // A delete written before deletes named their record: only the file name.
    const { db } = getDb();
    await db.delete(schema.attachments).where(eq(schema.attachments.id, fileId));
    await db.insert(schema.activityLog).values({ id: ulid(), entityType: 'attachment', entityId: fileId, action: 'deleted', diff: { file: { from: 'falcon-legacy.pdf' } }, actorType: 'user' });
    const trail = (await json(outsider.as.get(`/audit/entity/attachment/${fileId}`))).data;
    expect(trail).toEqual([]);
    expect((await json(insider.as.get(`/audit/entity/attachment/${fileId}`))).data).toHaveLength(2);
  });
});
