/**
 * The public intake form end to end (PRD §8.6): the configured fields reach
 * the page and come back validated, custom answers land on the request and
 * in the task, files ride along when the form takes them, the requester gets
 * a receipt, the rate limit lives in the database, and a rotated token kills
 * the old link. Storage is mocked in-memory (./s3-mock).
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { getDb, schema, eq } from '@ordi/db';
import { resetDb, seedRolesAndUsers, reqAs, json, app } from './helpers';

vi.mock('../lib/s3', () => import('./s3-mock'));

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
let projectId: string;
let token: string;
let statusId: string;
let ipSeq = 0;

/** Every submission from its own address, unless a test is about the limit. */
function submit(body: unknown, ip = `10.0.0.${++ipSeq}`, formToken = token) {
  return app.request(`/api/v1/intake/${formToken}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });
}

function submitForm(form: FormData, ip = `10.0.1.${++ipSeq}`) {
  return app.request(`/api/v1/intake/${token}`, { method: 'POST', headers: { 'x-forwarded-for': ip }, body: form });
}

async function items() {
  const { db } = getDb();
  return db.select().from(schema.intakeItems).where(eq(schema.intakeItems.projectId, projectId));
}

const FORM = {
  heading: 'Start a project',
  intro: 'Tell us what you need.',
  submitLabel: 'Send brief',
  successMessage: 'Thanks, we will reply within a day.',
  accentColor: '#e11d48',
  acknowledge: true,
  allowAttachments: true,
  maxAttachments: 2,
  fields: [
    { key: 'title', label: 'What do you need?' },
    { key: 'requesterName', required: true },
    { key: 'requesterEmail', required: true },
    { key: 'description' },
    { key: 'budget', label: 'Budget', type: 'select', options: ['< $5k', '$5k+'], required: true },
    { key: 'site', label: 'Current site', type: 'url' },
    { key: 'secret', label: 'Internal note', type: 'text', hidden: true },
  ],
};

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
  const owner = reqAs(users.owner!.cookie);
  const type = await json(owner.post('/project-types', { name: 'Client work', revenueSource: 'none' }));
  projectId = (await json(owner.post('/projects', { name: 'Website', key: 'WEB', projectTypeId: type.id, visibility: 'private' }))).id;
  const statuses = (await json(owner.get(`/projects/${projectId}/task-statuses`))).data as any[];
  statusId = statuses.find((s) => s.category === 'todo')!.id;
  const settings = await json(owner.patch(`/projects/${projectId}/intake-settings`, { formEnabled: true }));
  token = settings.formToken;
});

describe('the default form', () => {
  it('asks for name, email, subject and details', async () => {
    const form = await json(app.request(`/api/v1/intake/${token}`));
    expect(form.projectName).toBe('Website');
    expect(form.form.fields.map((f: any) => f.key)).toEqual(['requesterName', 'requesterEmail', 'title', 'description']);
    expect(form.form.attachments).toBeNull();
  });

  it('takes a submission in the shape the page sends', async () => {
    const res = await submit({ values: { requesterName: 'Olena', requesterEmail: 'olena@example.com', title: 'Fix the footer' } });
    expect(res.status).toBe(200);
    const [item] = await items();
    expect(item).toMatchObject({ source: 'form', requesterName: 'Olena', title: 'Fix the footer', status: 'pending' });
    expect(item!.submitterKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it('still takes the flat body API callers used to send', async () => {
    const res = await submit({ requesterName: 'Bot', title: 'Legacy shape' });
    expect(res.status).toBe(200);
    expect((await items()).some((i) => i.title === 'Legacy shape')).toBe(true);
  });

  it('answers a filled honeypot with ok and stores nothing', async () => {
    const before = (await items()).length;
    const res = await submit({ values: { requesterName: 'Spam', title: 'Buy now' }, honeypot: 'http://spam' });
    expect(res.status).toBe(200);
    expect((await items()).length).toBe(before);
  });

  it('queues a receipt for a requester with an email', async () => {
    const { db } = getDb();
    const mails = await db.select().from(schema.emailDeliveries).where(eq(schema.emailDeliveries.to, 'olena@example.com'));
    expect(mails).toHaveLength(1);
    expect(mails[0]!.subject).toBe('We received your request');
    expect(mails[0]!.body).toContain('Fix the footer');
    // Nothing else a stranger typed rides along under the workspace's sender.
    expect(mails[0]!.body).not.toContain('Olena');
  });

  it('refuses an oversized body before parsing it', async () => {
    const res = await submit({ values: { requesterName: 'Big', title: 'x' }, padding: 'x'.repeat(300 * 1024) });
    expect(res.status).toBe(400);
  });
});

describe('configuring the form', () => {
  it('is for project admins only', async () => {
    const res = await reqAs(users.member!.cookie).patch(`/projects/${projectId}/intake-settings`, { formConfig: FORM });
    expect([403, 404]).toContain(res.status);
  });

  it('refuses a config that does not hold together', async () => {
    const owner = reqAs(users.owner!.cookie);
    const res = await owner.patch(`/projects/${projectId}/intake-settings`, {
      formConfig: { fields: [{ key: 'budget', type: 'select', label: 'Budget' }] },
    });
    expect(res.status).toBe(400);
  });

  it('saves the fields and hands the page only the visible ones', async () => {
    const owner = reqAs(users.owner!.cookie);
    const saved = await json(owner.patch(`/projects/${projectId}/intake-settings`, { formConfig: FORM }));
    expect(saved.formConfig.fields.find((f: any) => f.key === 'secret').hidden).toBe(true);

    const form = await json(app.request(`/api/v1/intake/${token}`));
    expect(form.form).toMatchObject({ heading: 'Start a project', submitLabel: 'Send brief', accentColor: '#e11d48' });
    expect(form.form.fields.map((f: any) => f.key)).toEqual(['title', 'requesterName', 'requesterEmail', 'description', 'budget', 'site']);
    expect(form.form.fields[0]).not.toHaveProperty('hidden');
    expect(form.form.attachments).toMatchObject({ maxFiles: 2 });
  });

  it('names every field that needs another look', async () => {
    const res = await submit({ values: { title: 'Redesign', requesterEmail: 'nope', budget: 'a lot', site: 'ftp://x' } });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error.details.fields).toEqual({
      requesterName: 'required', requesterEmail: 'invalid', budget: 'invalid', site: 'invalid',
    });
  });

  it('stores custom answers, ignores hidden fields, and writes them into the task on accept', async () => {
    const res = await submit({
      values: {
        title: 'Redesign', requesterName: 'Taras', requesterEmail: 'taras@example.com',
        description: 'New brand.\nNeeds a blog.', budget: '$5k+', site: 'https://old.example.com', secret: 'smuggled',
      },
    });
    expect(res.status).toBe(200);
    const item = (await items()).find((i) => i.title === 'Redesign')!;
    expect(item.answers).toEqual([
      { key: 'budget', label: 'Budget', type: 'select', value: '$5k+' },
      { key: 'site', label: 'Current site', type: 'url', value: 'https://old.example.com' },
    ]);

    const owner = reqAs(users.owner!.cookie);
    const listed = (await json(owner.get(`/projects/${projectId}/intake`))).data as any[];
    const card = listed.find((i) => i.id === item.id);
    expect(card.answers).toHaveLength(2);
    expect(card).not.toHaveProperty('submitterKey');

    const accepted = await json(owner.post(`/intake/${item.id}/accept`, { statusId }));
    const task = await json(owner.get(`/tasks/${accepted.taskId}`));
    const text = JSON.stringify(task.description);
    expect(text).toContain('Needs a blog.');
    expect(text).toContain('Budget: ');
    expect(text).toContain('$5k+');
    expect(text).not.toContain('smuggled');
  });
});

describe('files on the form', () => {
  const answers = { title: 'With files', requesterName: 'Iryna', requesterEmail: 'iryna@example.com', budget: '< $5k' };

  it('stores them on the request', async () => {
    const form = new FormData();
    form.append('payload', JSON.stringify({ values: answers }));
    form.append('files', new File(['brief'], 'brief.pdf', { type: 'application/pdf' }));
    form.append('files', new File(['logo'], '../../logo.png', { type: 'image/png' }));
    const res = await submitForm(form);
    expect(res.status).toBe(200);
    const item = (await items()).find((i) => i.title === 'With files')!;
    const manifest = item.attachments as any[];
    expect(manifest.map((a) => a.filename)).toEqual(['brief.pdf', 'logo.png']);
    const { db } = getDb();
    const [att] = await db.select().from(schema.attachments).where(eq(schema.attachments.id, manifest[0].attachmentId));
    expect(att).toMatchObject({ entityType: 'intake_item', entityId: item.id });
  });

  it('refuses more files than the form allows, and blocked types', async () => {
    const tooMany = new FormData();
    tooMany.append('payload', JSON.stringify({ values: answers }));
    for (const name of ['a.txt', 'b.txt', 'c.txt']) tooMany.append('files', new File(['x'], name));
    expect((await submitForm(tooMany)).status).toBe(400);

    for (const name of ['setup.exe', 'setup.exe.', 'setup.exe .', `${'a'.repeat(195)}.exe.${'b'.repeat(10)}`]) {
      const blocked = new FormData();
      blocked.append('payload', JSON.stringify({ values: answers }));
      blocked.append('files', new File(['x'], name));
      expect((await submitForm(blocked)).status).toBe(400);
    }
  });
});

describe('the rate limit', () => {
  it('counts stored requests per address', async () => {
    const values = { title: 'Burst', requesterName: 'R', requesterEmail: 'burst@example.com', budget: '< $5k' };
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) statuses.push((await submit({ values }, '192.0.2.7')).status);
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses[5]).toBe(429);
    expect((await submit({ values }, '192.0.2.8')).status).toBe(200);
  });

  it('is not dodged by a forged X-Forwarded-For entry', async () => {
    // The proxy appends the real address; only the left part is the client's to choose.
    const values = { title: 'Forged', requesterName: 'F', requesterEmail: 'forged@example.com', budget: '< $5k' };
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) statuses.push((await submit({ values }, `10.9.9.${i}, 192.0.2.50`)).status);
    expect(statuses[5]).toBe(429);
  });

  it('caps receipts per recipient, across every project and whatever the case', async () => {
    const { db } = getDb();
    const mails = await db.select().from(schema.emailDeliveries).where(eq(schema.emailDeliveries.to, 'burst@example.com'));
    expect(mails).toHaveLength(3);

    // A second project's form aimed at the same person sends them nothing more.
    const owner = reqAs(users.owner!.cookie);
    const type = await json(owner.post('/project-types', { name: 'Other', revenueSource: 'none' }));
    const other = (await json(owner.post('/projects', { name: 'Other', key: 'OTH', projectTypeId: type.id, visibility: 'private' }))).id;
    const otherToken = (await json(owner.patch(`/projects/${other}/intake-settings`, { formEnabled: true }))).formToken;
    const res = await submit({ values: { requesterName: 'R', requesterEmail: 'BURST@example.com', title: 'Elsewhere' } }, '198.51.100.1', otherToken);
    expect(res.status).toBe(200);
    const after = await db.select().from(schema.emailDeliveries).where(eq(schema.emailDeliveries.to, 'burst@example.com'));
    expect(after).toHaveLength(3);
  });
});

describe('rotating the link', () => {
  it('kills the old token and serves the new one', async () => {
    const owner = reqAs(users.owner!.cookie);
    expect([403, 404]).toContain((await reqAs(users.member!.cookie).post(`/projects/${projectId}/intake-settings/rotate-token`)).status);
    const rotated = await json(owner.post(`/projects/${projectId}/intake-settings/rotate-token`));
    expect(rotated.formToken).not.toBe(token);
    expect((await app.request(`/api/v1/intake/${token}`)).status).toBe(404);
    expect((await app.request(`/api/v1/intake/${rotated.formToken}`)).status).toBe(200);
    token = rotated.formToken;
  });
});

describe('the embed loader', () => {
  it('is served as JavaScript under /api/v1 and the root', async () => {
    for (const path of ['/api/v1/embed/intake.js', '/embed/intake.js']) {
      const res = await app.request(path);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('javascript');
      expect(await res.text()).toContain('data-ordi-intake');
    }
  });
});

describe('hidden fields and prefill', () => {
  it('keeps hidden values the site passed, and hands their source to the page', async () => {
    const owner = reqAs(users.owner!.cookie);
    const type = await json(owner.post('/project-types', { name: 'Support', revenueSource: 'none' }));
    const id = (await json(owner.post('/projects', { name: 'Support', key: 'SUP', projectTypeId: type.id, visibility: 'private' }))).id;
    const settings = await json(owner.patch(`/projects/${id}/intake-settings`, {
      formEnabled: true,
      formConfig: {
        fields: [
          { key: 'title' },
          { key: 'requesterEmail', required: true },
          { key: 'page', label: 'Page', type: 'hidden', source: 'page' },
          { key: 'accountId', label: 'Account', type: 'hidden' },
        ],
      },
    }));

    const form = await json(app.request(`/api/v1/intake/${settings.formToken}`));
    expect(form.form.fields.find((f: any) => f.key === 'page')).toMatchObject({ type: 'hidden', source: 'page', required: false });

    const res = await submit({
      values: { title: 'Checkout broken', requesterEmail: 'Anna@Example.com', page: 'https://shop.example.com/cart?step=2', accountId: 'acc_42' },
    }, undefined, settings.formToken);
    expect(res.status).toBe(200);
    const { db } = getDb();
    const [item] = await db.select().from(schema.intakeItems).where(eq(schema.intakeItems.projectId, id));
    expect(item!.requesterEmail).toBe('anna@example.com');
    expect(item!.answers).toEqual([
      { key: 'page', label: 'Page', type: 'hidden', value: 'https://shop.example.com/cart?step=2' },
      { key: 'accountId', label: 'Account', type: 'hidden', value: 'acc_42' },
    ]);
  });
});

describe('the embed loader on a page', () => {
  /** Run the loader against a minimal stand-in for a host page; returns the iframe it made. */
  async function runLoader(attributes: Record<string, string>, pageUrl = 'https://site.example.com/help?x=1#top') {
    const source = await (await app.request('/api/v1/embed/intake.js')).text();
    const frames: any[] = [];
    const container = {
      attributes: Object.entries(attributes).map(([name, value]) => ({ name, value })),
      getAttribute(name: string) { return this.attributes.find((a) => a.name === name)?.value ?? null; },
      setAttribute(name: string, value: string) { this.attributes.push({ name, value }); },
      appendChild(el: any) { frames.push(el); },
    };
    const document = {
      currentScript: { src: 'https://ordi.example.com/api/v1/embed/intake.js' },
      readyState: 'complete',
      querySelectorAll: () => [container],
      createElement: () => ({ style: {}, setAttribute() {} }),
    };
    const window = { location: { href: pageUrl }, addEventListener() {} } as any;
    new Function('window', 'document', source)(window, document);
    return { frame: frames[0], api: window.ordiIntake };
  }

  it('puts prefill, the lock and the page address in the fragment, not the query', async () => {
    const { frame, api } = await runLoader({
      'data-ordi-intake': 'tok123',
      'data-lang': 'uk',
      'data-prefill-requester-email': 'anna@example.com',
      'data-prefill-account_id': 'acc 42',
      'data-lock-prefilled': '',
    });
    const url = new URL(frame.src);
    expect(url.origin + url.pathname).toBe('https://ordi.example.com/intake/tok123');
    expect(url.search).toBe('?embed=1&lang=uk');
    const hash = new URLSearchParams(url.hash.slice(1));
    expect(hash.get('requesterEmail')).toBe('anna@example.com');
    expect(hash.get('account_id')).toBe('acc 42');
    expect(hash.get('_lock')).toBe('1');
    expect(hash.get('_page')).toBe('https://site.example.com/help?x=1');
    expect(typeof api.mount).toBe('function');
  });
});
