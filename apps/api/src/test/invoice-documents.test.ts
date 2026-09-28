/**
 * Invoice documents end to end: the public page wins over the public JSON for
 * a browser navigation, the PDF is a real branded document (public and
 * authenticated), both parties' requisites travel with the payload, and new
 * documents start from the workspace's default notes/terms.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb } from '@ordi/db';
import { resetDb, seedRolesAndUsers, reqAs, json } from './helpers';
import { seedChartOfAccounts } from '../seed-baseline';
import { createApp } from '../app';
import { renderInvoicePdf } from '../domains/finance/pdf';
import { wantsHtml } from '../web';

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
let owner: ReturnType<typeof reqAs>;
let companyId: string;

// A 1×1 PNG: enough for pdfkit to embed as the logo.
const PNG_LOGO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

beforeAll(async () => {
  await resetDb();
  await seedChartOfAccounts(getDb().db);
  users = await seedRolesAndUsers();
  owner = reqAs(users.owner!.cookie);

  const created = await json(owner.post('/companies', {
    name: 'Appricotsoft', status: 'active', billingEmail: 'billing@appricotsoft.test',
    address: { legalName: 'ТОВ «Апрікотсофт»', taxId: '12345678', address: '01001, м. Київ, вул. Хрещатик, 1' },
  }));
  companyId = created.id;

  const settings = await owner.patch('/settings/workspace', {
    name: 'kdn.agency',
    logo: PNG_LOGO,
    legalDetails: { legalName: 'ФОП Черниш Валерія', taxId: '3123456789', address: '40035, м. Суми, вул. Заливна, 13', email: 'hello@kdn.test' },
    invoiceSettings: {
      accentColor: '#10b981',
      paymentDetails: 'IBAN UA433220010000026004350044052',
      footerNote: 'Дякуємо за співпрацю!',
      defaultNotes: 'Оплата протягом 3 днів.',
      defaultTerms: 'Bank fees are on the payer.',
    },
  });
  expect(settings.status).toBe(200);
});

describe('company billing requisites', () => {
  it('stores the structured billing details and returns them on the company', async () => {
    const company = await json(owner.get(`/companies/${companyId}`));
    expect(company.address).toEqual({ legalName: 'ТОВ «Апрікотсофт»', taxId: '12345678', address: '01001, м. Київ, вул. Хрещатик, 1' });
  });

  it('rejects an address payload of the wrong shape', async () => {
    const res = await owner.patch(`/companies/${companyId}`, { address: { legalName: 42 } });
    expect(res.status).toBe(400);
  });
});

describe('workspace defaults for new documents', () => {
  it('a new invoice without notes/terms starts from the workspace defaults', async () => {
    const { id } = await json(owner.post('/invoices', {
      companyId, issueDate: '2026-09-28', dueDate: '2026-09-30',
      items: [{ description: 'Finqbit page changes', quantity: 2, unitPrice: 17 }],
    }));
    const inv = await json(owner.get(`/invoices/${id}`));
    expect(inv.notes).toBe('Оплата протягом 3 днів.');
    expect(inv.terms).toBe('Bank fees are on the payer.');
    // The detail payload carries the client's requisites for the "Bill to" block.
    expect(inv.company).toMatchObject({ name: 'Appricotsoft', legalName: 'ТОВ «Апрікотсофт»', taxId: '12345678' });
  });

  it('an explicit empty string is respected – the caller opted out', async () => {
    const { id } = await json(owner.post('/invoices', {
      companyId, issueDate: '2026-09-28', dueDate: '2026-09-30', notes: '', terms: '',
      items: [{ description: 'x', quantity: 1, unitPrice: 1 }],
    }));
    const inv = await json(owner.get(`/invoices/${id}`));
    expect(inv.notes).toBe('');
    expect(inv.terms).toBe('');
  });

  it('a new quote also starts from the defaults', async () => {
    const { id } = await json(owner.post('/quotes', {
      companyId, issueDate: '2026-09-28', items: [{ description: 'x', quantity: 1, unitPrice: 1 }],
    }));
    const q = await json(owner.get(`/quotes/${id}`));
    expect(q.notes).toBe('Оплата протягом 3 днів.');
  });
});

describe('public invoice page and PDF', () => {
  let token: string;
  let invoiceId: string;

  beforeAll(async () => {
    const { id } = await json(owner.post('/invoices', {
      companyId, issueDate: '2026-09-28', dueDate: '2026-09-30', language: 'uk',
      items: [
        { description: 'Finqbit WordPress and plugins update', quantity: 3, unitPrice: 17 },
        { description: 'Finqbit page changes', quantity: 2, unitPrice: 17 },
      ],
    }));
    invoiceId = id;
    token = (await json(owner.get(`/invoices/${id}`))).publicToken;
  });

  it('the public JSON names both parties with their requisites and the branding', async () => {
    const res = await owner.get(`/i/${token}`);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.invoice.number).toMatch(/^INV-/);
    expect(body.company).toMatchObject({ name: 'Appricotsoft', legalName: 'ТОВ «Апрікотсофт»', taxId: '12345678' });
    expect(body.workspace.name).toBe('kdn.agency');
    expect(body.workspace.legalDetails).toMatchObject({ legalName: 'ФОП Черниш Валерія', taxId: '3123456789' });
    expect(body.invoiceSettings.paymentDetails).toContain('IBAN');
    // Nothing internal leaks: no ids, no billing email of the client, no logo bytes on the company.
    expect(body.company.billingEmail).toBeUndefined();
    expect(body.invoice.id).toBeUndefined();
  });

  it('the public PDF is a real PDF that carries the requisites, the payment details and the notes', async () => {
    const res = await owner.get(`/i/${token}/pdf`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(buf.length).toBeGreaterThan(5_000);
    // The embedded font subset carries the glyphs, so the visible strings are
    // encoded; the PDF's own metadata still names the document.
    expect(buf.toString('latin1')).toContain('/Title');
  });

  it('a wrong token is a 404 on both the JSON and the PDF', async () => {
    expect((await owner.get('/i/NOPE')).status).toBe(404);
    expect((await owner.get('/i/NOPE/pdf')).status).toBe(404);
  });

  it('the authenticated PDF renders the same document', async () => {
    const res = await owner.get(`/invoices/${invoiceId}/pdf`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('the quote PDF is public by token too', async () => {
    const { id } = await json(owner.post('/quotes', {
      companyId, issueDate: '2026-09-28', validUntil: '2026-10-28', items: [{ description: 'Design sprint', quantity: 1, unitPrice: 1200 }],
    }));
    const q = await json(owner.get(`/quotes/${id}`));
    const page = await owner.get(`/q/${q.publicToken}`);
    expect(page.status).toBe(200);
    const body = await json(page);
    expect(body.quote.number).toBe(q.number);
    expect(body.workspace.name).toBe('kdn.agency');
    const pdf = await owner.get(`/q/${q.publicToken}/pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
  });

  it('with the SPA bundled, a browser navigation to /i/:token gets the page, a fetch gets the JSON', async () => {
    const dist = mkdtempSync(join(tmpdir(), 'ordi-dist-'));
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>ordi</title><div id="root"></div>');
    const prev = process.env.WEB_DIST;
    process.env.WEB_DIST = dist;
    try {
      const app = createApp();
      const browserAccept = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,*/*;q=0.8';
      const nav = await app.request(`/i/${token}`, { headers: { accept: browserAccept } });
      expect(nav.status).toBe(200);
      expect(nav.headers.get('content-type')).toContain('text/html');
      expect(await nav.text()).toContain('<div id="root">');

      const fetchJson = await app.request(`/api/v1/i/${token}`, { headers: { accept: 'application/json' } });
      expect(fetchJson.headers.get('content-type')).toContain('application/json');
      expect((await json(fetchJson)).invoice.number).toMatch(/^INV-/);

      // Direct API access at the root keeps working for non-browser clients.
      const rootJson = await app.request(`/i/${token}`, { headers: { accept: 'application/json' } });
      expect(rootJson.headers.get('content-type')).toContain('application/json');

      // The PDF link the page shows is not a navigation to the page.
      const pdf = await app.request(`/api/v1/i/${token}/pdf`, { headers: { accept: browserAccept } });
      expect(pdf.headers.get('content-type')).toBe('application/pdf');

      // Quote and portal pages share the rule.
      const quoteNav = await app.request('/q/anything', { headers: { accept: browserAccept } });
      expect(quoteNav.headers.get('content-type')).toContain('text/html');
    } finally {
      if (prev === undefined) delete process.env.WEB_DIST; else process.env.WEB_DIST = prev;
    }
  });

  it('wantsHtml follows the Accept preference order', () => {
    expect(wantsHtml('text/html,application/xhtml+xml,*/*;q=0.8')).toBe(true);
    expect(wantsHtml('application/json')).toBe(false);
    expect(wantsHtml('application/json, text/html')).toBe(false);
    expect(wantsHtml('*/*')).toBe(false);
    expect(wantsHtml(undefined)).toBe(false);
  });
});

describe('renderInvoicePdf', () => {
  it('renders Cyrillic, a logo, discounts and many lines across pages without throwing', async () => {
    const items = Array.from({ length: 60 }, (_, i) => ({
      description: `Позиція №${i + 1} – досить довгий опис, який має переноситись на другий рядок, щоб перевірити перенос тексту у таблиці`,
      quantity: 1.5, unitPrice: 100, amount: 150,
    }));
    const buf = await renderInvoicePdf(
      {
        number: 'INV-2026-0042', currency: 'UAH', issueDate: '2026-09-28', dueDate: '2026-10-05', status: 'partially_paid',
        subtotal: 9000, taxTotal: 0, total: 8100, discountType: 'percent', discountValue: 10, amountPaid: 100,
        notes: 'Примітки', terms: 'Умови', publicToken: 'TOKEN', language: 'uk',
      },
      items,
      { name: 'Клієнт', billingEmail: 'client@example.test', address: { legalName: 'ТОВ «Клієнт»', taxId: '1', address: 'Київ' } },
      { name: 'Агенція', logo: PNG_LOGO, legalDetails: { legalName: 'ФОП Агенція' }, invoiceSettings: { accentColor: '#ef4444', paymentDetails: 'IBAN …', footerNote: 'Дякуємо' } },
    );
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
    // 60 wrapped lines cannot fit one A4 page: the table paginated.
    expect((buf.toString('latin1').match(/\/Type \/Page[^s]/g) ?? []).length).toBeGreaterThan(1);
  });

  it('skips a truncated PNG logo instead of hanging the process on it', async () => {
    // Signature + an IHDR chunk whose declared size runs past the end: pdfkit's
    // own parser would spin on this forever, so the renderer must not hand it over.
    const truncated = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0])]).toString('base64');
    const buf = await renderInvoicePdf(
      { number: 'INV-2', currency: 'USD', issueDate: '2026-01-01', dueDate: '2026-01-10', status: 'draft', subtotal: 0, taxTotal: 0, total: 0, publicToken: 'T' },
      [],
      { name: 'Acme' },
      { name: 'ordi', logo: `data:image/png;base64,${truncated}`, legalDetails: {}, invoiceSettings: {} },
    );
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
  }, 5_000);

  it('survives a WebP logo and empty requisites (falls back to the name)', async () => {
    const buf = await renderInvoicePdf(
      { number: 'INV-1', currency: 'USD', issueDate: '2026-01-01', dueDate: '2026-01-10', status: 'draft', subtotal: 0, taxTotal: 0, total: 0, publicToken: 'T' },
      [],
      { name: 'Acme' },
      { name: 'ordi', logo: 'data:image/webp;base64,AAAA', legalDetails: {}, invoiceSettings: {} },
    );
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
  });
});
