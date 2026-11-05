/**
 * Project resources: links, files and KB pages in one ordered list.
 *
 * A file joins the list by being uploaded onto the project and leaves it by
 * being deleted either way; a page joins by id and stays out of the list of
 * anyone who cannot open it – title included.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { ulid } from 'ulid';
import { resetDb, seedRolesAndUsers, reqAs, json, app } from './helpers';

vi.mock('../lib/s3', () => import('./s3-mock'));

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
let projectId: string;
let owner: ReturnType<typeof reqAs>;

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
  owner = reqAs(users.owner!.cookie);
  const type = await json(owner.post('/project-types', { name: 'Delivery', revenueSource: 'none' }));
  projectId = (await json(owner.post('/projects', { name: 'Launch', key: 'LCH', projectTypeId: type.id }))).id;
  // `member` works on the project but is no editor of the private KB space below.
  await json(owner.post(`/projects/${projectId}/members`, { userId: users.member!.userId, role: 'member', canWriteTasks: true }));
});

const list = async (who = owner) => (await json(who.get(`/projects/${projectId}/resources`))).data as any[];

function uploadForm(filename: string) {
  const fd = new FormData();
  fd.append('file', new File([new Uint8Array([1, 2, 3])], filename, { type: 'application/pdf' }), filename);
  fd.append('entityType', 'project');
  fd.append('entityId', projectId);
  return fd;
}

describe('links', () => {
  it('adds, edits and lists a link', async () => {
    const created = await owner.post(`/projects/${projectId}/resources`, { kind: 'link', label: 'Figma', url: 'https://figma.com/file/x' });
    expect(created.status).toBe(201);
    const link = await json(created);
    expect(link).toMatchObject({ kind: 'link', label: 'Figma', url: 'https://figma.com/file/x' });

    const edited = await json(owner.patch(`/project-resources/${link.id}`, { label: 'Figma designs' }));
    expect(edited.label).toBe('Figma designs');
    expect((await list()).find((r) => r.id === link.id).label).toBe('Figma designs');
  });

  it('takes http(s) links only', async () => {
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'not a url']) {
      const res = await owner.post(`/projects/${projectId}/resources`, { kind: 'link', label: 'Bad', url });
      expect(res.status).toBe(400);
    }
  });
});

describe('files', () => {
  it('lists a file uploaded onto the project, renamed through the attachment', async () => {
    const { id: attachmentId } = await json(owner.postForm('/attachments', uploadForm('brief.pdf')));
    const row = (await list()).find((r) => r.kind === 'file' && r.file.id === attachmentId);
    expect(row).toMatchObject({ label: 'brief.pdf', file: { filename: 'brief.pdf', mime: 'application/pdf' } });

    await owner.patch(`/attachments/${attachmentId}`, { filename: 'Brief v2.pdf' });
    expect((await list()).find((r) => r.id === row.id).label).toBe('Brief v2.pdf');
    // A file's name is the attachment's: the resource itself takes no label.
    expect((await owner.patch(`/project-resources/${row.id}`, { label: 'x' })).status).toBe(400);
  });

  it('removing a file resource deletes the file', async () => {
    const { id: attachmentId } = await json(owner.postForm('/attachments', uploadForm('old.pdf')));
    const row = (await list()).find((r) => r.file?.id === attachmentId);
    expect((await owner.del(`/project-resources/${row.id}`)).status).toBe(200);
    expect((await owner.get(`/attachments/${attachmentId}/url`)).status).toBe(404);
  });

  it('deleting the file drops its resource', async () => {
    const { id: attachmentId } = await json(owner.postForm('/attachments', uploadForm('gone.pdf')));
    await owner.del(`/attachments/${attachmentId}`);
    expect((await list()).some((r) => r.file?.id === attachmentId)).toBe(false);
  });
});

describe('knowledge-base pages', () => {
  let openPage: string;
  let hiddenPage: string;

  beforeAll(async () => {
    const open = (await json(owner.post('/spaces', { name: 'Handbook', visibility: 'workspace' }))).id;
    const closed = (await json(owner.post('/spaces', { name: 'Leadership', visibility: 'private' }))).id;
    openPage = (await json(owner.post('/pages', { spaceId: open, title: 'Release checklist' }))).id;
    hiddenPage = (await json(owner.post('/pages', { spaceId: closed, title: 'Pricing strategy' }))).id;
  });

  it('pins a page under its title, once', async () => {
    const res = await owner.post(`/projects/${projectId}/resources`, { kind: 'kb_page', kbPageId: openPage });
    expect(res.status).toBe(201);
    expect(await json(res)).toMatchObject({ kind: 'kb_page', label: 'Release checklist', page: { id: openPage } });
    expect((await owner.post(`/projects/${projectId}/resources`, { kind: 'kb_page', kbPageId: openPage })).status).toBe(422);
  });

  it('keeps a page out of the list of whoever cannot open it', async () => {
    await owner.post(`/projects/${projectId}/resources`, { kind: 'kb_page', kbPageId: hiddenPage });
    expect((await list()).some((r) => r.page?.id === hiddenPage)).toBe(true);
    const memberList = await list(reqAs(users.member!.cookie));
    expect(memberList.some((r) => r.page?.id === hiddenPage)).toBe(false);
    expect(JSON.stringify(memberList)).not.toContain('Pricing strategy');
  });

  it('refuses to pin a page the actor cannot open, or one that does not exist', async () => {
    const member = reqAs(users.member!.cookie);
    expect((await member.post(`/projects/${projectId}/resources`, { kind: 'kb_page', kbPageId: hiddenPage })).status).toBe(404);
    expect((await owner.post(`/projects/${projectId}/resources`, { kind: 'kb_page', kbPageId: ulid() })).status).toBe(404);
  });

  it('keeps a hidden page\'s title out of the project activity', async () => {
    const row = (await list()).find((r) => r.page?.id === hiddenPage);
    await owner.del(`/project-resources/${row.id}`);
    // `member` is on the project and reads its trail, but not the private space.
    const trail = await json(reqAs(users.member!.cookie).get(`/audit/entity/project/${projectId}`));
    expect(JSON.stringify(trail)).not.toContain('Pricing strategy');
    // It was pinned and unpinned all the same.
    const actions = (trail.data as any[]).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['resource_added', 'resource_removed']));
    await owner.post(`/projects/${projectId}/resources`, { kind: 'kb_page', kbPageId: hiddenPage });
  });

  it('unpinning leaves the page itself alone', async () => {
    const row = (await list()).find((r) => r.page?.id === openPage);
    expect((await owner.del(`/project-resources/${row.id}`)).status).toBe(200);
    expect((await owner.get(`/pages/${openPage}`)).status).toBe(200);
  });
});

describe('order', () => {
  it('reorders by the ids sent and keeps hidden rows after them', async () => {
    const before = await list();
    const reversed = before.map((r) => r.id).reverse();
    const after = (await json(owner.put(`/projects/${projectId}/resources/order`, { ids: reversed }))).data as any[];
    expect(after.map((r) => r.id)).toEqual(reversed);

    // A member who cannot see the hidden page reorders what they see; the page keeps a place.
    const member = reqAs(users.member!.cookie);
    const seen = (await list(member)).map((r) => r.id);
    await member.put(`/projects/${projectId}/resources/order`, { ids: [...seen].reverse() });
    expect((await list()).length).toBe(before.length);
  });
});

describe('access', () => {
  it('refuses writes over a read-only token', async () => {
    const minted = await json(owner.post('/auth/tokens', { name: 'ro', scopes: ['projects.read', 'projects.write'], readOnly: true }));
    const headers = { authorization: `Bearer ${minted.token}`, 'content-type': 'application/json' };
    const post = await app.request(`/api/v1/projects/${projectId}/resources`, {
      method: 'POST', headers, body: JSON.stringify({ kind: 'link', label: 'x', url: 'https://x.dev' }),
    });
    expect(post.status).toBe(403);
    const get = await app.request(`/api/v1/projects/${projectId}/resources`, { headers });
    expect(get.status).toBe(200);
  });

  it('is membership-gated', async () => {
    const guest = reqAs(users.guest!.cookie);
    expect((await guest.get(`/projects/${projectId}/resources`)).status).toBe(404);
    expect((await guest.post(`/projects/${projectId}/resources`, { kind: 'link', label: 'x', url: 'https://x.dev' })).status).toBe(404);
  });

  it('logs additions and removals on the project', async () => {
    const link = await json(owner.post(`/projects/${projectId}/resources`, { kind: 'link', label: 'Staging', url: 'https://staging.example.com' }));
    await owner.del(`/project-resources/${link.id}`);
    const audit = (await json(owner.get(`/audit/entity/project/${projectId}`))).data as any[];
    const actions = audit.map((a) => a.action);
    expect(actions).toContain('resource_added');
    expect(actions).toContain('resource_removed');
  });
});
