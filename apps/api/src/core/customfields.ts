/**
 * Custom-field query building (PRD §5.5). Client never sends raw SQL; the API
 * takes a structured filter { field_key, op, value }, validates op-under-type
 * against the registry, and builds a parameterized JSONB predicate. Sorting
 * projects the value to a typed expression.
 */
import { getDb, schema, eq, and, sql, type SQL } from '@ordi/db';
import type { CustomFieldFilter, CustomFieldType } from '@ordi/shared';
import { err } from '../lib/errors';

interface FieldDef {
  key: string;
  type: CustomFieldType;
  isSortable: boolean;
}

const registryCache = new Map<string, Map<string, FieldDef>>();

export async function loadRegistry(entityType: string): Promise<Map<string, FieldDef>> {
  const cached = registryCache.get(entityType);
  if (cached) return cached;
  const { db } = getDb();
  const rows = await db
    .select()
    .from(schema.customFieldDefinitions)
    .where(eq(schema.customFieldDefinitions.entityType, entityType));
  const map = new Map<string, FieldDef>(
    rows.map((r) => [r.key, { key: r.key, type: r.type as CustomFieldType, isSortable: r.isSortable }]),
  );
  registryCache.set(entityType, map);
  return map;
}

export function invalidateRegistry(entityType?: string): void {
  if (entityType) registryCache.delete(entityType);
  else registryCache.clear();
}

/**
 * Merge a PATCH's customFields into the stored blob, per key.
 *
 * The column holds every custom field of a record in one JSONB object, so
 * assigning the incoming object wholesale made a caller who set one field
 * erase all the others – invisible in the UI (its editor round-trips the whole
 * object) and destructive for every API/MCP client that sends just the field it
 * changed. Passing an explicit null clears a key; omitting a key keeps it.
 */
export function mergeCustomFields(before: unknown, incoming: unknown): Record<string, unknown> {
  const base = (before && typeof before === 'object' && !Array.isArray(before) ? before : {}) as Record<string, unknown>;
  const patch = (incoming && typeof incoming === 'object' && !Array.isArray(incoming) ? incoming : {}) as Record<string, unknown>;
  return { ...base, ...patch };
}

const OPS_BY_TYPE: Record<CustomFieldType, string[]> = {
  number: ['eq', 'gt', 'lt', 'between'],
  date: ['before', 'after', 'between', 'eq'],
  select: ['in', 'eq'],
  multiselect: ['in'],
  text: ['contains', 'eq'],
  url: ['contains', 'eq'],
  checkbox: ['eq'],
  user: ['eq', 'in'],
};

const SORTABLE_TYPES: CustomFieldType[] = ['number', 'date', 'select', 'text'];

/** Column expression for the JSONB value cast to the field's type. */
function typedValue(column: string, key: string, type: CustomFieldType): SQL {
  const path = sql.raw(`(${column}->>${quote(key)})`);
  if (type === 'number') return sql`${path}::numeric`;
  if (type === 'date') return sql`${path}::date`;
  return sql`${path}`;
}

function quote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

export async function buildCustomFieldFilter(
  entityType: string,
  filter: CustomFieldFilter,
  column = 'custom_fields',
): Promise<SQL> {
  const registry = await loadRegistry(entityType);
  const def = registry.get(filter.field_key);
  if (!def) throw err.validation(`Unknown custom field '${filter.field_key}'`);
  const allowed = OPS_BY_TYPE[def.type];
  if (!allowed.includes(filter.op)) {
    throw err.validation(`Operator '${filter.op}' not valid for type '${def.type}'`);
  }
  const value = typedValue(column, def.key, def.type);
  const v = filter.value as any;
  switch (filter.op) {
    case 'eq':
      return def.type === 'checkbox' ? sql`${value} = ${String(!!v)}` : sql`${value} = ${v}`;
    case 'gt': return sql`${value} > ${v}`;
    case 'lt': return sql`${value} < ${v}`;
    case 'before': return sql`${value} < ${v}::date`;
    case 'after': return sql`${value} > ${v}::date`;
    case 'between': {
      if (!Array.isArray(v) || v.length !== 2) throw err.validation('between needs [min,max]');
      return sql`${value} between ${v[0]} and ${v[1]}`;
    }
    case 'contains': return sql`${value} ilike ${'%' + String(v) + '%'}`;
    case 'in': {
      if (!Array.isArray(v)) throw err.validation('in needs an array');
      return sql`${value} = any(${v})`;
    }
    default:
      throw err.validation(`Unsupported op '${filter.op}'`);
  }
}

export async function buildCustomFieldSort(
  entityType: string,
  key: string,
  order: 'asc' | 'desc',
  column = 'custom_fields',
): Promise<SQL> {
  const registry = await loadRegistry(entityType);
  const def = registry.get(key);
  if (!def) throw err.validation(`Unknown custom field '${key}'`);
  if (!def.isSortable || !SORTABLE_TYPES.includes(def.type)) {
    throw err.validation(`Field '${key}' is not sortable`);
  }
  const value = typedValue(column, def.key, def.type);
  return order === 'desc' ? sql`${value} desc nulls last` : sql`${value} asc nulls last`;
}
