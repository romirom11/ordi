/**
 * CSV import/export: formula cells leave as text and come back unchanged,
 * task import needs member rights on the project, imported tasks keep file order.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { getDb, schema, eq, and, asc } from '@ordi/db';
import { ulid } from 'ulid';
import { resetDb, seedRolesAndUsers, reqAs, json } from './helpers';
import { parseCsv } from '../domains/core/importexport.routes';

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
let projectId: string;

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
  const owner = reqAs(users.owner!.cookie);
  const type = await json(owner.post('/project-types', { name: 'Delivery', revenueSource: 'none' }));
  projectId = (await json(owner.post('/projects', { name: 'Import', key: 'IMP', projectTypeId: type.id }))).id;
});

async function exportedCompanies(): Promise<{ header: string[]; rows: string[][]; text: string }> {
  const res = await reqAs(users.owner!.cookie).get('/export/companies.csv');
  expect(res.status).toBe(200);
  const text = Buffer.from(await res.arrayBuffer()).toString('utf8');
  const [header, ...rows] = parseCsv(text);
  return { header: header!, rows, text };
}

describe('formula cells in exports', () => {
  it('exports a formula-looking name as text and imports it back unchanged', async () => {
    const owner = reqAs(users.owner!.cookie);
    const created = await owner.post('/import/companies', { csv: 'name,domain\n"=HYPERLINK(""http://x"")",x.test\n' });
    expect((await json(created)).imported).toBe(1);

    const { header, rows } = await exportedCompanies();
    const row = rows.find((r) => r[header.indexOf('domain')] === 'x.test');
    // A leading quote makes a spreadsheet show the cell instead of running it.
    expect(row?.[header.indexOf('name')]).toBe(`'=HYPERLINK("http://x")`);

    // Feeding the exported cell back stores the original text, not the guard.
    await owner.post('/import/companies', { csv: `name,domain\n"'=SUM(1)",y.test\n` });
    const { db } = getDb();
    const [back] = await db.select().from(schema.companies).where(eq(schema.companies.domain, 'y.test'));
    expect(back?.name).toBe('=SUM(1)');
  });

  it('leaves phone numbers and ordinary text alone', async () => {
    const owner = reqAs(users.owner!.cookie);
    await owner.post('/import/companies', { csv: 'name,domain\n+380 44 123 45 67,phone.test\n' });
    const { header, rows } = await exportedCompanies();
    const row = rows.find((r) => r[header.indexOf('domain')] === 'phone.test');
    expect(row?.[header.indexOf('name')]).toBe('+380 44 123 45 67');
  });
});

describe('task import', () => {
  it('refuses a project the importer can only view', async () => {
    // The member role reads workspace projects but is not a member of this one.
    const res = await json(reqAs(users.member!.cookie).post('/import/tasks', { csv: 'projectKey,title\nIMP,Sneaky\n', dryRun: true }));
    expect(res.valid).toBe(0);
    expect(res.errors[0].message).toContain('No rights');
  });

  it('accepts it once the importer is a project member', async () => {
    const owner = reqAs(users.owner!.cookie);
    expect((await owner.post(`/projects/${projectId}/members`, { userId: users.member!.userId, role: 'member', canWriteTasks: true })).status).toBe(201);
    const res = await json(reqAs(users.member!.cookie).post('/import/tasks', { csv: 'projectKey,title\nIMP,From member\n' }));
    expect(res.imported).toBe(1);
  });

  it('appends imported tasks after the existing ones, in file order', async () => {
    const owner = reqAs(users.owner!.cookie);
    const res = await json(owner.post('/import/tasks', { csv: 'projectKey,title\nIMP,First\nIMP,Second\nIMP,Third\n' }));
    expect(res.imported).toBe(3);
    const { db } = getDb();
    const rows = await db.select({ title: schema.tasks.title, position: schema.tasks.position })
      .from(schema.tasks).where(eq(schema.tasks.projectId, projectId)).orderBy(asc(schema.tasks.position));
    expect(rows.map((r) => r.title)).toEqual(['From member', 'First', 'Second', 'Third']);
    expect(new Set(rows.map((r) => r.position)).size).toBe(rows.length);
  });
});

describe('feeding an export back', () => {
  it('updates companies by id instead of duplicating them', async () => {
    const owner = reqAs(users.owner!.cookie);
    await owner.post('/import/companies', { csv: 'name,domain\nRound Trip Co,round.test\n' });
    const { header, rows } = await exportedCompanies();
    const before = rows.length;
    const edited = [header, ...rows.map((r) => r[header.indexOf('domain')] === 'round.test'
      ? r.map((v, i) => (header[i] === 'paymentTermsDays' ? '30' : v)) : r)];
    const csv = edited.map((r) => r.map((v) => `"${v.replace(/"/g, '""')}"`).join(',')).join('\n');

    const dry = await json(owner.post('/import/companies', { csv, dryRun: true }));
    expect(dry.created).toBe(0);
    expect(dry.updated).toBe(before);
    const res = await json(owner.post('/import/companies', { csv }));
    expect(res.imported).toBe(before);

    const after = await exportedCompanies();
    expect(after.rows).toHaveLength(before);
    const row = after.rows.find((r) => r[after.header.indexOf('domain')] === 'round.test');
    expect(row?.[after.header.indexOf('paymentTermsDays')]).toBe('30');
  });

  it('gives imported companies an owner', async () => {
    await reqAs(users.owner!.cookie).post('/import/companies', { csv: 'name,domain\nOwned Co,owned.test\n' });
    const { db } = getDb();
    const [co] = await db.select().from(schema.companies).where(eq(schema.companies.domain, 'owned.test'));
    expect(co?.ownerId).toBe(users.owner!.userId);
    expect(co?.portalToken).toBeTruthy();
  });

  it('reads semicolon-separated files', async () => {
    const res = await json(reqAs(users.owner!.cookie).post('/import/companies', { csv: 'name;domain;defaultCurrency\nSemi Co;semi.test;eur\n' }));
    expect(res.imported).toBe(1);
    const { db } = getDb();
    const [co] = await db.select().from(schema.companies).where(eq(schema.companies.domain, 'semi.test'));
    expect(co?.name).toBe('Semi Co');
    expect(co?.defaultCurrency).toBe('EUR');
  });
});

describe('lead round trip', () => {
  it('re-imports the export without duplicates and keeps an ended lead ended', async () => {
    const owner = reqAs(users.owner!.cookie);
    const company = await json(owner.post('/companies', { name: 'Lead Trip Co' }));
    const open = await json(owner.post('/leads', { companyId: company.id, title: 'Open lead', status: 'ready', painSignal: 'Manual reports' }));
    const ended = await json(owner.post('/leads', { companyId: company.id, title: 'Ended lead', status: 'engaged' }));
    await getDb().db.update(schema.leads).set({ status: 'disqualified' }).where(eq(schema.leads.id, ended.id));

    const text = Buffer.from(await (await owner.get(`/export/leads.csv?companyId=${company.id}`)).arrayBuffer()).toString('utf8');
    const [header, ...rows] = parseCsv(text);
    expect(rows).toHaveLength(2);

    // Unchanged file: every row updates its own lead, nothing new appears.
    const same = await json(owner.post('/import/leads', { csv: text }));
    expect(same.errors).toEqual([]);
    expect(same.created).toBe(0);
    expect(same.updated).toBe(2);
    const list = await json(owner.get(`/leads?companyId=${company.id}`));
    expect(list.data).toHaveLength(2);

    // Reopening the disqualified lead through the file is refused, not silently done.
    const col = (name: string) => header!.indexOf(name);
    const reopened = rows.map((r) => r[col('id')] === ended.id ? r.map((v, i) => (i === col('status') ? 'new' : v)) : r);
    const csv = [header!, ...reopened].map((r) => r.map((v) => `"${v.replace(/"/g, '""')}"`).join(',')).join('\n');
    const res = await json(owner.post('/import/leads', { csv, dryRun: true }));
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0].message).toContain('disqualified');

    // Fields beyond the first nine survive the trip.
    const lead = await json(owner.get(`/leads/${open.id}`));
    expect(lead.painSignal).toBe('Manual reports');
  });
});

describe('task round trip', () => {
  it('updates tasks by ref, matching status by name', async () => {
    const owner = reqAs(users.owner!.cookie);
    const res = await json(owner.post('/import/tasks', { csv: 'projectKey,title,dueDate,estimate\nIMP,Dated task,2026-12-01,3\n' }));
    expect(res.created).toBe(1);

    const text = await (await owner.get('/export/tasks.csv')).text();
    const [header, ...rows] = parseCsv(text.replace(/^﻿/, ''));
    const row = rows.find((r) => r[header!.indexOf('title')] === 'Dated task')!;
    expect(row[header!.indexOf('dueDate')]).toBe('2026-12-01');
    expect(row[header!.indexOf('estimate')]).toBe('3');
    const ref = row[header!.indexOf('ref')]!;

    // Any status but the default one; the file names it in another case.
    const statuses = await getDb().db.select().from(schema.taskStatuses)
      .where(eq(schema.taskStatuses.projectId, projectId)).orderBy(asc(schema.taskStatuses.position));
    const statusName = statuses.find((st) => !st.isDefault)!.name;

    const update = await json(owner.post('/import/tasks', { csv: `ref,title,status\n${ref},Renamed task,${statusName.toUpperCase()}\n` }));
    expect(update.errors).toEqual([]);
    expect(update.updated).toBe(1);
    expect(update.created).toBe(0);

    const bad = await json(owner.post('/import/tasks', { csv: `ref,title,status\n${ref},Renamed task,No such status\n`, dryRun: true }));
    expect(bad.errors[0].message).toContain('No such status');

    const { db } = getDb();
    const [task] = await db.select().from(schema.tasks).where(and(eq(schema.tasks.projectId, projectId), eq(schema.tasks.title, 'Renamed task')));
    const [status] = await db.select().from(schema.taskStatuses).where(eq(schema.taskStatuses.id, task!.statusId));
    expect(status?.name).toBe(statusName);
  });
});

describe('time export period', () => {
  it('limits the file to the dates asked for', async () => {
    const owner = reqAs(users.owner!.cookie);
    const task = await json(owner.post('/tasks', { projectId, title: 'Timed' }));
    const { db } = getDb();
    for (const day of ['2026-03-01', '2026-03-15', '2026-04-01']) {
      await db.insert(schema.timeEntries).values({
        id: ulid(), taskId: task.id, userId: users.owner!.userId, projectId,
        startedAt: new Date(`${day}T10:00:00Z`), durationSeconds: 3600, note: `on ${day}`, billable: false,
      });
    }
    const text = await (await owner.get('/export/time.csv?from=2026-03-01&to=2026-03-15')).text();
    expect(text).toContain('on 2026-03-01');
    expect(text).toContain('on 2026-03-15');
    expect(text).not.toContain('on 2026-04-01');
    expect((await owner.get('/export/time.csv?from=2026-04-02&to=2026-04-01')).status).toBe(400);
  });
});
