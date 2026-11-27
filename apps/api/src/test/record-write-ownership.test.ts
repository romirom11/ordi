/**
 * Writes that change a record someone else made must ask whose it is, not
 * only whether the caller holds the workspace permission for that kind of
 * record. Covers the files of a document or a project (rename, delete, and
 * re-binding a loose file to an employee or a KB page), the widgets of a
 * dashboard, and shared saved views. Each rule is shown both ways: the other
 * user is refused, the owner (and the admin the rule names) still gets through.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { resetDb, seedRolesAndUsers, reqAs, json } from './helpers';

vi.mock('../lib/s3', () => import('./s3-mock'));

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
const as = (key: string) => reqAs(users[key]!.cookie);

const PDF_BYTES = new TextEncoder().encode('%PDF-1.4\n%fake\n');

async function upload(key: string, opts: { entityType?: string; entityId?: string; filename?: string } = {}) {
  const filename = opts.filename ?? 'brief.pdf';
  const fd = new FormData();
  fd.append('file', new File([PDF_BYTES], filename, { type: 'application/pdf' }), filename);
  if (opts.entityType) fd.append('entityType', opts.entityType);
  if (opts.entityId) fd.append('entityId', opts.entityId);
  return as(key).postForm('/attachments', fd);
}
async function uploadId(key: string, opts: Parameters<typeof upload>[1] = {}): Promise<string> {
  const res = await upload(key, opts);
  expect(res.status).toBe(201);
  return (await json(res)).id as string;
}

let projectId: string;
let taskId: string;

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
  const owner = as('owner');
  const type = await json(owner.post('/project-types', { name: 'Delivery', revenueSource: 'none' }));
  projectId = (await json(owner.post('/projects', { name: 'Delivery', key: 'DLV', projectTypeId: type.id }))).id;
  // Two plain members: neither role holds projects.write, so the membership
  // row is their whole standing on the project. The owner is its admin.
  for (const key of ['member', 'sales']) {
    await json(owner.post(`/projects/${projectId}/members`, { userId: users[key]!.userId, role: 'member', canWriteTasks: true }));
  }
  taskId = (await json(owner.post('/tasks', { projectId, title: 'Ship it' }))).id;
});

describe('a file embedded in a document', () => {
  it('is deleted by its uploader only', async () => {
    const id = await uploadId('member');
    expect((await as('sales').del(`/attachments/${id}`)).status).toBe(403);
    expect((await as('member').del(`/attachments/${id}`)).status).toBe(200);
  });
});

describe('a file on a project or a task', () => {
  for (const kind of ['project', 'task'] as const) {
    const entity = () => ({ entityType: kind, entityId: kind === 'project' ? projectId : taskId });

    it(`(${kind}) cannot be renamed or deleted by another member`, async () => {
      const id = await uploadId('member', entity());
      expect((await as('sales').patch(`/attachments/${id}`, { filename: 'mine.pdf' })).status).toBe(403);
      expect((await as('sales').del(`/attachments/${id}`)).status).toBe(403);
      const list = await json(as('owner').get(`/attachments?entityType=${kind}&entityId=${entity().entityId}`));
      expect(list.data.find((f: any) => f.id === id).filename).toBe('brief.pdf');
    });

    it(`(${kind}) is still renamed and deleted by its uploader`, async () => {
      const id = await uploadId('member', entity());
      expect((await as('member').patch(`/attachments/${id}`, { filename: 'brief v2.pdf' })).status).toBe(200);
      expect((await as('member').del(`/attachments/${id}`)).status).toBe(200);
    });

    it(`(${kind}) is still renamed and deleted by a project admin`, async () => {
      const id = await uploadId('member', entity());
      expect((await as('owner').patch(`/attachments/${id}`, { filename: 'tidied.pdf' })).status).toBe(200);
      expect((await as('owner').del(`/attachments/${id}`)).status).toBe(200);
    });
  }

  it('is refused at upload when the record type names no record', async () => {
    expect((await upload('member', { entityType: 'project' })).status).toBe(400);
  });
});

describe('a file among a project’s resources', () => {
  const fileRow = async (attachmentId: string) => {
    const rows = (await json(as('owner').get(`/projects/${projectId}/resources`))).data as any[];
    return rows.find((r) => r.attachmentId === attachmentId || r.file?.id === attachmentId);
  };

  it('cannot be removed by another member, only by its uploader or a project admin', async () => {
    const mine = await uploadId('member', { entityType: 'project', entityId: projectId });
    const row = await fileRow(mine);
    expect(row).toBeTruthy();
    expect((await as('sales').del(`/project-resources/${row.id}`)).status).toBe(403);
    expect(await fileRow(mine)).toBeTruthy();
    expect((await as('member').del(`/project-resources/${row.id}`)).status).toBe(200);

    const theirs = await uploadId('member', { entityType: 'project', entityId: projectId });
    const other = await fileRow(theirs);
    expect((await as('owner').del(`/project-resources/${other.id}`)).status).toBe(200);
  });
});

describe('re-binding a loose file', () => {
  let employeeId: string;
  let spaceId: string;

  beforeAll(async () => {
    employeeId = (await json(as('owner').post('/employees', { firstName: 'Olena', lastName: 'K' }))).id;
    spaceId = (await json(as('owner').post('/spaces', { name: 'Handbook', visibility: 'workspace' }))).id;
  });

  it('files only your own upload as an employee document', async () => {
    const theirs = await uploadId('member');
    expect((await as('hr').post(`/employees/${employeeId}/documents`, { attachmentId: theirs })).status).toBe(400);
    // The file stays the uploader's: they can still rename it.
    expect((await as('member').patch(`/attachments/${theirs}`, { filename: 'still mine.pdf' })).status).toBe(200);

    const mine = await uploadId('hr');
    expect((await as('hr').post(`/employees/${employeeId}/documents`, { attachmentId: mine })).status).toBe(201);
  });

  it('shows only your own loose upload on a PDF page', async () => {
    const theirs = await uploadId('member');
    expect((await as('owner').post('/pages', { spaceId, title: 'Theirs', type: 'pdf', fileId: theirs })).status).toBe(400);

    // An employee's document is not a page's to republish, not even by the
    // one who uploaded and filed it.
    const contract = await uploadId('admin');
    expect((await as('admin').post(`/employees/${employeeId}/documents`, { attachmentId: contract })).status).toBe(201);
    expect((await as('admin').post('/pages', { spaceId, title: 'Contract', type: 'pdf', fileId: contract })).status).toBe(400);

    const mine = await uploadId('owner');
    const created = await as('owner').post('/pages', { spaceId, title: 'Policy', type: 'pdf', fileId: mine });
    expect(created.status).toBe(201);
    const pageId = (await json(created)).id;

    // Swapping the document: someone else's is refused, the current one and a fresh own upload are not.
    let page = await json(as('owner').get(`/pages/${pageId}`));
    expect((await as('owner').patch(`/pages/${pageId}`, { fileId: theirs, version: page.version })).status).toBe(400);
    expect((await as('owner').patch(`/pages/${pageId}`, { fileId: mine, version: page.version })).status).toBe(200);
    page = await json(as('owner').get(`/pages/${pageId}`));
    const next = await uploadId('owner');
    expect((await as('owner').patch(`/pages/${pageId}`, { fileId: next, version: page.version })).status).toBe(200);
  });

  it('keeps a file off a page that is not a PDF page', async () => {
    const contract = await uploadId('hr');
    await as('hr').post(`/employees/${employeeId}/documents`, { attachmentId: contract });
    const created = await as('owner').post('/pages', { spaceId, title: 'Article', fileId: contract });
    expect(created.status).toBe(201);
    const page = await json(as('owner').get(`/pages/${(await json(created)).id}`));
    expect(page.fileId).toBeNull();
    expect(page.file).toBeUndefined();
  });
});

describe('dashboard widgets', () => {
  const widget = { widgetType: 'bar', source: 'tasks', config: { filters: {}, groupBy: 'status', metric: 'count' } };

  it('keep a private dashboard out of everyone else’s reach', async () => {
    const dash = (await json(as('owner').post('/dashboards', { name: 'Mine', visibility: 'private' }))).id;
    const w = (await json(as('owner').post(`/dashboards/${dash}/widgets`, widget))).id;
    expect((await as('member').get(`/dashboards/${dash}`)).status).toBe(404);
    expect((await as('member').post(`/dashboards/${dash}/widgets`, widget)).status).toBe(404);
    expect((await as('member').del(`/dashboards/${dash}/widgets/${w}`)).status).toBe(404);
    expect((await as('member').get(`/dashboards/${dash}/widgets/${w}/data`)).status).toBe(404);
  });

  it('on a shared dashboard are read by everyone and changed by its owner only', async () => {
    const dash = (await json(as('owner').post('/dashboards', { name: 'Team', visibility: 'workspace' }))).id;
    const w = (await json(as('owner').post(`/dashboards/${dash}/widgets`, widget))).id;

    const seen = await json(as('member').get(`/dashboards/${dash}`));
    expect(seen.canEdit).toBe(false);
    expect(seen.widgets).toHaveLength(1);
    expect((await as('member').get(`/dashboards/${dash}/widgets/${w}/data`)).status).toBe(200);
    expect((await as('member').post(`/dashboards/${dash}/widgets`, widget)).status).toBe(403);
    expect((await as('member').del(`/dashboards/${dash}/widgets/${w}`)).status).toBe(403);
    expect((await json(as('owner').get(`/dashboards/${dash}`))).widgets).toHaveLength(1);

    expect((await json(as('owner').get(`/dashboards/${dash}`))).canEdit).toBe(true);
    expect((await as('owner').post(`/dashboards/${dash}/widgets`, widget)).status).toBe(201);
    expect((await as('owner').del(`/dashboards/${dash}/widgets/${w}`)).status).toBe(200);
  });

  it('are not reached through a dashboard of one’s own', async () => {
    const theirs = (await json(as('owner').post('/dashboards', { name: 'Theirs', visibility: 'workspace' }))).id;
    const w = (await json(as('owner').post(`/dashboards/${theirs}/widgets`, widget))).id;
    const mine = (await json(as('member').post('/dashboards', { name: 'Mine', visibility: 'private' }))).id;
    expect((await as('member').del(`/dashboards/${mine}/widgets/${w}`)).status).toBe(404);
    expect((await json(as('owner').get(`/dashboards/${theirs}`))).widgets).toHaveLength(1);
  });
});

describe('shared saved views', () => {
  const view = (name: string) => ({ entityType: 'tasks', name, filters: { projectId }, isShared: true });
  const listed = async (key: string, id: string) =>
    ((await json(as(key).get('/saved-views?entityType=tasks'))).data as any[]).find((v) => v.id === id);

  it('cannot be deleted by someone who did not save them', async () => {
    const id = (await json(as('member').post('/saved-views', view('Team board')))).id;
    expect((await listed('sales', id)).canDelete).toBe(false);
    expect((await as('sales').del(`/saved-views/${id}`)).status).toBe(403);
    expect(await listed('sales', id)).toBeTruthy();
  });

  it('are still deleted by whoever saved them', async () => {
    const id = (await json(as('member').post('/saved-views', view('My shared')))).id;
    expect((await listed('member', id)).canDelete).toBe(true);
    expect((await as('member').del(`/saved-views/${id}`)).status).toBe(200);
  });

  it('are still deleted by someone who manages workspace settings', async () => {
    const id = (await json(as('member').post('/saved-views', view('Stale')))).id;
    expect((await listed('admin', id)).canDelete).toBe(true);
    expect((await as('admin').del(`/saved-views/${id}`)).status).toBe(200);
  });

  it('leave a personal view its user’s alone', async () => {
    const id = (await json(as('member').post('/saved-views', { ...view('Private'), isShared: false }))).id;
    expect((await listed('member', id)).canDelete).toBe(true);
    expect((await as('admin').del(`/saved-views/${id}`)).status).toBe(403);
    expect((await as('member').del(`/saved-views/${id}`)).status).toBe(200);
  });
});
