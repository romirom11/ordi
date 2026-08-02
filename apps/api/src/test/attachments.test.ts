/**
 * Uploads and the signed, session-free links documents embed (PRD §14.5).
 *
 * Two things are load-bearing here and neither is obvious from reading a route:
 * registering an attachment mints a public link, so register must refuse any
 * fileKey /presign did not issue; and the link itself must be unforgeable, or
 * the whole bucket is enumerable by attachment id.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { getDb, schema } from '@ordi/db';
import { ulid } from 'ulid';
import { resetDb, seedRolesAndUsers, reqAs, anon, json } from './helpers';
import { fileSrc, signFileToken } from '../lib/file-tokens';

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
let companyId: string;

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
  const { db } = getDb();
  companyId = ulid();
  await db.insert(schema.companies).values({ id: companyId, name: 'Kdn Agency', createdBy: users.owner!.userId });
});

/** presign → register, the way every client does it. */
async function upload(overrides: Record<string, unknown> = {}) {
  const presign = await json(reqAs(users.owner!.cookie).post('/attachments/presign', {
    filename: 'shot.png', size: 4096, mime: 'image/png',
  }));
  const res = await reqAs(users.owner!.cookie).post('/attachments/register', {
    fileKey: presign.fileKey, keyToken: presign.keyToken,
    filename: 'shot.png', size: 4096, mime: 'image/png',
    ...overrides,
  });
  return { presign, res };
}

describe('presign', () => {
  it('issues a key and a signature for it', async () => {
    const presign = await json(reqAs(users.owner!.cookie).post('/attachments/presign', {
      filename: 'shot.png', size: 10, mime: 'image/png',
    }));
    expect(presign.fileKey).toMatch(/^uploads\/[0-9A-HJKMNP-TV-Z]{26}\/shot\.png$/);
    expect(presign.keyToken).toHaveLength(32);
  });

  it('refuses a blocked extension', async () => {
    const res = await reqAs(users.owner!.cookie).post('/attachments/presign', {
      filename: 'payload.exe', size: 10, mime: 'application/octet-stream',
    });
    expect(res.status).toBe(422);
  });

  it('refuses a file over the size cap', async () => {
    const res = await reqAs(users.owner!.cookie).post('/attachments/presign', {
      filename: 'huge.png', size: 26 * 1024 * 1024, mime: 'image/png',
    });
    expect(res.status).toBe(400);
  });
});

describe('register', () => {
  it('returns the embeddable src alongside the id', async () => {
    const { res } = await upload();
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.src).toBe(fileSrc(body.id));
    // Root-relative on purpose: the document must survive a domain change.
    expect(body.src.startsWith('/api/v1/files/')).toBe(true);
  });

  it('refuses a fileKey that presign never issued', async () => {
    const res = await reqAs(users.owner!.cookie).post('/attachments/register', {
      fileKey: 'invoices/secret.pdf', keyToken: 'x'.repeat(32),
      filename: 'secret.pdf', size: 10, mime: 'application/pdf',
    });
    // Otherwise registering is a way to mint a public link to any object in
    // the bucket, not just the one you uploaded.
    expect(res.status).toBe(400);
  });

  it('refuses a key signed for a different key', async () => {
    const a = await json(reqAs(users.owner!.cookie).post('/attachments/presign', {
      filename: 'a.png', size: 10, mime: 'image/png',
    }));
    const b = await json(reqAs(users.owner!.cookie).post('/attachments/presign', {
      filename: 'b.png', size: 10, mime: 'image/png',
    }));
    const res = await reqAs(users.owner!.cookie).post('/attachments/register', {
      fileKey: a.fileKey, keyToken: b.keyToken,
      filename: 'a.png', size: 10, mime: 'image/png',
    });
    expect(res.status).toBe(400);
  });

  it('still enforces the entity permission when one is named', async () => {
    const presign = await json(reqAs(users.guest!.cookie).post('/attachments/presign', {
      filename: 'note.png', size: 10, mime: 'image/png',
    }));
    const res = await reqAs(users.guest!.cookie).post('/attachments/register', {
      entityType: 'company', entityId: companyId,
      fileKey: presign.fileKey, keyToken: presign.keyToken,
      filename: 'note.png', size: 10, mime: 'image/png',
    });
    expect(res.status).toBe(403);
  });

  it('needs no entity at all for a file embedded in a document', async () => {
    const { res } = await upload();
    expect(res.status).toBe(201);
  });
});

describe('signed file links', () => {
  it('rejects a forged token as not found, without leaking existence', async () => {
    const { res } = await upload();
    const { id } = await json(res);
    const bad = await anon().get(`/files/${id}/${'0'.repeat(32)}`);
    expect(bad.status).toBe(404);
  });

  it('rejects a token minted for another attachment', async () => {
    const first = await json((await upload()).res);
    const second = await json((await upload()).res);
    const res = await anon().get(`/files/${first.id}/${signFileToken(second.id)}`);
    expect(res.status).toBe(404);
  });

  it('rejects an unknown attachment id even with a valid signature', async () => {
    const ghost = ulid();
    const res = await anon().get(`/files/${ghost}/${signFileToken(ghost)}`);
    expect(res.status).toBe(404);
  });

  it('accepts the real link with no session at all', async () => {
    const { id, src } = await json((await upload()).res);
    expect(src).toContain(id);
    const res = await anon().get(src.replace('/api/v1', ''));
    // No S3 in the test environment, so the route gets as far as resolving the
    // object and then reports storage is unconfigured – a 422, not a 404. That
    // distinction is the assertion: the token verified and the row was found.
    expect(res.status).toBe(422);
    expect((await json(res)).error.message).toMatch(/storage/i);
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

  const attach = (cookie: string, entityType: string, entityId: string) => (async () => {
    const presign = await json(reqAs(cookie).post('/attachments/presign', {
      filename: 'brief.pdf', size: 2048, mime: 'application/pdf',
    }));
    return reqAs(cookie).post('/attachments/register', {
      fileKey: presign.fileKey, keyToken: presign.keyToken,
      filename: 'brief.pdf', size: 2048, mime: 'application/pdf', entityType, entityId,
    });
  })();

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
