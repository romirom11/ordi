/**
 * The leads spreadsheet export: one row per lead, one column per field.
 *
 * The lead table shows six columns and the record page shows the rest one lead
 * at a time, so "give me the leads in a spreadsheet" had no answer – the CSV
 * export carried eleven of the thirty-odd fields a lead actually stores. This
 * builds the full row instead: every column of the record, the related names
 * the table only hints at (company, contact, owner, labels, next action,
 * converted deal) and whatever custom fields the workspace defined for leads.
 *
 * Unlike the table it is not capped: an export that stopped at the list's 200
 * rows would look complete and not be.
 */
import { getDb, schema, eq, and, isNull, inArray, asc, desc } from '@ordi/db';
import { leadFilter, type LeadFilters } from './leads';
import { nextSalesActivities } from './activities';

/** A spreadsheet: the header row and the data rows, in column order. */
export interface ExportTable {
  header: string[];
  rows: unknown[][];
}

interface CustomFieldOption { value: string; label: string }

/**
 * Column names double as import headers where the importer understands them
 * (companyName, title, product, status, score, signal, sourceUrl,
 * suggestedChannel, opener), so an exported file can be edited and fed back.
 */
const LEAD_COLUMNS = [
  'id', 'companyName', 'companyDomain', 'title', 'product', 'status', 'score',
  'owner', 'ownerEmail', 'labels',
  'contactName', 'contactEmail', 'contactPhone', 'contactPosition',
  'signal', 'painSignal', 'evidence', 'whyFit', 'whyNow',
  'sourceTitle', 'sourceUrl', 'sourceType', 'signalDate', 'sourceCheckedAt',
  'suggestedChannel', 'opener', 'caution', 'nurtureUntil', 'disqualifiedReason',
  'nextActionType', 'nextActionSubject', 'nextActionDueAt',
  'convertedDealId', 'convertedDealTitle',
  'createdBy', 'createdAt', 'updatedAt',
] as const;

/** One custom-field value in one cell: stored values are labelled, lists joined. */
function customFieldCell(value: unknown, options: CustomFieldOption[]): unknown {
  if (value === null || value === undefined) return '';
  const labelOf = (v: unknown) => options.find((option) => option.value === v)?.label ?? String(v);
  if (Array.isArray(value)) return value.map(labelOf).join(', ');
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return labelOf(value);
}

function optionsOf(raw: unknown): CustomFieldOption[] {
  return Array.isArray(raw) ? (raw as CustomFieldOption[]) : [];
}

export async function exportLeads(params: LeadFilters): Promise<ExportTable> {
  const { db } = getDb();
  const rows = await db.select({
    lead: schema.leads,
    companyName: schema.companies.name,
    companyDomain: schema.companies.domain,
    contactFirstName: schema.contacts.firstName,
    contactLastName: schema.contacts.lastName,
    contactEmail: schema.contacts.email,
    contactPhone: schema.contacts.phone,
    contactPosition: schema.contacts.position,
  }).from(schema.leads)
    .innerJoin(schema.companies, eq(schema.leads.companyId, schema.companies.id))
    .leftJoin(schema.contacts, eq(schema.leads.contactId, schema.contacts.id))
    .where(leadFilter(params))
    .orderBy(desc(schema.leads.createdAt));

  const leadIds = rows.map((row) => row.lead.id);
  // Owner and author are the same table twice; one lookup by id beats aliasing
  // the join, and the set is small next to the lead rows themselves.
  const userIds = [...new Set(rows.flatMap((row) => [row.lead.ownerId, row.lead.createdBy]).filter(Boolean) as string[])];

  const [userRows, labelRows, dealRows, activities, fieldDefs] = await Promise.all([
    userIds.length
      ? db.select({ id: schema.users.id, name: schema.users.name, email: schema.users.email })
        .from(schema.users).where(inArray(schema.users.id, userIds))
      : [],
    leadIds.length
      ? db.select({ leadId: schema.leadLabels.leadId, name: schema.labels.name })
        .from(schema.leadLabels)
        .innerJoin(schema.labels, eq(schema.leadLabels.labelId, schema.labels.id))
        .where(inArray(schema.leadLabels.leadId, leadIds))
        .orderBy(asc(schema.labels.name))
      : [],
    leadIds.length
      ? db.select({ id: schema.deals.id, title: schema.deals.title, sourceLeadId: schema.deals.sourceLeadId })
        .from(schema.deals).where(and(
          inArray(schema.deals.sourceLeadId, leadIds),
          isNull(schema.deals.deletedAt),
        ))
      : [],
    nextSalesActivities({ leadIds }),
    db.select({
      key: schema.customFieldDefinitions.key,
      label: schema.customFieldDefinitions.label,
      options: schema.customFieldDefinitions.options,
    }).from(schema.customFieldDefinitions).where(and(
      eq(schema.customFieldDefinitions.entityType, 'leads'),
      eq(schema.customFieldDefinitions.deprecated, false),
    )).orderBy(asc(schema.customFieldDefinitions.position), asc(schema.customFieldDefinitions.key)),
  ]);

  const usersById = new Map(userRows.map((user) => [user.id, user]));
  const labelsByLead = new Map<string, string[]>();
  for (const row of labelRows) {
    const names = labelsByLead.get(row.leadId);
    if (names) names.push(row.name);
    else labelsByLead.set(row.leadId, [row.name]);
  }
  const dealByLead = new Map(dealRows.map((deal) => [deal.sourceLeadId!, deal]));
  const nextByLead = new Map(activities.map((activity) => [activity.leadId!, activity]));

  const header = [...LEAD_COLUMNS, ...fieldDefs.map((field) => field.label)];
  const data = rows.map((row) => {
    const { lead } = row;
    const owner = lead.ownerId ? usersById.get(lead.ownerId) : undefined;
    const contactName = [row.contactFirstName, row.contactLastName].filter(Boolean).join(' ');
    const next = nextByLead.get(lead.id);
    const deal = dealByLead.get(lead.id);
    const custom = (lead.customFields ?? {}) as Record<string, unknown>;
    return [
      lead.id, row.companyName, row.companyDomain, lead.title, lead.product, lead.status, lead.score,
      owner?.name ?? '', owner?.email ?? '', (labelsByLead.get(lead.id) ?? []).join(', '),
      contactName, row.contactEmail, row.contactPhone, row.contactPosition,
      lead.signal, lead.painSignal, lead.evidence, lead.whyFit, lead.whyNow,
      lead.sourceTitle, lead.sourceUrl, lead.sourceType, lead.signalDate, lead.sourceCheckedAt,
      lead.suggestedChannel, lead.opener, lead.caution, lead.nurtureUntil, lead.disqualifiedReason,
      next?.type ?? '', next?.subject ?? '', next?.dueAt ?? '',
      deal?.id ?? '', deal?.title ?? '',
      (lead.createdBy && usersById.get(lead.createdBy)?.name) || '', lead.createdAt, lead.updatedAt,
      ...fieldDefs.map((field) => customFieldCell(custom[field.key], optionsOf(field.options))),
    ];
  });

  return { header, rows: data };
}
