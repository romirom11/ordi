/**
 * CSV import/export (PRD §14.6). Tiny dependency-free CSV parse/serialize
 * (quoted fields, embedded commas/newlines/quotes, comma or semicolon
 * separated). Exports stream the full (non-deleted) result as text/csv
 * attachments; imports accept {csv, dryRun} and validate per line before
 * writing anything (all-or-nothing transaction for the valid rows).
 *
 * Export and import share column names, so an exported file can be edited and
 * fed back: a row whose `id` (tasks: `ref`) names an existing record updates
 * it – only the columns the file carries – instead of creating a duplicate.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { ulid } from 'ulid';
import { getDb, schema, eq, and, isNull, inArray, asc, desc, gte, lt, sql } from '@ordi/db';
import { COMPANY_STATUSES, TASK_PRIORITIES, appendPosition } from '@ordi/shared';
import type { AppEnv } from '../../context';
import { requireAuth, currentActor } from '../../core/auth';
import { guard } from '../../core/rbac';
import { accessibleProjectIds, effectiveProjectRole } from '../../core/access';
import { writeActivity } from '../../core/activity';
import { emit } from '../../core/events';
import { err } from '../../lib/errors';
import { exportLeads } from '../crm/service';

// ── CSV primitives ──

/** UTF-8 byte-order mark: without it Excel reads an export as Latin-1. */
const BOM = '﻿';

/**
 * Excel in locales with a decimal comma (Ukrainian among them) saves "CSV" with
 * semicolons. The header row decides: whichever separator it uses more often,
 * outside quotes, is the file's separator.
 */
function detectDelimiter(text: string): ',' | ';' {
  let commas = 0;
  let semicolons = 0;
  let inQuotes = false;
  for (const ch of text) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes) {
      if (ch === '\n') break;
      if (ch === ',') commas += 1;
      else if (ch === ';') semicolons += 1;
    }
  }
  return semicolons > commas ? ';' : ',';
}

export function parseCsv(text: string): string[][] {
  // Spreadsheets save UTF-8 with a byte-order mark; left in place it becomes
  // part of the first header name, and the file no longer imports.
  if (text.startsWith(BOM)) text = text.slice(BOM.length);
  const delimiter = detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      field += ch; i += 1; continue;
    }
    if (ch === '"') { inQuotes = true; i += 1; continue; }
    if (ch === delimiter) { row.push(field); field = ''; i += 1; continue; }
    if (ch === '\r') { i += 1; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i += 1; continue; }
    field += ch; i += 1;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

/**
 * Text a spreadsheet would run as a formula (=, +, -, @, or a leading tab/CR).
 * Exports carry text nobody here wrote – lead research, intake mail, client
 * names – so a cell like `=HYPERLINK(...)` must open as text, not execute.
 */
const FORMULA_START = /^[=+\-@\t\r]/;
/** "+380 (67) 123-45-67", "-12.5": digits and punctuation only, nothing to run. */
const PLAIN_NUMBER = /^[+-]?[\d\s().,-]+$/;

function guardFormula(s: string): string {
  return FORMULA_START.test(s) && !PLAIN_NUMBER.test(s) ? `'${s}` : s;
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = v instanceof Date ? v.toISOString() : String(v);
  // Only strings: a number column is never an injected formula.
  if (typeof v === 'string') s = guardFormula(s);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}

function csvResponse(c: Context<AppEnv>, filename: string, csv: string): Response {
  c.header('Content-Type', 'text/csv; charset=utf-8');
  c.header('Content-Disposition', `attachment; filename="${filename}"`);
  // Excel ignores the charset in the header and guesses the encoding; the BOM
  // is what makes it read the file as UTF-8 instead of mangling every accent.
  return c.body(BOM + csv);
}

/** header name (case-insensitive) → column index. */
function headerMap(header: string[]): Map<string, number> {
  const map = new Map<string, number>();
  header.forEach((h, i) => map.set(h.trim().toLowerCase(), i));
  return map;
}

const importBodySchema = z.object({
  csv: z.string().min(1),
  dryRun: z.boolean().default(false),
});

const dateParam = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').optional();
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

interface ImportError { line: number; message: string }

/**
 * What every import answers: how many rows create, how many update. A real
 * run also says `imported` (both together), the field older clients read.
 */
interface ImportSummary { rows: number; valid: number; created: number; updated: number; imported?: number; errors: ImportError[] }

function summary(rows: number, created: number, updated: number, errors: ImportError[], dryRun = true): ImportSummary {
  const out: ImportSummary = { rows, valid: created + updated, created, updated, errors };
  if (!dryRun) out.imported = created + updated;
  return out;
}

export function importExportRoutes() {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth);

  // ── Exports ──

  app.get('/export/companies.csv', guard('crm.export'), async (c) => {
    const { db } = getDb();
    const rows = await db.select().from(schema.companies)
      .where(isNull(schema.companies.deletedAt)).orderBy(asc(schema.companies.name));
    const csv = toCsv(
      ['id', 'name', 'domain', 'status', 'billingEmail', 'defaultCurrency', 'paymentTermsDays', 'createdAt'],
      rows.map((r) => [r.id, r.name, r.domain, r.status, r.billingEmail, r.defaultCurrency, r.paymentTermsDays, r.createdAt]),
    );
    return csvResponse(c, 'companies.csv', csv);
  });

  app.get('/export/contacts.csv', guard('crm.export'), async (c) => {
    const { db } = getDb();
    const rows = await db.select({
      id: schema.contacts.id, companyName: schema.companies.name,
      firstName: schema.contacts.firstName, lastName: schema.contacts.lastName,
      email: schema.contacts.email, phone: schema.contacts.phone,
      position: schema.contacts.position, isPrimary: schema.contacts.isPrimary,
      createdAt: schema.contacts.createdAt,
    }).from(schema.contacts)
      .innerJoin(schema.companies, eq(schema.contacts.companyId, schema.companies.id))
      .where(isNull(schema.contacts.deletedAt))
      .orderBy(asc(schema.companies.name), asc(schema.contacts.firstName));
    const csv = toCsv(
      ['id', 'companyName', 'firstName', 'lastName', 'email', 'phone', 'position', 'isPrimary', 'createdAt'],
      rows.map((r) => [r.id, r.companyName, r.firstName, r.lastName, r.email, r.phone, r.position, r.isPrimary, r.createdAt]),
    );
    return csvResponse(c, 'contacts.csv', csv);
  });

  /**
   * The whole lead record per row, not the handful of columns the table shows.
   * Takes the lead list's own filters so the CRM can export what is on screen;
   * without them it is every lead in the workspace.
   */
  app.get('/export/leads.csv', guard('crm.export'), async (c) => {
    const { header, rows } = await exportLeads({
      q: c.req.query('q'),
      status: c.req.query('status'),
      companyId: c.req.query('companyId'),
      ownerId: c.req.query('ownerId'),
    });
    return csvResponse(c, 'leads.csv', toCsv(header, rows));
  });

  /** Same columns the task import reads: edit the file, import it back. */
  app.get('/export/tasks.csv', guard('projects.export'), async (c) => {
    const actor = currentActor(c);
    const { db } = getDb();
    const projectIds = await accessibleProjectIds(actor);
    const header = ['ref', 'projectKey', 'title', 'status', 'priority', 'startDate', 'dueDate', 'estimate'];
    if (!projectIds.length) return csvResponse(c, 'tasks.csv', toCsv(header, []));
    const rows = await db.select({
      key: schema.projects.key, number: schema.tasks.number, title: schema.tasks.title,
      status: schema.taskStatuses.name, priority: schema.tasks.priority,
      startDate: schema.tasks.startDate, dueDate: schema.tasks.dueDate, estimate: schema.tasks.estimate,
    }).from(schema.tasks)
      .innerJoin(schema.projects, eq(schema.tasks.projectId, schema.projects.id))
      .innerJoin(schema.taskStatuses, eq(schema.tasks.statusId, schema.taskStatuses.id))
      .where(and(isNull(schema.tasks.deletedAt), inArray(schema.tasks.projectId, projectIds)))
      .orderBy(asc(schema.projects.key), asc(schema.tasks.number));
    const csv = toCsv(header, rows.map((r) => [
      `${r.key}-${r.number}`, r.key, r.title, r.status, r.priority, r.startDate, r.dueDate,
      r.estimate == null ? null : Number(r.estimate),
    ]));
    return csvResponse(c, 'tasks.csv', csv);
  });

  app.get('/export/invoices.csv', guard('finance.export'), async (c) => {
    const { db } = getDb();
    const rows = await db.select({
      number: schema.invoices.number, company: schema.companies.name,
      status: schema.invoices.status, currency: schema.invoices.currency,
      total: schema.invoices.total, amountPaid: schema.invoices.amountPaid,
      issueDate: schema.invoices.issueDate, dueDate: schema.invoices.dueDate,
    }).from(schema.invoices)
      .innerJoin(schema.companies, eq(schema.invoices.companyId, schema.companies.id))
      .where(isNull(schema.invoices.deletedAt))
      .orderBy(desc(schema.invoices.issueDate));
    const csv = toCsv(
      ['number', 'company', 'status', 'currency', 'total', 'amountPaid', 'issueDate', 'dueDate'],
      rows.map((r) => [r.number, r.company, r.status, r.currency, Number(r.total), Number(r.amountPaid), r.issueDate, r.dueDate]),
    );
    return csvResponse(c, 'invoices.csv', csv);
  });

  /**
   * Time entries, optionally for a period (?from=YYYY-MM-DD&to=YYYY-MM-DD, both
   * inclusive). Time of a deleted project is left out, as in the time reports.
   */
  app.get('/export/time.csv', guard('time.read_all'), async (c) => {
    const from = dateParam.parse(c.req.query('from') || undefined);
    const to = dateParam.parse(c.req.query('to') || undefined);
    if (from && to && from > to) throw err.validation('from must not be after to');
    let toExclusive: Date | undefined;
    if (to) { toExclusive = new Date(`${to}T00:00:00.000Z`); toExclusive.setUTCDate(toExclusive.getUTCDate() + 1); }
    const { db } = getDb();
    const rows = await db.select({
      user: schema.users.name, project: schema.projects.name,
      key: schema.projects.key, taskNumber: schema.tasks.number, taskTitle: schema.tasks.title,
      startedAt: schema.timeEntries.startedAt, durationSeconds: schema.timeEntries.durationSeconds,
      note: schema.timeEntries.note, billable: schema.timeEntries.billable, rate: schema.timeEntries.hourlyRate,
    }).from(schema.timeEntries)
      .innerJoin(schema.users, eq(schema.timeEntries.userId, schema.users.id))
      .innerJoin(schema.projects, eq(schema.timeEntries.projectId, schema.projects.id))
      .innerJoin(schema.tasks, eq(schema.timeEntries.taskId, schema.tasks.id))
      .where(and(
        isNull(schema.projects.deletedAt),
        from ? gte(schema.timeEntries.startedAt, new Date(`${from}T00:00:00.000Z`)) : undefined,
        toExclusive ? lt(schema.timeEntries.startedAt, toExclusive) : undefined,
      ))
      .orderBy(desc(schema.timeEntries.startedAt));
    const csv = toCsv(
      ['user', 'project', 'task', 'taskTitle', 'startedAt', 'hours', 'note', 'billable', 'rate'],
      rows.map((r) => [
        r.user, r.project, `${r.key}-${r.taskNumber}`, r.taskTitle, r.startedAt,
        Math.round((r.durationSeconds / 3600) * 100) / 100, r.note, r.billable,
        // No snapshotted rate is an empty cell, not a rate of 0.
        r.rate == null ? null : Number(r.rate),
      ]),
    );
    const period = from || to ? `-${from ?? 'start'}_${to ?? 'now'}` : '';
    return csvResponse(c, `time${period}.csv`, csv);
  });

  // ── Imports ──

  /** Parse csv text into header-mapped data rows; throws-free, returns errors for the caller. */
  function readRows(csvText: string): { cols: Map<string, number>; data: string[][] } {
    const parsed = parseCsv(csvText);
    const header = parsed[0] ?? [];
    return { cols: headerMap(header), data: parsed.slice(1) };
  }

  function cell(row: string[], cols: Map<string, number>, name: string): string {
    const idx = cols.get(name);
    const v = idx === undefined ? '' : (row[idx] ?? '').trim();
    // Undo csvCell's formula guard, so an exported file imports back unchanged.
    return v.startsWith("'") && guardFormula(v.slice(1)) === v ? v.slice(1) : v;
  }

  /**
   * The columns of `fields` the file carries, as a patch: a file without a
   * column leaves that field alone, an empty cell clears it (`null`).
   */
  function textPatch(row: string[], cols: Map<string, number>, fields: Record<string, string>): Record<string, string | null> {
    const patch: Record<string, string | null> = {};
    for (const [header, field] of Object.entries(fields)) {
      if (cols.has(header)) patch[field] = cell(row, cols, header) || null;
    }
    return patch;
  }

  app.post('/import/companies', guard('crm.write'), async (c) => {
    const actor = currentActor(c);
    const body = importBodySchema.parse(await c.req.json());
    const { cols, data } = readRows(body.csv);
    const errors: ImportError[] = [];
    const creates: Array<Record<string, unknown> & { name: string }> = [];
    const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];

    const { db } = getDb();
    const existing = await db.select({ id: schema.companies.id }).from(schema.companies)
      .where(isNull(schema.companies.deletedAt));
    const known = new Set(existing.map((r) => r.id));

    if (!cols.has('name') && !cols.has('id')) errors.push({ line: 1, message: 'Missing required header: name' });
    else data.forEach((row, i) => {
      const line = i + 2; // 1-based, after header
      const id = cell(row, cols, 'id');
      if (id && !known.has(id)) { errors.push({ line, message: `Unknown company id: ${id}` }); return; }
      const patch: Record<string, unknown> = textPatch(row, cols, { domain: 'domain', billingemail: 'billingEmail' });
      if (cols.has('name')) {
        const name = cell(row, cols, 'name');
        if (!name) { errors.push({ line, message: 'name is required' }); return; }
        patch.name = name;
      }
      const statusRaw = cell(row, cols, 'status');
      if (statusRaw) {
        if (!(COMPANY_STATUSES as readonly string[]).includes(statusRaw)) { errors.push({ line, message: `Unknown status: ${statusRaw}` }); return; }
        patch.status = statusRaw;
      }
      const currencyRaw = cell(row, cols, 'defaultcurrency').toUpperCase();
      if (currencyRaw) {
        if (!/^[A-Z]{3}$/.test(currencyRaw)) { errors.push({ line, message: `defaultCurrency must be a 3-letter code: ${currencyRaw}` }); return; }
        patch.defaultCurrency = currencyRaw;
      }
      const termsRaw = cell(row, cols, 'paymenttermsdays');
      if (termsRaw) {
        const terms = Number(termsRaw);
        if (!Number.isInteger(terms) || terms < 0) { errors.push({ line, message: 'paymentTermsDays must be a whole number' }); return; }
        patch.paymentTermsDays = terms;
      }
      if (id) updates.push({ id, patch });
      else creates.push({ status: 'lead', defaultCurrency: 'USD', ...patch, name: patch.name as string });
    });

    if (body.dryRun) return c.json(summary(data.length, creates.length, updates.length, errors));

    await db.transaction(async (tx) => {
      for (const v of creates) {
        const id = ulid();
        // What createCompany does for one: the importer owns it, it has a portal token.
        await tx.insert(schema.companies).values({ id, ...v, ownerId: actor.userId, portalToken: ulid(), createdBy: actor.userId } as typeof schema.companies.$inferInsert);
        await writeActivity(tx, { entityType: 'company', entityId: id, action: 'created', after: { ...v, source: 'csv' }, actorId: actor.userId, actorType: actor.actorType });
      }
      for (const u of updates) {
        if (!Object.keys(u.patch).length) continue;
        await tx.update(schema.companies).set(u.patch).where(eq(schema.companies.id, u.id));
        await writeActivity(tx, { entityType: 'company', entityId: u.id, action: 'updated', after: { ...u.patch, source: 'csv' }, actorId: actor.userId, actorType: actor.actorType });
      }
    });
    return c.json(summary(data.length, creates.length, updates.length, errors, false));
  });

  app.post('/import/contacts', guard('crm.write'), async (c) => {
    const actor = currentActor(c);
    const body = importBodySchema.parse(await c.req.json());
    const { cols, data } = readRows(body.csv);
    const errors: ImportError[] = [];
    const creates: Array<Record<string, unknown>> = [];
    const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];

    const { db } = getDb();
    const companies = await db.select({ id: schema.companies.id, name: schema.companies.name })
      .from(schema.companies).where(isNull(schema.companies.deletedAt));
    const companyByName = new Map(companies.map((co) => [co.name, co.id]));
    const contacts = await db.select({ id: schema.contacts.id }).from(schema.contacts).where(isNull(schema.contacts.deletedAt));
    const known = new Set(contacts.map((r) => r.id));

    if (!cols.has('id') && (!cols.has('companyname') || !cols.has('firstname'))) {
      errors.push({ line: 1, message: 'Missing required headers: companyName, firstName' });
    } else data.forEach((row, i) => {
      const line = i + 2;
      const id = cell(row, cols, 'id');
      if (id && !known.has(id)) { errors.push({ line, message: `Unknown contact id: ${id}` }); return; }
      const patch: Record<string, unknown> = textPatch(row, cols, { email: 'email', phone: 'phone', position: 'position' });
      if (cols.has('lastname')) patch.lastName = cell(row, cols, 'lastname');
      if (cols.has('firstname')) {
        const firstName = cell(row, cols, 'firstname');
        if (!firstName) { errors.push({ line, message: 'firstName is required' }); return; }
        patch.firstName = firstName;
      }
      if (id) { updates.push({ id, patch }); return; } // an update does not move a contact between companies
      const companyName = cell(row, cols, 'companyname');
      const companyId = companyByName.get(companyName);
      if (!companyId) { errors.push({ line, message: `Unknown company: ${companyName || '(empty)'}` }); return; }
      creates.push({ lastName: '', ...patch, companyId });
    });

    if (body.dryRun) return c.json(summary(data.length, creates.length, updates.length, errors));

    await db.transaction(async (tx) => {
      for (const v of creates) {
        const id = ulid();
        await tx.insert(schema.contacts).values({ id, ...v, createdBy: actor.userId } as typeof schema.contacts.$inferInsert);
        await writeActivity(tx, { entityType: 'contact', entityId: id, action: 'created', after: { ...v, source: 'csv' }, actorId: actor.userId, actorType: actor.actorType });
      }
      for (const u of updates) {
        if (!Object.keys(u.patch).length) continue;
        await tx.update(schema.contacts).set(u.patch).where(eq(schema.contacts.id, u.id));
        await writeActivity(tx, { entityType: 'contact', entityId: u.id, action: 'updated', after: { ...u.patch, source: 'csv' }, actorId: actor.userId, actorType: actor.actorType });
      }
    });
    return c.json(summary(data.length, creates.length, updates.length, errors, false));
  });

  /**
   * Leads arrive as lists – a research batch, an export from another tool – and
   * their companies usually are not in the workspace yet. Requiring every
   * company to pre-exist would force a second import first, so unknown company
   * names are created on the fly (as prospects), the same shortcut the New Lead
   * dialog takes one record at a time.
   *
   * A row with the `id` of an existing lead updates it (the leads export puts
   * that column first), so editing an export and importing it back does not
   * duplicate every lead.
   */
  app.post('/import/leads', guard('crm.write'), async (c) => {
    const actor = currentActor(c);
    const body = importBodySchema.parse(await c.req.json());
    const { cols, data } = readRows(body.csv);
    const errors: ImportError[] = [];
    const creates: Array<Record<string, unknown> & { companyName: string }> = [];
    const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];

    const { db } = getDb();
    const companies = await db.select({ id: schema.companies.id, name: schema.companies.name })
      .from(schema.companies).where(isNull(schema.companies.deletedAt));
    const companyByName = new Map(companies.map((co) => [co.name, co.id]));
    const leadRows = await db.select({ id: schema.leads.id, status: schema.leads.status })
      .from(schema.leads).where(isNull(schema.leads.deletedAt));
    const statusOf = new Map(leadRows.map((l) => [l.id, l.status]));

    // No nurture (needs a per-lead return date) and no terminal states – an
    // import brings work in, it does not record how work ended.
    const importableStatuses = new Set(['new', 'needs_review', 'ready', 'waiting_reply', 'engaged']);
    const LEAD_TEXT_FIELDS: Record<string, string> = {
      product: 'product', signal: 'signal', painsignal: 'painSignal', evidence: 'evidence',
      whyfit: 'whyFit', whynow: 'whyNow', sourcetitle: 'sourceTitle', sourcetype: 'sourceType',
      suggestedchannel: 'suggestedChannel', opener: 'opener', caution: 'caution',
    };

    if (!cols.has('id') && (!cols.has('companyname') || !cols.has('title'))) {
      errors.push({ line: 1, message: 'Missing required headers: companyName, title' });
    } else data.forEach((row, i) => {
      const line = i + 2;
      const id = cell(row, cols, 'id');
      const current = id ? statusOf.get(id) : undefined;
      if (id && current === undefined) { errors.push({ line, message: `Unknown lead id: ${id}` }); return; }

      const patch: Record<string, unknown> = textPatch(row, cols, LEAD_TEXT_FIELDS);
      if (cols.has('title')) {
        const title = cell(row, cols, 'title');
        if (!title) { errors.push({ line, message: 'title is required' }); return; }
        patch.title = title;
      }
      if (cols.has('score')) {
        // A score is a hint, not the lead: an unreadable one is left out
        // (empty on a new lead, unchanged on an update) rather than failing the row.
        const scoreRaw = cell(row, cols, 'score');
        const scoreNum = scoreRaw ? Number(scoreRaw) : NaN;
        if (Number.isInteger(scoreNum) && scoreNum >= 0 && scoreNum <= 100) patch.score = scoreNum;
        else if (!scoreRaw || !id) patch.score = null;
      }
      if (cols.has('sourceurl')) {
        const sourceUrlRaw = cell(row, cols, 'sourceurl');
        if (sourceUrlRaw) {
          // Dropping a bad URL silently would lose the one field that cannot be
          // reconstructed later, so the row fails loudly instead.
          let protocol = '';
          try { protocol = new URL(sourceUrlRaw).protocol; } catch { /* handled below */ }
          if (protocol !== 'http:' && protocol !== 'https:') {
            errors.push({ line, message: 'sourceUrl must be an http(s) URL' });
            return;
          }
        }
        patch.sourceUrl = sourceUrlRaw || null;
      }
      if (cols.has('signaldate')) {
        const signalDate = cell(row, cols, 'signaldate');
        if (signalDate && !ISO_DATE.test(signalDate)) { errors.push({ line, message: 'signalDate must be YYYY-MM-DD' }); return; }
        patch.signalDate = signalDate || null;
      }
      const statusRaw = cell(row, cols, 'status');

      if (id) {
        // A lead that has ended (converted, disqualified, lost) or waits in
        // nurture keeps its status: the export carries it, so feeding the file
        // back must not reopen it. Only a change between working statuses lands.
        if (statusRaw && statusRaw !== current) {
          if (!importableStatuses.has(current!)) {
            errors.push({ line, message: `Lead is ${current}; its status cannot be changed by import` }); return;
          }
          if (!importableStatuses.has(statusRaw)) {
            errors.push({ line, message: `Status ${statusRaw} cannot be set by import` }); return;
          }
          patch.status = statusRaw;
        }
        updates.push({ id, patch }); // an update does not move a lead between companies
        return;
      }

      const companyName = cell(row, cols, 'companyname');
      if (!companyName) { errors.push({ line, message: 'companyName is required' }); return; }
      if (statusRaw && !importableStatuses.has(statusRaw)) {
        errors.push({ line, message: `Status ${statusRaw} cannot be set by import – use one of ${[...importableStatuses].join(', ')}` }); return;
      }
      creates.push({ ...patch, status: statusRaw || 'new', companyName });
    });

    const newCompanies = [...new Set(creates.map((v) => v.companyName))]
      .filter((name) => !companyByName.has(name));

    if (body.dryRun) {
      return c.json({ ...summary(data.length, creates.length, updates.length, errors), newCompanies: newCompanies.length });
    }

    await db.transaction(async (tx) => {
      for (const name of newCompanies) {
        const id = ulid();
        await tx.insert(schema.companies).values({
          id, name, status: 'lead', ownerId: actor.userId, portalToken: ulid(), createdBy: actor.userId,
        });
        companyByName.set(name, id);
      }
      for (const { companyName, ...v } of creates) {
        const id = ulid();
        await tx.insert(schema.leads).values({
          id,
          ...v,
          companyId: companyByName.get(companyName)!,
          // The importer works these leads until someone reassigns them.
          ownerId: actor.userId,
          createdBy: actor.userId,
        } as typeof schema.leads.$inferInsert);
        await writeActivity(tx, { entityType: 'lead', entityId: id, action: 'created', after: { title: v.title, status: v.status, source: 'csv' }, actorId: actor.userId, actorType: actor.actorType });
      }
      for (const u of updates) {
        if (!Object.keys(u.patch).length) continue;
        await tx.update(schema.leads).set(u.patch).where(eq(schema.leads.id, u.id));
        await writeActivity(tx, { entityType: 'lead', entityId: u.id, action: 'updated', after: { ...u.patch, source: 'csv' }, actorId: actor.userId, actorType: actor.actorType });
      }
    });
    return c.json({ ...summary(data.length, creates.length, updates.length, errors, false), newCompanies: newCompanies.length });
  });

  /**
   * Tasks by project key (new rows) or by ref, e.g. WEB-12 (existing rows: an
   * update of the columns the file carries). Status is matched by name within
   * the project. Needs member rights on every project a row touches.
   */
  app.post('/import/tasks', guard('projects.create'), async (c) => {
    const actor = currentActor(c);
    const body = importBodySchema.parse(await c.req.json());
    const { cols, data } = readRows(body.csv);
    const errors: ImportError[] = [];
    const creates: Array<Record<string, unknown> & { projectId: string; statusId: string; key: string }> = [];
    const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];

    const { db } = getDb();
    const accessible = new Set(await accessibleProjectIds(actor));
    const projects = await db.select({ id: schema.projects.id, key: schema.projects.key, visibility: schema.projects.visibility })
      .from(schema.projects).where(isNull(schema.projects.deletedAt));
    const projectByKey = new Map(projects.map((p) => [p.key.toUpperCase(), p]));

    // Default status per project: isDefault first, then lowest position.
    const statuses = await db.select().from(schema.taskStatuses)
      .orderBy(desc(schema.taskStatuses.isDefault), asc(schema.taskStatuses.position));
    const defaultStatus = new Map<string, string>();
    const statusByName = new Map<string, string>(); // `${projectId}:${lowercased name}` → id
    for (const s of statuses) {
      if (!defaultStatus.has(s.projectId)) defaultStatus.set(s.projectId, s.id);
      statusByName.set(`${s.projectId}:${s.name.trim().toLowerCase()}`, s.id);
    }

    /** The project behind a key, if this person may add or change its tasks. */
    const writableProject = (key: string, line: number) => {
      const project = projectByKey.get(key.toUpperCase());
      if (!project || !accessible.has(project.id)) { errors.push({ line, message: `Unknown or inaccessible project: ${key || '(empty)'}` }); return null; }
      // Seeing a project is not writing to it: createTask demands member rights,
      // and a viewer used to slip tasks in through this import.
      const role = effectiveProjectRole(actor, { id: project.id, visibility: project.visibility as 'workspace' | 'private' });
      if (role !== 'admin' && role !== 'member') { errors.push({ line, message: `No rights to add tasks to project ${project.key}` }); return null; }
      return project;
    };

    // Refs in the file, resolved in one query per project.
    const refRows = new Map<string, string>(); // `${projectId}:${number}` → task id
    if (cols.has('ref')) {
      const wanted = new Map<string, number[]>();
      for (const row of data) {
        const m = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(cell(row, cols, 'ref'));
        const project = m ? projectByKey.get(m[1]!.toUpperCase()) : undefined;
        if (project) wanted.set(project.id, [...(wanted.get(project.id) ?? []), Number(m![2])]);
      }
      for (const [projectId, numbers] of wanted) {
        const found = await db.select({ id: schema.tasks.id, number: schema.tasks.number }).from(schema.tasks)
          .where(and(eq(schema.tasks.projectId, projectId), inArray(schema.tasks.number, numbers), isNull(schema.tasks.deletedAt)));
        for (const t of found) refRows.set(`${projectId}:${t.number}`, t.id);
      }
    }

    if (!cols.has('title') || (!cols.has('projectkey') && !cols.has('ref'))) {
      errors.push({ line: 1, message: 'Missing required headers: projectKey (or ref), title' });
    } else data.forEach((row, i) => {
      const line = i + 2;
      const ref = cell(row, cols, 'ref');
      let project: ReturnType<typeof writableProject> = null;
      let taskId: string | undefined;
      if (ref) {
        const m = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(ref);
        if (!m) { errors.push({ line, message: `Not a task reference: ${ref}` }); return; }
        project = writableProject(m[1]!, line);
        if (!project) return;
        taskId = refRows.get(`${project.id}:${Number(m[2])}`);
        if (!taskId) { errors.push({ line, message: `Unknown task: ${ref}` }); return; }
      } else {
        project = writableProject(cell(row, cols, 'projectkey'), line);
        if (!project) return;
      }

      const patch: Record<string, unknown> = {};
      const title = cell(row, cols, 'title');
      if (!title) { errors.push({ line, message: 'title is required' }); return; }
      patch.title = title;
      const priorityRaw = cell(row, cols, 'priority');
      if (priorityRaw) {
        if (!(TASK_PRIORITIES as readonly string[]).includes(priorityRaw)) { errors.push({ line, message: `Unknown priority: ${priorityRaw}` }); return; }
        patch.priority = priorityRaw;
      }
      const statusRaw = cell(row, cols, 'status');
      if (statusRaw) {
        const statusId = statusByName.get(`${project.id}:${statusRaw.toLowerCase()}`);
        if (!statusId) { errors.push({ line, message: `Project ${project.key} has no status "${statusRaw}"` }); return; }
        patch.statusId = statusId;
      }
      for (const [header, field] of [['startdate', 'startDate'], ['duedate', 'dueDate']] as const) {
        if (!cols.has(header)) continue;
        const v = cell(row, cols, header);
        if (v && !ISO_DATE.test(v)) { errors.push({ line, message: `${field} must be YYYY-MM-DD` }); return; }
        patch[field] = v || null;
      }
      if (cols.has('estimate')) {
        const v = cell(row, cols, 'estimate').replace(',', '.');
        if (v && !(Number.isFinite(Number(v)) && Number(v) >= 0)) { errors.push({ line, message: 'estimate must be a number' }); return; }
        patch.estimate = v ? String(Number(v)) : null;
      }

      if (taskId) { updates.push({ id: taskId, patch }); return; }
      const statusId = (patch.statusId as string | undefined) ?? defaultStatus.get(project.id);
      if (!statusId) { errors.push({ line, message: `Project ${project.key} has no task statuses` }); return; }
      creates.push({ priority: 'none', ...patch, projectId: project.id, statusId, key: project.key });
    });

    if (body.dryRun) return c.json(summary(data.length, creates.length, updates.length, errors));

    const created: Array<{ id: string; ref: string; projectId: string }> = [];
    await db.transaction(async (tx) => {
      // Append after the project's last task, in file order, the way createTask
      // places a single one; left at the column default every imported task
      // shared one position and the board order between them was arbitrary.
      const lastPos = new Map<string, number | null>();
      for (const { key, ...v } of creates) {
        if (!lastPos.has(v.projectId)) {
          const [row] = await tx.select({ maxPos: sql<string | null>`max(${schema.tasks.position})` })
            .from(schema.tasks).where(eq(schema.tasks.projectId, v.projectId));
          lastPos.set(v.projectId, row?.maxPos != null ? Number(row.maxPos) : null);
        }
        const position = appendPosition(lastPos.get(v.projectId) ?? null);
        lastPos.set(v.projectId, position);
        const id = ulid();
        // number: 0 – the per-project number is assigned by a DB trigger.
        const [row] = await tx.insert(schema.tasks)
          .values({ id, ...v, number: 0, position: String(position), createdBy: actor.userId } as typeof schema.tasks.$inferInsert)
          .returning({ number: schema.tasks.number });
        const ref = `${key}-${row?.number}`;
        created.push({ id, ref, projectId: v.projectId });
        await writeActivity(tx, { entityType: 'task', entityId: id, action: 'created', after: { ...v, source: 'csv' }, actorId: actor.userId, actorType: actor.actorType });
      }
      for (const u of updates) {
        await tx.update(schema.tasks).set(u.patch).where(eq(schema.tasks.id, u.id));
        await writeActivity(tx, { entityType: 'task', entityId: u.id, action: 'updated', after: { ...u.patch, source: 'csv' }, actorId: actor.userId, actorType: actor.actorType });
      }
    });
    // After the commit, so webhooks never point at a task that is not there yet.
    // `source: 'import'` keeps Slack from posting one message per row.
    for (const t of created) {
      await emit({ type: 'task.created', aggregateType: 'task', aggregateId: t.id, payload: { ref: t.ref, taskId: t.id, projectId: t.projectId, source: 'import' }, actorId: actor.userId, actorType: actor.actorType });
    }
    return c.json(summary(data.length, creates.length, updates.length, errors, false));
  });

  return app;
}
