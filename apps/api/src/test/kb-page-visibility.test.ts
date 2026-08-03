/**
 * Page-level KB visibility (PRD §9.3), everywhere pages surface.
 *
 * The report: a role holding only kb.read opened the knowledge base and every
 * workspace space was empty – pages were born as drafts by a silent default,
 * and drafts read for editors only. Pages are born published now, and the
 * draft/private rule (canSeePage) is enforced in each place a page leaks out
 * of the tree: search, the activity trail, versions, backlinks, duplication.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { getDb, schema } from '@ordi/db';
import { ulid } from 'ulid';
import { resetDb, seedRolesAndUsers, reqAs, json } from './helpers';
import { generateToken } from '../lib/crypto';

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;

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
  return { userId, cookie: `ordi_session=${token}`, as: reqAs(`ordi_session=${token}`) };
}

/** kb.read only – the role from the report. */
let reader: Awaited<ReturnType<typeof customRole>>;
/** kb.read + kb.write – edits every workspace space. */
let writer: Awaited<ReturnType<typeof customRole>>;

let openSpace = '';

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
  reader = await customRole('Reader', ['kb.read']);
  writer = await customRole('Writer', ['kb.read', 'kb.write']);
  const owner = reqAs(users.owner!.cookie);
  openSpace = (await json(owner.post('/spaces', { name: 'Handbook', visibility: 'workspace' }))).id;
});

describe('a created page is a visible page', () => {
  it('kb.read sees a freshly created page in a workspace space', async () => {
    const id = (await json(writer.as.post('/pages', { spaceId: openSpace, title: 'Onboarding' }))).id;
    const list = (await json(reader.as.get(`/spaces/${openSpace}/pages`))).data as any[];
    expect(list.map((p) => p.id)).toContain(id);
    expect((await json(reader.as.get(`/pages/${id}`))).title).toBe('Onboarding');
  });

  it('a draft is an explicit choice and reads for editors only', async () => {
    const id = (await json(writer.as.post('/pages', { spaceId: openSpace, title: 'Half-written', published: false }))).id;
    const forReader = (await json(reader.as.get(`/spaces/${openSpace}/pages`))).data as any[];
    expect(forReader.some((p) => p.id === id)).toBe(false);
    expect((await reader.as.get(`/pages/${id}`)).status).toBe(404);
    const forWriter = (await json(writer.as.get(`/spaces/${openSpace}/pages`))).data as any[];
    expect(forWriter.some((p) => p.id === id)).toBe(true);
  });
});

describe('what the tree hides, nothing else shows', () => {
  let draftId = '';
  let privateId = '';

  beforeAll(async () => {
    draftId = (await json(writer.as.post('/pages', { spaceId: openSpace, title: 'Secret draft plan', published: false }))).id;
    privateId = (await json(writer.as.post('/pages', { spaceId: openSpace, title: 'Personal scratchpad', visibility: 'private' }))).id;
  });

  it('search returns neither the draft nor another user’s private page', async () => {
    const readerHits = (await json(reader.as.get('/search?q=Secret'))).data as any[];
    expect(readerHits.some((h) => h.id === draftId)).toBe(false);
    const privateHits = (await json(reader.as.get('/search?q=scratchpad'))).data as any[];
    expect(privateHits.some((h) => h.id === privateId)).toBe(false);
    // ...while the author/editor still finds both
    const writerHits = (await json(writer.as.get('/search?q=Secret'))).data as any[];
    expect(writerHits.some((h) => h.id === draftId)).toBe(true);
  });

  it('the activity trail does not narrate them', async () => {
    expect((await json(reader.as.get(`/audit/entity/kb_page/${draftId}`))).data).toEqual([]);
    expect((await json(reader.as.get(`/audit/entity/kb_page/${privateId}`))).data).toEqual([]);
    expect(((await json(writer.as.get(`/audit/entity/kb_page/${draftId}`))).data as any[]).length).toBeGreaterThan(0);
  });

  it('versions answer 404 – they carry full bodies', async () => {
    expect((await reader.as.get(`/pages/${draftId}/versions`)).status).toBe(404);
    expect((await writer.as.get(`/pages/${draftId}/versions`)).status).toBe(200);
  });

  it('a private page cannot be copied out by someone who cannot read it', async () => {
    // reader is no editor anywhere, so the target check refuses first; give the
    // copier editor rights on a target space but only viewer sight of the source.
    const { db } = getDb();
    const owner = reqAs(users.owner!.cookie);
    const closed = (await json(owner.post('/spaces', { name: 'Vault', visibility: 'private' }))).id;
    const hidden = (await json(owner.post('/pages', { spaceId: closed, title: 'Vault notes', published: false }))).id;
    await db.insert(schema.spaceMembers).values({ spaceId: closed, userId: writer.userId, role: 'viewer' });
    const res = await writer.as.post(`/pages/${hidden}/duplicate`, { spaceId: openSpace });
    expect(res.status).toBe(404);
  });

  it('backlinks name only pages the actor can see', async () => {
    const target = (await json(writer.as.post('/pages', { spaceId: openSpace, title: 'Linked target' }))).id;
    await writer.as.post('/pages', {
      spaceId: openSpace, title: 'Loud draft', published: false,
      body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'see [[Linked target]]' }] }] },
    });
    const forWriter = await json(writer.as.get(`/pages/${target}?include=backlinks`));
    expect((forWriter.backlinks as any[]).some((b) => b.title === 'Loud draft')).toBe(true);
    const forReader = await json(reader.as.get(`/pages/${target}?include=backlinks`));
    expect((forReader.backlinks as any[]).some((b) => b.title === 'Loud draft')).toBe(false);
  });
});
