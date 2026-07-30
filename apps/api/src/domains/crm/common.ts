/**
 * Pieces more than one CRM module needs. Kept deliberately small: anything that
 * belongs to a single entity lives in that entity's module instead.
 */
import { getDb, schema, eq, and, isNull, type Database } from '@ordi/db';
import { err } from '../../lib/errors';

/** A `select`-only view of the db handle, so helpers accept a tx or the pool. */
export type DbReader = Pick<Database, 'select'>;

/** Read plus write, for helpers that also insert or update inside a caller's tx. */
export type DbWriter = Pick<Database, 'select' | 'insert' | 'update' | 'delete'>;

/** Lead statuses that end active work and therefore clear planned activities. */
export const CANCELS_PLANNED_LEAD_STATUSES = new Set(['nurture', 'disqualified', 'no_response']);

export function boundedLimit(value: number | undefined, fallback: number, maximum: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(Math.trunc(value!), maximum)) : fallback;
}

/**
 * Collect the fields a partial update actually set. Every CRM update builds the
 * same patch the same way; the key list stays with its entity so the compiler
 * still checks it against that entity's schema.
 */
export function pickDefined<T extends object, K extends keyof T>(
  input: T,
  keys: readonly K[],
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const key of keys) {
    if (input[key] !== undefined) patch[key as string] = input[key];
  }
  return patch;
}

/** A contact may only be attached to a record of its own company. */
export async function assertContactCompany(
  companyId: string,
  contactId: string | null | undefined,
  dbOrTx: DbReader = getDb().db,
): Promise<void> {
  if (!contactId) return;
  const [contact] = await dbOrTx.select({ id: schema.contacts.id }).from(schema.contacts).where(and(
    eq(schema.contacts.id, contactId),
    eq(schema.contacts.companyId, companyId),
    isNull(schema.contacts.deletedAt),
  ));
  if (!contact) throw err.validation('Contact does not belong to the company');
}

export async function assertCompanyExists(
  companyId: string,
  dbOrTx: DbReader = getDb().db,
): Promise<void> {
  const [company] = await dbOrTx.select({ id: schema.companies.id }).from(schema.companies).where(and(
    eq(schema.companies.id, companyId),
    isNull(schema.companies.deletedAt),
  ));
  if (!company) throw err.notFound('Company not found');
}
