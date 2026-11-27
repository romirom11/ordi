/**
 * File links expire, and a file opens only for people who can see where it
 * lives (lib/file-tokens, core/file-access, core/file-links).
 *
 * - A signed link opens its file for about an hour; a lapsed one and one from
 *   before links expired are refused.
 * - A loose file (no record) opens by id only for its uploader and readers of
 *   a record that names it; a document's readers get the files it embeds
 *   signed afresh with every read.
 * - A path that comes in unvetted is stored dead; records may only name the
 *   caller's own upload.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { getDb, schema, eq } from '@ordi/db';
import { ulid } from 'ulid';
import { Hono } from 'hono';
import { app, resetDb, seedRolesAndUsers, reqAs, anon, json } from './helpers';
import { fileLinks, signFilePaths } from '../core/file-links';
import type { AppEnv } from '../context';
import { FILE_LINK_GRACE_SECONDS, FILE_LINK_TTL_SECONDS, deadFileToken, fileSrc, signFileToken } from '../lib/file-tokens';
import { hmacSha256 } from '../lib/crypto';
import { env } from '../env';

vi.mock('../lib/s3', () => import('./s3-mock'));

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
let owner: ReturnType<typeof reqAs>;
let member: ReturnType<typeof reqAs>;
let guest: ReturnType<typeof reqAs>;
let hr: ReturnType<typeof reqAs>;
let finance: ReturnType<typeof reqAs>;
let projectId: string;
let companyId: string;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]);
const now = () => Math.floor(Date.now() / 1000);

async function upload(as: ReturnType<typeof reqAs>, opts: { entityType?: string; entityId?: string } = {}) {
  const fd = new FormData();
  fd.append('file', new File([PNG], 'shot.png', { type: 'image/png' }), 'shot.png');
  if (opts.entityType) fd.append('entityType', opts.entityType);
  if (opts.entityId) fd.append('entityId', opts.entityId);
  const res = await as.postForm('/attachments', fd);
  expect(res.status).toBe(201);
  return json(res) as Promise<{ id: string; src: string }>;
}

/** What a link of the old kind looked like: an HMAC of the id alone. */
const legacyPath = (id: string) => `/api/v1/files/${id}/${hmacSha256(env.authSecret, `attachment:${id}`).slice(0, 32)}`;
/** A genuine link that lapsed `ago` seconds past its whole life. */
const lapsedPath = (id: string, ago: number) => `/api/v1/files/${id}/${signFileToken(id, now() - FILE_LINK_TTL_SECONDS - 15 * 60 - ago)}`;
const open = (src: string) => anon().get(src.replace(/^.*\/api\/v1/, ''));

const doc = (src: string) => ({ type: 'doc', content: [{ type: 'image', attrs: { src, alt: 'shot' } }] });
const srcOf = (description: any): string => description.content[0].attrs.src;

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
  owner = reqAs(users.owner!.cookie);
  member = reqAs(users.member!.cookie);
  guest = reqAs(users.guest!.cookie);
  hr = reqAs(users.hr!.cookie);
  finance = reqAs(users.finance!.cookie);
  const type = await json(owner.post('/project-types', { name: 'Delivery', revenueSource: 'none' }));
  projectId = (await json(owner.post('/projects', { name: 'Delivery', key: 'FLD', projectTypeId: type.id }))).id;
  // The member writes tasks here: a project member, not an admin.
  await getDb().db.insert(schema.projectMembers).values({ projectId, userId: users.member!.userId, role: 'member' });
  companyId = ulid();
  await getDb().db.insert(schema.companies).values({ id: companyId, name: 'Acme', createdBy: users.owner!.userId });
});

describe('a signed link expires', () => {
  it('opens the file while fresh, and caches no longer than it lives', async () => {
    const { src } = await upload(owner);
    const res = await open(src);
    expect(res.status).toBe(200);
    const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get('cache-control') ?? '')?.[1]);
    expect(maxAge).toBeGreaterThan(FILE_LINK_TTL_SECONDS - 5);
    expect(maxAge).toBeLessThanOrEqual(FILE_LINK_TTL_SECONDS + 15 * 60);
  });

  it('refuses a lapsed link', async () => {
    const { id } = await upload(owner);
    expect((await open(lapsedPath(id, 1))).status).toBe(404);
  });

  it('refuses a link from before links expired', async () => {
    const { id } = await upload(owner);
    expect((await open(legacyPath(id))).status).toBe(404);
  });

  it('refuses a link whose expiry was moved', async () => {
    const { src } = await upload(owner);
    const [, id, expiry, sig] = /files\/([^/]+)\/(\d+)\.([0-9a-f]+)$/.exec(src)!;
    expect((await open(`/api/v1/files/${id}/${Number(expiry) + 86_400}.${sig}`)).status).toBe(404);
  });
});

describe('a loose file opens by id only for who may see it', () => {
  it('gives its uploader a link and nobody else', async () => {
    const { id } = await upload(owner);
    expect((await owner.get(`/attachments/${id}/url`)).status).toBe(200);
    expect((await member.get(`/attachments/${id}/url`)).status).toBe(404);
    expect((await guest.get(`/attachments/${id}/url`)).status).toBe(404);
  });

  it('keeps a file on a record answering to that record', async () => {
    const { id } = await upload(owner, { entityType: 'company', entityId: companyId });
    // member has crm.read; guest has nothing.
    const res = await member.get(`/attachments/${id}/url`);
    expect(res.status).toBe(200);
    expect((await open((await json(res)).url)).status).toBe(200);
    expect((await guest.get(`/attachments/${id}/url`)).status).toBe(403);
  });
});

describe('an embedded file opens for the readers of its document', () => {
  it('re-signs a stored path, old links included, for each reader', async () => {
    const { id, src } = await upload(owner);
    const task = await json(owner.post('/tasks', { projectId, title: 'With image', description: doc(src) }));
    // Stored the way documents written before links expired hold it.
    await getDb().db.update(schema.tasks).set({ description: doc(legacyPath(id)) }).where(eq(schema.tasks.id, task.id));

    const read = await json(member.get(`/tasks/${task.id}`));
    const signed = srcOf(read.description);
    expect(signed).not.toBe(legacyPath(id));
    expect((await open(signed)).status).toBe(200);
  });

  it('stores dead a lapsed path its sender has no right to, and keeps it for those who have', async () => {
    const { id } = await upload(owner);
    const task = await json(member.post('/tasks', { projectId, title: 'Pasted', description: doc(lapsedPath(id, FILE_LINK_GRACE_SECONDS + 60)) }));
    const [row] = await getDb().db.select({ description: schema.tasks.description }).from(schema.tasks).where(eq(schema.tasks.id, task.id));
    expect(srcOf(row!.description)).toBe(`/api/v1/files/${id}/${deadFileToken(id)}`);

    // The member reads it back dead; the uploader still sees the image.
    expect((await open(srcOf((await json(member.get(`/tasks/${task.id}`))).description))).status).toBe(404);
    expect((await open(srcOf((await json(owner.get(`/tasks/${task.id}`))).description))).status).toBe(200);
  });

  it('catches a path hidden behind JSON escapes', async () => {
    const { id } = await upload(owner);
    const hidden = lapsedPath(id, FILE_LINK_GRACE_SECONDS + 60).replace(/\//g, '\\/');
    const body = `{"projectId":"${projectId}","title":"Escaped","description":{"type":"doc","content":[{"type":"image","attrs":{"src":"${hidden}"}}]}}`;
    const created = await app.request('/api/v1/tasks', { method: 'POST', headers: { cookie: users.member!.cookie, 'content-type': 'application/json' }, body });
    expect(created.status).toBe(201);
    const task = await json(created);
    expect((await open(srcOf((await json(member.get(`/tasks/${task.id}`))).description))).status).toBe(404);
  });

  it('keeps a path its sender was handed recently', async () => {
    const { id } = await upload(owner);
    // Lapsed an hour ago: an editor that stayed open past the link's life.
    const task = await json(member.post('/tasks', { projectId, title: 'Copied', description: doc(lapsedPath(id, 3600)) }));
    expect((await open(srcOf((await json(member.get(`/tasks/${task.id}`))).description))).status).toBe(200);
  });

  it('goes out dead to a reader who may not see the record the file hangs off', async () => {
    const { id } = await upload(owner, { entityType: 'employee', entityId: ulid() });
    const task = await json(owner.post('/tasks', { projectId, title: 'HR file', description: doc(fileSrc(id)) }));
    expect((await open(srcOf((await json(member.get(`/tasks/${task.id}`))).description))).status).toBe(404);
    expect((await open(srcOf((await json(owner.get(`/tasks/${task.id}`))).description))).status).toBe(200);
  });

  it('refuses a url that would echo an unvetted path back', async () => {
    const { id } = await upload(owner);
    const res = await member.get(`/search?q=${encodeURIComponent(lapsedPath(id, FILE_LINK_GRACE_SECONDS + 60))}`);
    expect(res.status).toBe(400);
  });

  it('refuses a url hiding the path behind an encoding a strict decoder rejects', async () => {
    const { id } = await upload(owner);
    // A broken %-run makes decodeURIComponent throw; Hono decodes the rest anyway.
    const q = `${encodeURIComponent(lapsedPath(id, FILE_LINK_GRACE_SECONDS + 60))}%E0%A4%A`;
    expect((await member.get(`/search?q=${q}`)).status).toBe(400);
  });

  it('renews a path on refresh only for a reader with a right of their own', async () => {
    const { id } = await upload(owner);
    const recent = lapsedPath(id, 3600);
    // The uploader gets a fresh link.
    const mine = await json(owner.post('/attachments/refresh', { srcs: [recent] }));
    expect((await open(mine.srcs[0])).status).toBe(200);
    // Anyone else gets it back as it came: a recent link cannot be renewed
    // forever without the file living in a document they read.
    const theirs = await json(member.post('/attachments/refresh', { srcs: [recent] }));
    expect(theirs.srcs[0]).toBe(recent);
    expect((await open(theirs.srcs[0])).status).toBe(404);
    const stale = await json(member.post('/attachments/refresh', { srcs: [lapsedPath(id, FILE_LINK_GRACE_SECONDS + 60)] }));
    expect((await open(stale.srcs[0])).status).toBe(404);
  });

  it('stores dead an old path a visitor sends through a public form', async () => {
    const { db } = getDb();
    const { id } = await upload(owner);
    const stageId = ulid();
    await db.insert(schema.applicantStages).values({ id: stageId, name: 'Inbox', position: -1 });
    const token = ulid();
    await db.insert(schema.jobOpenings).values({ id: ulid(), title: 'Ops', publicToken: token, publicEnabled: true });
    const coverText = `See ![cv](${legacyPath(id)})`;
    expect((await anon().post(`/careers/${token}`, { name: 'E', email: 'e@x.test', coverText })).status).toBe(200);
    const [row] = await db.select({ coverText: schema.applicants.coverText }).from(schema.applicants).where(eq(schema.applicants.email, 'e@x.test'));
    expect(row!.coverText).toContain(deadFileToken(id));
  });
});

describe('paths that reach storage or an answer some other way', () => {
  const stale = (id: string) => lapsedPath(id, FILE_LINK_GRACE_SECONDS + 60);

  it('vets the intake form’s JSON payload inside a multipart body, escapes and all', async () => {
    const { db } = getDb();
    const { id } = await upload(owner);
    const settings = await json(owner.patch(`/projects/${projectId}/intake-settings`, { formEnabled: true }));
    const hidden = stale(id).replace(/\//g, '\\/');
    const fd = new FormData();
    fd.append('payload', `{"values":{"requesterName":"Ola","requesterEmail":"ola@x.test","title":"Broken ${hidden}"}}`);
    const res = await app.request(`/api/v1/intake/${settings.formToken}`, { method: 'POST', body: fd, headers: { 'x-forwarded-for': '10.9.9.9' } });
    expect(res.status).toBe(200);
    const [item] = await db.select({ title: schema.intakeItems.title }).from(schema.intakeItems).where(eq(schema.intakeItems.projectId, projectId));
    expect(item!.title).toContain(deadFileToken(id));
  });

  it('vets a csv cell after parsing, where a stray carriage return no longer splits the path', async () => {
    const { id } = await upload(owner);
    const split = stale(id).replace('/files/', '/fi\rles/');
    const csv = `projectKey,title\nFLD,Imported ${split}\n`;
    const dry = await json(member.post('/import/tasks', { csv, dryRun: true }));
    expect(JSON.stringify(dry)).not.toContain(signFileToken(id));
    expect((await member.post('/import/tasks', { csv })).status).toBe(200);
    const rows = await getDb().db.select({ title: schema.tasks.title }).from(schema.tasks).where(eq(schema.tasks.projectId, projectId));
    const imported = rows.find((r) => r.title.startsWith('Imported'));
    expect(imported!.title).toContain(deadFileToken(id));
  });

  it('renews nothing in a write’s answer for a reader without a right of their own', async () => {
    const { id } = await upload(owner);
    const recent = lapsedPath(id, 3600);
    const created = await json(member.post('/tasks', { projectId, title: 'Echo', description: doc(recent) }));
    expect(srcOf(created.description)).toBe(recent);
    // Read back, it is a document being read: signed afresh.
    expect((await open(srcOf((await json(member.get(`/tasks/${created.id}`))).description))).status).toBe(200);
  });

  it('signs a loose file in an audit-style answer only for a reader with a right of their own', async () => {
    const { id } = await upload(owner);
    const text = `diff ${legacyPath(id)}`;
    const memberActor = { userId: users.member!.userId, access: { permissions: new Set<string>() } } as any;
    expect(await signFilePaths(text, memberActor, { documentRead: false })).toBe(text);
    const ownerActor = { userId: users.owner!.userId, access: { permissions: new Set<string>() } } as any;
    expect(await signFilePaths(text, ownerActor, { documentRead: false })).not.toBe(text);
  });

  it('keeps a csv answer’s byte-order mark when it rewrites the paths in it', async () => {
    const { id } = await upload(owner);
    const mini = new Hono<AppEnv>();
    mini.use('*', fileLinks);
    mini.get('/x.csv', (c) => c.body(`\uFEFFname,img\nA,${legacyPath(id)}\n`, 200, { 'content-type': 'text/csv; charset=utf-8' }));
    const bytes = new Uint8Array(await (await mini.request('/x.csv')).arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder().decode(bytes)).not.toContain(legacyPath(id));
  });

  it('vets a file path hidden in an uploaded file’s name', async () => {
    const { id } = await upload(owner);
    const fd = new FormData();
    fd.append('file', new File([PNG], `x${stale(id)}.png`, { type: 'image/png' }));
    const res = await member.postForm('/attachments', fd);
    expect(res.status).toBe(201);
    const [row] = await getDb().db.select({ filename: schema.attachments.filename }).from(schema.attachments).where(eq(schema.attachments.id, (await json(res)).id));
    expect(row!.filename).toContain(deadFileToken(id));
  });
});

describe('records name only a file the caller may attach', () => {
  let hrEmployeeId: string;
  let leaveTypeId: string;

  beforeAll(async () => {
    hrEmployeeId = (await json(hr.post('/employees', { firstName: 'Olena', lastName: 'K', userId: users.member!.userId }))).id;
    leaveTypeId = (await json(hr.post('/leave-types', { name: 'Sick', affectsBalance: false, annualQuota: 0 }))).id;
  });

  it('refuses a leave request naming someone else’s file, and an unknown id', async () => {
    const { id } = await upload(owner);
    const base = { leaveTypeId, fromDate: '2031-03-03', toDate: '2031-03-03' };
    expect((await member.post('/leave-requests', { ...base, attachmentId: id })).status).toBe(400);
    expect((await member.post('/leave-requests', { ...base, attachmentId: ulid() })).status).toBe(400);
    expect(hrEmployeeId).toBeTruthy();
  });

  it('takes the requester’s own upload, which HR then opens and others do not', async () => {
    const { id } = await upload(member);
    const res = await member.post('/leave-requests', { leaveTypeId, fromDate: '2031-03-10', toDate: '2031-03-10', attachmentId: id });
    expect(res.status).toBe(201);
    expect((await hr.get(`/attachments/${id}/url`)).status).toBe(200);
    expect((await guest.get(`/attachments/${id}/url`)).status).toBe(404);
  });

  it('refuses an expense naming someone else’s file, on create and on update', async () => {
    const theirs = await upload(owner);
    const base = { amount: 10, currency: 'USD', date: '2031-01-05', description: 'Taxi' };
    expect((await finance.post('/expenses', { ...base, attachmentId: theirs.id })).status).toBe(400);

    const mine = await upload(finance);
    const created = await finance.post('/expenses', { ...base, attachmentId: mine.id });
    expect(created.status).toBe(201);
    const expense = await json(created);
    const expenseId = expense.id ?? expense;
    expect((await finance.patch(`/expenses/${expenseId}`, { attachmentId: theirs.id })).status).toBe(400);
    // The receipt it already names stays fine.
    expect((await finance.patch(`/expenses/${expenseId}`, { attachmentId: mine.id, description: 'Taxi home' })).status).toBe(200);
    // And the owner, with finance.read, opens it.
    expect((await owner.get(`/attachments/${mine.id}/url`)).status).toBe(200);
  });

  it('refuses an applicant’s CV that the recruiter did not upload, and any on the public form', async () => {
    const { db } = getDb();
    const stageId = ulid();
    await db.insert(schema.applicantStages).values({ id: stageId, name: 'New', position: 0 });
    const jobId = ulid();
    const token = ulid();
    await db.insert(schema.jobOpenings).values({ id: jobId, title: 'Dev', publicToken: token, publicEnabled: true });
    const theirs = await upload(owner);
    expect((await hr.post('/applicants', { jobOpeningId: jobId, name: 'A', email: 'a@x.test', resumeAttachmentId: theirs.id })).status).toBe(400);
    const mine = await upload(hr);
    expect((await hr.post('/applicants', { jobOpeningId: jobId, name: 'B', email: 'b@x.test', resumeAttachmentId: mine.id })).status).toBe(201);
    expect((await anon().post(`/careers/${token}`, { name: 'C', email: 'c@x.test', resumeAttachmentId: theirs.id })).status).toBe(400);
    expect((await anon().post(`/careers/${token}`, { name: 'D', email: 'd@x.test' })).status).toBe(200);
  });
});
