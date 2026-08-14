/**
 * Files that arrive with an email request: bound to the intake item, readable
 * by project members only, and re-bound to the task when the request is
 * accepted (PRD §8.6 "вкладення переносяться").
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { getDb, schema, eq } from '@ordi/db';
import { ulid } from 'ulid';
import { resetDb, seedRolesAndUsers, reqAs, json } from './helpers';

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
let projectId: string;
let itemId: string;
let attachmentId: string;
let statusId: string;

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
  const owner = reqAs(users.owner!.cookie);
  const type = await json(owner.post('/project-types', { name: 'Ops', revenueSource: 'none' }));
  projectId = (await json(owner.post('/projects', { name: 'Ops', key: 'OPS', projectTypeId: type.id, visibility: 'private' }))).id;
  const statuses = (await json(owner.get(`/projects/${projectId}/task-statuses`))).data as any[];
  statusId = statuses.find((s) => s.category === 'todo')!.id;

  // What the IMAP worker produces: an attachment row bound to the item plus
  // the item's manifest. Storage content is irrelevant to the access story.
  const { db } = getDb();
  itemId = ulid();
  attachmentId = ulid();
  await db.insert(schema.attachments).values({
    id: attachmentId, entityType: 'intake_item', entityId: itemId,
    fileKey: `uploads/${attachmentId}/brief.pdf`, filename: 'brief.pdf', size: 1234, mime: 'application/pdf',
  });
  await db.insert(schema.intakeItems).values({
    id: itemId, projectId, source: 'email', status: 'pending',
    title: 'Landing brief', description: 'See attached',
    attachments: [{ attachmentId, filename: 'brief.pdf', size: 1234, mime: 'application/pdf' }],
  });
});

describe('intake attachments', () => {
  it('lists the manifest with the pending item', async () => {
    const owner = reqAs(users.owner!.cookie);
    const items = (await json(owner.get(`/projects/${projectId}/intake`))).data as any[];
    expect(items[0].attachments).toHaveLength(1);
    expect(items[0].attachments[0].filename).toBe('brief.pdf');
  });

  it('hands the file URL to a project member and refuses an outsider', async () => {
    const owner = reqAs(users.owner!.cookie);
    const asOwner = await owner.get(`/attachments/${attachmentId}/url`);
    expect(asOwner.status).toBe(200);

    // The member preset has projects.read but no membership in this private project.
    const member = reqAs(users.member!.cookie);
    const asMember = await member.get(`/attachments/${attachmentId}/url`);
    expect([403, 404]).toContain(asMember.status);
  });

  it('re-binds the file to the task on accept', async () => {
    const owner = reqAs(users.owner!.cookie);
    const accepted = await json(owner.post(`/intake/${itemId}/accept`, { statusId }));
    expect(accepted.taskId).toBeTruthy();

    const { db } = getDb();
    const [att] = await db.select().from(schema.attachments).where(eq(schema.attachments.id, attachmentId));
    expect(att!.entityType).toBe('task');
    expect(att!.entityId).toBe(accepted.taskId);

    const files = (await json(owner.get(`/attachments?entityType=task&entityId=${accepted.taskId}`))).data as any[];
    expect(files.map((f) => f.filename)).toContain('brief.pdf');
  });
});
