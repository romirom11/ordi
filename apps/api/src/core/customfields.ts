/**
 * Custom-field query building (PRD §5.5). Client never sends raw SQL; the API
 * takes a structured filter { field_key, op, value }, validates op-under-type
 * against the registry, and builds a parameterized JSONB predicate. Sorting
 * projects the value to a typed expression.
 */
import { z } from 'zod';
import { getDb, schema, eq, and, sql, type SQL } from '@ordi/db';
import { customFieldFilterSchema, type CustomFieldFilter, type CustomFieldType } from '@ordi/shared';
import { err } from '../lib/errors';

/**
 * The `cf` query parameter: a JSON list of filters. Malformed JSON or a list
 * that is not one of filters is a 400 – dropping it silently answered with an
 * unfiltered list, and an object in place of the list crashed the loop over it.
 */
export function parseCustomFieldFilters(raw: string | undefined): CustomFieldFilter[] {
  if (raw === undefined) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw err.validation('cf must be a JSON list of custom-field filters'); }
  return z.array(customFieldFilterSchema).parse(parsed);
}

interface FieldDef {
  key: string;
  type: CustomFieldType;
  isSortable: boolean;
  /** null = workspace-wide; set = the field exists only on this project's records. */
  projectId: string | null;
}

/**
 * Every definition per key. A workspace key is unique, but projects each keep
 * their own: two projects may hold the same key, with different types.
 */
const registryCache = new Map<string, Map<string, FieldDef[]>>();

export async function loadRegistry(entityType: string): Promise<Map<string, FieldDef[]>> {
  const cached = registryCache.get(entityType);
  if (cached) return cached;
  const { db } = getDb();
  const rows = await db
    .select()
    .from(schema.customFieldDefinitions)
    .where(eq(schema.customFieldDefinitions.entityType, entityType));
  const map = new Map<string, FieldDef[]>();
  for (const r of rows) {
    const def = { key: r.key, type: r.type as CustomFieldType, isSortable: r.isSortable, projectId: r.projectId };
    map.set(r.key, [...(map.get(r.key) ?? []), def]);
  }
  registryCache.set(entityType, map);
  return map;
}

/**
 * The definitions of a key the caller may know of: workspace fields, and a
 * project's own fields only for projects in `projectIds`. A key that exists
 * only in projects the caller cannot open comes back empty, the same as a key
 * nobody made, so a filter cannot be used to probe for a private field.
 */
async function visibleDefs(entityType: string, key: string, projectIds: readonly string[] = []): Promise<FieldDef[]> {
  const registry = await loadRegistry(entityType);
  const reachable = new Set(projectIds);
  return (registry.get(key) ?? []).filter((d) => d.projectId === null || reachable.has(d.projectId));
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

/**
 * `in` is "any of these values": every type with a value to compare takes it,
 * since MCP's list_tasks sends any array as `in` whatever the field's type. A
 * checkbox has two values, so `eq` is all it needs.
 */
const OPS_BY_TYPE: Record<CustomFieldType, string[]> = {
  number: ['eq', 'gt', 'lt', 'between', 'in'],
  date: ['before', 'after', 'between', 'eq', 'in'],
  select: ['in', 'eq'],
  multiselect: ['in'],
  text: ['contains', 'eq', 'in'],
  url: ['contains', 'eq', 'in'],
  checkbox: ['eq'],
  user: ['eq', 'in'],
};

/** An `in` list is one bound parameter per value; this keeps it well inside Postgres's limit. */
const MAX_IN_VALUES = 500;

const SORTABLE_TYPES: CustomFieldType[] = ['number', 'date', 'select', 'text'];

/** The field's JSON value, `->`, or its text, `->>`. The key is a bound parameter too. */
function jsonPath(column: string, key: string, asText: boolean): SQL {
  return asText ? sql`(${sql.raw(column)}->>${key}::text)` : sql`(${sql.raw(column)}->${key}::text)`;
}

/**
 * Column expression for the JSONB value cast to the field's type. Values are
 * stored as sent – nothing checks them against the field's type – so a value
 * that is no number (or no date) reads as null rather than abort the query.
 */
function typedValue(column: string, key: string, type: CustomFieldType): SQL {
  const path = jsonPath(column, key, true);
  if (type === 'number') return sql`(case when pg_input_is_valid(${path}, 'numeric') then ${path}::numeric end)`;
  if (type === 'date') return sql`(case when pg_input_is_valid(${path}, 'date') then ${path}::date end)`;
  return path;
}

export interface CustomFieldScope {
  /** The projects whose own fields the caller may know of (those they can open). */
  projectIds?: readonly string[];
  /** The record's project column, so a project field's predicate holds only in projects that define it. */
  projectColumn?: SQL;
  column?: string;
}

export async function buildCustomFieldFilter(
  entityType: string,
  filter: CustomFieldFilter,
  scope: CustomFieldScope = {},
): Promise<SQL> {
  const column = scope.column ?? 'custom_fields';
  const defs = await visibleDefs(entityType, filter.field_key, scope.projectIds);
  if (!defs.length) throw err.validation(`Unknown custom field '${filter.field_key}'`);
  const matching = defs.filter((d) => OPS_BY_TYPE[d.type].includes(filter.op));
  if (!matching.length) {
    throw err.validation(`Operator '${filter.op}' not valid for type '${defs[0]!.type}'`);
  }
  // A workspace key is the only definition of its key.
  const workspaceDef = matching.find((d) => d.projectId === null);
  if (workspaceDef) return fieldPredicate(column, workspaceDef, filter);
  if (!scope.projectColumn) throw err.validation(`Unknown custom field '${filter.field_key}'`);
  // Projects may give one key different types: each type's predicate holds in
  // the projects that give the key that type, and a record matches any of them.
  // CASE, not AND: a value is cast to a type only on records of the projects
  // where it has that type, never on another project's values.
  const byType = new Map<CustomFieldType, FieldDef[]>();
  for (const d of matching) byType.set(d.type, [...(byType.get(d.type) ?? []), d]);
  // A value that is no number (or no date) cannot be compared as one: Postgres
  // casts the parameter itself, CASE or not. Such a type is left out, unless
  // it is the only one, which then fails with a 400. For `in`, each type takes
  // the values it can compare: ["small", "1"] looks for "1" where the key is a
  // number and for both where it is text.
  let branches = [...byType.values()].map((sameType) => ({ def: sameType[0]!, defs: sameType, filter }));
  if (branches.length > 1) {
    const fitting = branches.flatMap((b) => {
      if (filter.op !== 'in' || !Array.isArray(filter.value)) return valueFits(b.def.type, filter.value) ? [b] : [];
      const values = filter.value.filter((x) => valueFits(b.def.type, x));
      return values.length ? [{ ...b, filter: { ...filter, value: values } }] : [];
    });
    if (fitting.length) branches = fitting;
  }
  const parts = branches.map(({ def, defs: sameType, filter: f }) => {
    const inProjects = sql.join(sameType.map((d) => sql`${d.projectId}`), sql`, `);
    return sql`(case when ${scope.projectColumn} in (${inProjects}) then ${fieldPredicate(column, def, f)} else false end)`;
  });
  return parts.length === 1 ? parts[0]! : sql`(${sql.join(parts, sql` or `)})`;
}

/** Whether a filter value (or each of a list's values) can be compared as this type. */
function valueFits(type: CustomFieldType, value: unknown): boolean {
  const values = Array.isArray(value) ? value : [value];
  if (type === 'number') return values.every((x) => numericText(x) !== null);
  if (type === 'date') return values.every((x) => dateText(x) !== null);
  return true;
}

/**
 * A number as the text Postgres reads as numeric, or null. Stricter than
 * JavaScript's Number(): that also takes " 3", " 3", "0x10" or
 * "Infinity", which Postgres refuses.
 */
function numericText(x: unknown): string | null {
  if (typeof x === 'number') return Number.isFinite(x) ? String(x) : null;
  if (typeof x === 'string' && /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d{1,4})?$/.test(x)) return x;
  return null;
}

/**
 * The calendar date a value starts with, as YYYY-MM-DD, or null: a date or
 * an ISO timestamp, on a day that exists (no 2026-02-30) in a year Postgres
 * takes (no year 0000).
 */
function dateText(x: unknown): string | null {
  if (typeof x !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(x);
  if (!m || m[1] === '0000') return null;
  const day = x.slice(0, 10);
  const d = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === day ? day : null;
}

/**
 * One operand of a filter as a bound parameter of the field's type. A value
 * the type cannot compare is the caller's mistake: a 400, never SQL that
 * fails to run. Lists and objects are never an operand – bound as one value
 * they would spread into several parameters.
 */
function operand(def: FieldDef, op: string, x: unknown): SQL {
  if (def.type === 'number') {
    const n = numericText(x);
    if (n === null) throw err.validation(`'${op}' on '${def.key}' needs numbers`);
    return sql`${n}::numeric`;
  }
  if (def.type === 'date') {
    const d = dateText(x);
    if (d === null) throw err.validation(`'${op}' on '${def.key}' needs dates as YYYY-MM-DD`);
    return sql`${d}::date`;
  }
  // Text, url, select, multiselect and user values are compared as text; a
  // number is taken as the text it reads as.
  if (typeof x === 'string') return sql`${x}::text`;
  if (typeof x === 'number' && Number.isFinite(x)) return sql`${String(x)}::text`;
  throw err.validation(`'${op}' on '${def.key}' needs text values`);
}

/** The values of an `in` filter: a non-empty list, short enough to bind one parameter each. */
function inValues(def: FieldDef, v: unknown): SQL[] {
  if (!Array.isArray(v) || !v.length) throw err.validation(`'in' on '${def.key}' needs a non-empty list of values`);
  if (v.length > MAX_IN_VALUES) throw err.validation(`'in' on '${def.key}' takes at most ${MAX_IN_VALUES} values`);
  return v.map((x) => operand(def, 'in', x));
}

function fieldPredicate(column: string, def: FieldDef, filter: CustomFieldFilter): SQL {
  const value = typedValue(column, def.key, def.type);
  const v = filter.value as unknown;
  switch (filter.op) {
    case 'eq':
      if (def.type === 'checkbox') {
        if (typeof v === 'object' && v !== null) throw err.validation(`'eq' on '${def.key}' needs a single value`);
        return sql`${value} = ${String(!!v)}::text`;
      }
      return sql`${value} = ${operand(def, 'eq', v)}`;
    case 'gt': return sql`${value} > ${operand(def, 'gt', v)}`;
    case 'lt': return sql`${value} < ${operand(def, 'lt', v)}`;
    case 'before': return sql`${value} < ${operand(def, 'before', v)}`;
    case 'after': return sql`${value} > ${operand(def, 'after', v)}`;
    case 'between': {
      if (!Array.isArray(v) || v.length !== 2) throw err.validation('between needs [min,max]');
      return sql`${value} between ${operand(def, 'between', v[0])} and ${operand(def, 'between', v[1])}`;
    }
    case 'contains': {
      if (typeof v !== 'string' && typeof v !== 'number') throw err.validation(`'contains' on '${def.key}' needs text`);
      return sql`${value} ilike ${'%' + String(v) + '%'}`;
    }
    case 'in': {
      const values = sql.join(inValues(def, v), sql`, `);
      if (def.type === 'multiselect') {
        // The value is a JSON list: it matches when it holds any of the
        // values. `?|` also reads an object's keys, so only a list (or a lone
        // string) is looked into.
        const path = jsonPath(column, def.key, false);
        return sql`(jsonb_typeof(${path}) in ('array', 'string') and ${path} ?| array[${values}])`;
      }
      return sql`${value} in (${values})`;
    }
    default:
      throw err.validation(`Unsupported op '${filter.op}'`);
  }
}

export async function buildCustomFieldSort(
  entityType: string,
  key: string,
  order: 'asc' | 'desc',
  scope: Pick<CustomFieldScope, 'projectIds' | 'column'> = {},
): Promise<SQL> {
  const column = scope.column ?? 'custom_fields';
  const def = (await visibleDefs(entityType, key, scope.projectIds))[0];
  if (!def) throw err.validation(`Unknown custom field '${key}'`);
  if (!def.isSortable || !SORTABLE_TYPES.includes(def.type)) {
    throw err.validation(`Field '${key}' is not sortable`);
  }
  const value = typedValue(column, def.key, def.type);
  return order === 'desc' ? sql`${value} desc nulls last` : sql`${value} asc nulls last`;
}
