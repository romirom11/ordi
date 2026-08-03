/**
 * Uploads and the signed, session-free links documents embed (PRD §14.5).
 *
 * The upload is one multipart POST: the API generates the storage key itself
 * and puts the bytes, so nothing browser-facing ever names a bucket object –
 * and the signed link must stay unforgeable, or the whole bucket is
 * enumerable by attachment id. Storage is mocked in-memory (./s3-mock), which
 * also lets the streaming route serve real bytes back.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { getDb, schema } from '@ordi/db';
import { ulid } from 'ulid';
import { MAX_UPLOAD_BYTES } from '@ordi/shared';
import { resetDb, seedRolesAndUsers, reqAs, anon, json } from './helpers';
import { fileSrc, signFileToken } from '../lib/file-tokens';

vi.mock('../lib/s3', () => import('./s3-mock'));

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
let companyId: string;

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
  const { db } = getDb();
  companyId = ulid();
  await db.insert(schema.companies).values({ id: companyId, name: 'Kdn Agency', createdBy: users.owner!.userId });
});

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function form(filename: string, opts: { entityType?: string; entityId?: string; bytes?: Uint8Array; mime?: string } = {}) {
  const fd = new FormData();
  fd.append('file', new File([opts.bytes ?? PNG_BYTES], filename, { type: opts.mime ?? 'image/png' }), filename);
  if (opts.entityType) fd.append('entityType', opts.entityType);
  if (opts.entityId) fd.append('entityId', opts.entityId);
  return fd;
}

/** The way every client uploads: one multipart POST. */
async function upload(opts: Parameters<typeof form>[1] = {}, cookie = users.owner!.cookie) {
  return reqAs(cookie).postForm('/attachments', form('shot.png', opts));
}

describe('upload', () => {
  it('stores the file and returns the embeddable src', async () => {
    const res = await upload();
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.src).toBe(fileSrc(body.id));
    // Root-relative on purpose: the document must survive a domain change.
    expect(body.src.startsWith('/api/v1/files/')).toBe(true);
  });

  it('refuses a blocked extension', async () => {
    const res = await reqAs(users.owner!.cookie).postForm('/attachments', form('payload.exe', { mime: 'application/octet-stream' }));
    expect(res.status).toBe(422);
  });

  it('refuses a file over the size cap', async () => {
    const res = await reqAs(users.owner!.cookie).postForm('/attachments', form('huge.png', {
      bytes: new Uint8Array(MAX_UPLOAD_BYTES + 1),
    }));
    expect(res.status).toBe(400);
  });

  it('refuses a request with no file field', async () => {
    const fd = new FormData();
    fd.append('entityType', 'company');
    expect((await reqAs(users.owner!.cookie).postForm('/attachments', fd)).status).toBe(400);
  });

  it('still enforces the entity permission when one is named', async () => {
    const res = await upload({ entityType: 'company', entityId: companyId }, users.guest!.cookie);
    expect(res.status).toBe(403);
  });

  it('needs no entity at all for a file embedded in a document', async () => {
    expect((await upload()).status).toBe(201);
  });
});

describe('signed file links', () => {
  it('rejects a forged token as not found, without leaking existence', async () => {
    const { id } = await json(await upload());
    const bad = await anon().get(`/files/${id}/${'0'.repeat(32)}`);
    expect(bad.status).toBe(404);
  });

  it('rejects a token minted for another attachment', async () => {
    const first = await json(await upload());
    const second = await json(await upload());
    const res = await anon().get(`/files/${first.id}/${signFileToken(second.id)}`);
    expect(res.status).toBe(404);
  });

  it('rejects an unknown attachment id even with a valid signature', async () => {
    const ghost = ulid();
    const res = await anon().get(`/files/${ghost}/${signFileToken(ghost)}`);
    expect(res.status).toBe(404);
  });

  it('streams the bytes back through the API with no session at all', async () => {
    const { id, src } = await json(await upload());
    expect(src).toContain(id);
    const res = await anon().get(src.replace('/api/v1', ''));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('content-disposition')).toContain('shot.png');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes).toEqual(PNG_BYTES);
  });
});

/**
 * Files hanging off a project. A workspace-wide `projects.read` is not access
 * to a *private* project, and its files are exactly what it keeps private, so
 * membership decides here rather than the permission alone.
 */
describe('project files', () => {
  let projectId: string;
  let typeId: string;

  beforeAll(async () => {
    const owner = reqAs(users.owner!.cookie);
    const type = await json(owner.post('/project-types', { name: 'Delivery', revenueSource: 'none' }));
    typeId = type.id;
    const project = await json(owner.post('/projects', { name: 'Delivery', key: 'DLV', projectTypeId: typeId }));
    projectId = project.id;
  });

  const attach = (cookie: string, entityType: string, entityId: string) =>
    reqAs(cookie).postForm('/attachments', form('brief.pdf', { entityType, entityId, mime: 'application/pdf' }));

  it('accepts a file on a project and lists it back', async () => {
    const res = await attach(users.owner!.cookie, 'project', projectId);
    expect(res.status).toBe(201);
    const list = await json(reqAs(users.owner!.cookie).get(`/attachments?entityType=project&entityId=${projectId}`));
    expect(list.data.map((f: any) => f.filename)).toContain('brief.pdf');
  });

  it('refuses a file on a project that does not exist', async () => {
    const res = await attach(users.owner!.cookie, 'project', ulid());
    expect(res.status).toBe(404);
  });

  it('keeps a private project’s files off a non-member with projects.read', async () => {
    const owner = reqAs(users.owner!.cookie);
    const secret = await json(owner.post('/projects', {
      name: 'Secret', key: 'SCR', projectTypeId: typeId, visibility: 'private',
    }));
    const created = await attach(users.owner!.cookie, 'project', secret.id);
    expect(created.status).toBe(201);
    const { id } = await json(created);

    // `member` carries projects.read but is not on this private project.
    const outsider = reqAs(users.member!.cookie);
    expect((await outsider.get(`/attachments?entityType=project&entityId=${secret.id}`)).status).toBe(404);
    expect((await outsider.get(`/attachments/${id}/url`)).status).toBe(404);
    expect((await outsider.del(`/attachments/${id}`)).status).toBe(404);
  });
});
