/**
 * CSV import/export (PRD §14.6). Tiny dependency-free CSV parse/serialize
 * (quoted fields, embedded commas/newlines/quotes). Exports stream the full
 * (non-deleted) result as text/csv attachments; imports accept {csv, dryRun}
 * and validate per line before writing anything (all-or-nothing transaction
 * for the valid rows).
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { ulid } from 'ulid';
import { getDb, schema, eq, and, isNull, inArray, asc, desc } from '@ordi/db';
import { COMPANY_STATUSES, TASK_PRIORITIES } from '@ordi/shared';
import type { AppEnv } from '../../context';
import { requireAuth, currentActor } from '../../core/auth';
import { guard } from '../../core/rbac';
import { accessibleProjectIds } from '../../core/access';
import { writeActivity } from '../../core/activity';

// ── CSV primitives ──

export function parseCsv(text: string): string[][] {
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
    if (ch === ',') { row.push(field); field = ''; i += 1; continue; }
    if (ch === '\r') { i += 1; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i += 1; continue; }
    field += ch; i += 1;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = v instanceof Date ? v.toISOString() : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}

function csvResponse(c: Context<AppEnv>, filename: string, csv: string): Response {
  c.header('Content-Type', 'text/csv; charset=utf-8');
  c.header('Content-Disposition', `attachment; filename="${filename}"`);
  return c.body(csv);
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

interface ImportError { line: number; message: string }

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

  app.get('/export/leads.csv', guard('crm.export'), async (c) => {
    const { db } = getDb();
    const rows = await db.select({
      id: schema.leads.id, companyName: schema.companies.name, title: schema.leads.title,
      product: schema.leads.product, status: schema.leads.status, score: schema.leads.score,
      signal: schema.leads.signal, sourceUrl: schema.leads.sourceUrl,
      suggestedChannel: schema.leads.suggestedChannel, owner: schema.users.name,
      createdAt: schema.leads.createdAt,
    }).from(schema.leads)
      .innerJoin(schema.companies, eq(schema.leads.companyId, schema.companies.id))
      .leftJoin(schema.users, eq(schema.leads.ownerId, schema.users.id))
      .where(isNull(schema.leads.deletedAt))
      .orderBy(desc(schema.leads.createdAt));
    const csv = toCsv(
      ['id', 'companyName', 'title', 'product', 'status', 'score', 'signal', 'sourceUrl', 'suggestedChannel', 'owner', 'createdAt'],
      rows.map((r) => [r.id, r.companyName, r.title, r.product, r.status, r.score, r.signal, r.sourceUrl, r.suggestedChannel, r.owner, r.createdAt]),
    );
    return csvResponse(c, 'leads.csv', csv);
  });

  app.get('/export/tasks.csv', guard('projects.export'), async (c) => {
    const actor = currentActor(c);
    const { db } = getDb();
    const projectIds = await accessibleProjectIds(actor);
    const header = ['ref', 'title', 'status', 'priority', 'dueDate', 'estimate'];
    if (!projectIds.length) return csvResponse(c, 'tasks.csv', toCsv(header, []));
    const rows = await db.select({
      key: schema.projects.key, number: schema.tasks.number, title: schema.tasks.title,
      status: schema.taskStatuses.name, priority: schema.tasks.priority,
      dueDate: schema.tasks.dueDate, estimate: schema.tasks.estimate,
    }).from(schema.tasks)
      .innerJoin(schema.projects, eq(schema.tasks.projectId, schema.projects.id))
      .innerJoin(schema.taskStatuses, eq(schema.tasks.statusId, schema.taskStatuses.id))
      .where(and(isNull(schema.tasks.deletedAt), inArray(schema.tasks.projectId, projectIds)))
      .orderBy(asc(schema.projects.key), asc(schema.tasks.number));
    const csv = toCsv(header, rows.map((r) => [
      `${r.key}-${r.number}`, r.title, r.status, r.priority, r.dueDate, r.estimate,
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

  app.get('/export/time.csv', guard('time.read_all'), async (c) => {
    const { db } = getDb();
    const rows = await db.select({
      user: schema.users.name, project: schema.projects.name,
      key: schema.projects.key, taskNumber: schema.tasks.number,
      startedAt: schema.timeEntries.startedAt, durationSeconds: schema.timeEntries.durationSeconds,
      billable: schema.timeEntries.billable, rate: schema.timeEntries.hourlyRate,
    }).from(schema.timeEntries)
      .innerJoin(schema.users, eq(schema.timeEntries.userId, schema.users.id))
      .innerJoin(schema.projects, eq(schema.timeEntries.projectId, schema.projects.id))
      .innerJoin(schema.tasks, eq(schema.timeEntries.taskId, schema.tasks.id))
      .orderBy(desc(schema.timeEntries.startedAt));
    const csv = toCsv(
      ['user', 'project', 'task', 'startedAt', 'hours', 'billable', 'rate'],
      rows.map((r) => [
        r.user, r.project, `${r.key}-${r.taskNumber}`, r.startedAt,
        Math.round((r.durationSeconds / 3600) * 100) / 100, r.billable, Number(r.rate),
      ]),
    );
    return csvResponse(c, 'time.csv', csv);
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
    return idx === undefined ? '' : (row[idx] ?? '').trim();
  }

  app.post('/import/companies', guard('crm.write'), async (c) => {
    const actor = currentActor(c);
    const body = importBodySchema.parse(await c.req.json());
    const { cols, data } = readRows(body.csv);
    const errors: ImportError[] = [];
    const valid: Array<{ name: string; domain: string | null; status: string; billingEmail: string | null; defaultCurrency: string }> = [];

    if (!cols.has('name')) errors.push({ line: 1, message: 'Missing required header: name' });
    else data.forEach((row, i) => {
      const line = i + 2; // 1-based, after header
      const name = cell(row, cols, 'name');
      if (!name) { errors.push({ line, message: 'name is required' }); return; }
      const statusRaw = cell(row, cols, 'status');
      const status = (COMPANY_STATUSES as readonly string[]).includes(statusRaw) ? statusRaw : 'lead';
      const currencyRaw = cell(row, cols, 'defaultcurrency').toUpperCase();
      valid.push({
        name,
        domain: cell(row, cols, 'domain') || null,
        status,
        billingEmail: cell(row, cols, 'billingemail') || null,
        defaultCurrency: /^[A-Z]{3}$/.test(currencyRaw) ? currencyRaw : 'USD',
      });
    });

    if (body.dryRun) return c.json({ rows: data.length, valid: valid.length, errors });

    const { db } = getDb();
    await db.transaction(async (tx) => {
      for (const v of valid) {
        await tx.insert(schema.companies).values({ id: ulid(), ...v, createdBy: actor.userId });
      }
    });
    await writeActivity(getDb().db, {
      entityType: 'company', entityId: 'csv-import', action: 'imported_csv',
      actorId: actor.userId, actorType: actor.actorType,
      diff: { imported: valid.length, errors: errors.length },
    });
    return c.json({ imported: valid.length, errors });
  });

  app.post('/import/contacts', guard('crm.write'), async (c) => {
    const actor = currentActor(c);
    const body = importBodySchema.parse(await c.req.json());
    const { cols, data } = readRows(body.csv);
    const errors: ImportError[] = [];
    const valid: Array<{ companyId: string; firstName: string; lastName: string; email: string | null; phone: string | null; position: string | null }> = [];

    const { db } = getDb();
    const companies = await db.select({ id: schema.companies.id, name: schema.companies.name })
      .from(schema.companies).where(isNull(schema.companies.deletedAt));
    const companyByName = new Map(companies.map((co) => [co.name, co.id]));

    if (!cols.has('companyname') || !cols.has('firstname')) {
      errors.push({ line: 1, message: 'Missing required headers: companyName, firstName' });
    } else data.forEach((row, i) => {
      const line = i + 2;
      const companyName = cell(row, cols, 'companyname');
      const firstName = cell(row, cols, 'firstname');
      if (!firstName) { errors.push({ line, message: 'firstName is required' }); return; }
      const companyId = companyByName.get(companyName);
      if (!companyId) { errors.push({ line, message: `Unknown company: ${companyName || '(empty)'}` }); return; }
      valid.push({
        companyId, firstName,
        lastName: cell(row, cols, 'lastname'),
        email: cell(row, cols, 'email') || null,
        phone: cell(row, cols, 'phone') || null,
        position: cell(row, cols, 'position') || null,
      });
    });

    if (body.dryRun) return c.json({ rows: data.length, valid: valid.length, errors });

    await db.transaction(async (tx) => {
      for (const v of valid) {
        await tx.insert(schema.contacts).values({ id: ulid(), ...v, createdBy: actor.userId });
      }
    });
    await writeActivity(db, {
      entityType: 'contact', entityId: 'csv-import', action: 'imported_csv',
      actorId: actor.userId, actorType: actor.actorType,
      diff: { imported: valid.length, errors: errors.length },
    });
    return c.json({ imported: valid.length, errors });
  });

  /**
   * Leads arrive as lists – a research batch, an export from another tool – and
   * their companies usually are not in the workspace yet. Requiring every
   * company to pre-exist would force a second import first, so unknown company
   * names are created on the fly (as prospects), the same shortcut the New Lead
   * dialog takes one record at a time.
   */
  app.post('/import/leads', guard('crm.write'), async (c) => {
    const actor = currentActor(c);
    const body = importBodySchema.parse(await c.req.json());
    const { cols, data } = readRows(body.csv);
    const errors: ImportError[] = [];
    interface LeadRow {
      companyName: string; title: string; product: string | null; status: string;
      score: number | null; signal: string | null; sourceUrl: string | null;
      suggestedChannel: string | null; opener: string | null;
    }
    const valid: LeadRow[] = [];

    const { db } = getDb();
    const companies = await db.select({ id: schema.companies.id, name: schema.companies.name })
      .from(schema.companies).where(isNull(schema.companies.deletedAt));
    const companyByName = new Map(companies.map((co) => [co.name, co.id]));

    // No nurture (needs a per-lead return date) and no terminal states – an
    // import brings work in, it does not record how work ended.
    const importableStatuses = new Set(['new', 'needs_review', 'ready', 'waiting_reply', 'engaged']);

    if (!cols.has('companyname') || !cols.has('title')) {
      errors.push({ line: 1, message: 'Missing required headers: companyName, title' });
    } else data.forEach((row, i) => {
      const line = i + 2;
      const companyName = cell(row, cols, 'companyname');
      const title = cell(row, cols, 'title');
      if (!companyName) { errors.push({ line, message: 'companyName is required' }); return; }
      if (!title) { errors.push({ line, message: 'title is required' }); return; }
      const statusRaw = cell(row, cols, 'status');
      const scoreRaw = cell(row, cols, 'score');
      const scoreNum = scoreRaw ? Number(scoreRaw) : NaN;
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
      valid.push({
        companyName,
        title,
        product: cell(row, cols, 'product') || null,
        status: importableStatuses.has(statusRaw) ? statusRaw : 'new',
        score: Number.isInteger(scoreNum) && scoreNum >= 0 && scoreNum <= 100 ? scoreNum : null,
        signal: cell(row, cols, 'signal') || null,
        sourceUrl: sourceUrlRaw || null,
        suggestedChannel: cell(row, cols, 'suggestedchannel') || null,
        opener: cell(row, cols, 'opener') || null,
      });
    });

    const newCompanies = [...new Set(valid.map((v) => v.companyName))]
      .filter((name) => !companyByName.has(name));

    if (body.dryRun) {
      return c.json({ rows: data.length, valid: valid.length, newCompanies: newCompanies.length, errors });
    }

    await db.transaction(async (tx) => {
      for (const name of newCompanies) {
        const id = ulid();
        await tx.insert(schema.companies).values({ id, name, status: 'lead', createdBy: actor.userId });
        companyByName.set(name, id);
      }
      for (const v of valid) {
        await tx.insert(schema.leads).values({
          id: ulid(),
          companyId: companyByName.get(v.companyName)!,
          title: v.title,
          product: v.product,
          status: v.status,
          score: v.score,
          signal: v.signal,
          sourceUrl: v.sourceUrl,
          suggestedChannel: v.suggestedChannel,
          opener: v.opener,
          // The importer works these leads until someone reassigns them.
          ownerId: actor.userId,
          createdBy: actor.userId,
        });
      }
    });
    await writeActivity(db, {
      entityType: 'lead', entityId: 'csv-import', action: 'imported_csv',
      actorId: actor.userId, actorType: actor.actorType,
      diff: { imported: valid.length, newCompanies: newCompanies.length, errors: errors.length },
    });
    return c.json({ imported: valid.length, newCompanies: newCompanies.length, errors });
  });

  app.post('/import/tasks', guard('projects.create'), async (c) => {
    const actor = currentActor(c);
    const body = importBodySchema.parse(await c.req.json());
    const { cols, data } = readRows(body.csv);
    const errors: ImportError[] = [];
    const valid: Array<{ projectId: string; title: string; priority: string; statusId: string }> = [];

    const { db } = getDb();
    const accessible = new Set(await accessibleProjectIds(actor));
    const projects = await db.select({ id: schema.projects.id, key: schema.projects.key })
      .from(schema.projects).where(isNull(schema.projects.deletedAt));
    const projectByKey = new Map(projects.map((p) => [p.key, p]));

    // Default status per project: isDefault first, then lowest position.
    const statuses = await db.select().from(schema.taskStatuses)
      .orderBy(desc(schema.taskStatuses.isDefault), asc(schema.taskStatuses.position));
    const defaultStatus = new Map<string, string>();
    for (const s of statuses) if (!defaultStatus.has(s.projectId)) defaultStatus.set(s.projectId, s.id);

    if (!cols.has('projectkey') || !cols.has('title')) {
      errors.push({ line: 1, message: 'Missing required headers: projectKey, title' });
    } else data.forEach((row, i) => {
      const line = i + 2;
      const key = cell(row, cols, 'projectkey');
      const title = cell(row, cols, 'title');
      if (!title) { errors.push({ line, message: 'title is required' }); return; }
      const project = projectByKey.get(key);
      if (!project || !accessible.has(project.id)) { errors.push({ line, message: `Unknown or inaccessible project: ${key || '(empty)'}` }); return; }
      const statusId = defaultStatus.get(project.id);
      if (!statusId) { errors.push({ line, message: `Project ${key} has no task statuses` }); return; }
      const priorityRaw = cell(row, cols, 'priority');
      const priority = (TASK_PRIORITIES as readonly string[]).includes(priorityRaw) ? priorityRaw : 'none';
      valid.push({ projectId: project.id, title, priority, statusId });
    });

    if (body.dryRun) return c.json({ rows: data.length, valid: valid.length, errors });

    await db.transaction(async (tx) => {
      for (const v of valid) {
        // number: 0 – the per-project number is assigned by a DB trigger.
        await tx.insert(schema.tasks).values({ id: ulid(), ...v, number: 0, createdBy: actor.userId });
      }
    });
    await writeActivity(db, {
      entityType: 'task', entityId: 'csv-import', action: 'imported_csv',
      actorId: actor.userId, actorType: actor.actorType,
      diff: { imported: valid.length, errors: errors.length },
    });
    return c.json({ imported: valid.length, errors });
  });

  return app;
}
