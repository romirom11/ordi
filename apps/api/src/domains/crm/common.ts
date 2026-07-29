/**
 * Pieces more than one CRM module needs. Kept deliberately small: anything that
 * belongs to a single entity lives in that entity's module instead.
 */
import { getDb, schema, eq, and, isNull } from '@ordi/db';
import { err } from '../../lib/errors';

/** A `select`-only view of the db handle, so helpers accept a tx or the pool. */
export type DbReader = Pick<ReturnType<typeof getDb>['db'], 'select'>;

/** Lead statuses that end active work and therefore clear planned activities. */
export const CANCELS_PLANNED_LEAD_STATUSES = new Set(['nurture', 'disqualified', 'no_response']);

export function boundedLimit(value: number | undefined, fallback: number, maximum: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(Math.trunc(value!), maximum)) : fallback;
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
