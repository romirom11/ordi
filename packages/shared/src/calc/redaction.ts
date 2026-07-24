/**
 * Audit diff redaction (PRD §14.4). Centralised serializer with a registry of
 * sensitive keys. Sensitive fields record the fact of change without value;
 * secrets are excluded entirely (never even a fact-record with material).
 */

/** Fields whose *values* are redacted but the fact of change is recorded. */
export const REDACTED_FIELDS = new Set<string>([
  'compensation.amount',
  'amount', // compensation/overhead amounts
  'salaryRange',
  'salary_range',
  'sensitive',
  'emergencyContact',
  'emergency_contact',
  'dateOfBirth',
  'personalAddress',
]);

/** Entities considered sensitive (HR/compensation) — records get sensitivity=sensitive. */
export const SENSITIVE_ENTITIES = new Set<string>([
  'compensation',
  'overhead_settings',
]);

/** Keys that must NEVER appear in a diff (excluded at serializer level). */
export const SECRET_FIELDS = new Set<string>([
  'hash',
  'password',
  'passwordHash',
  'secret',
  'webhookSecret',
  'webhook_secret',
  'credentials',
  'token',
  'accessToken',
  'portalToken',
  'publicToken',
  'formToken',
]);

export type DiffValue = { action: 'changed' } | { from: unknown; to: unknown };

export interface RedactedDiff {
  diff: Record<string, DiffValue>;
  sensitivity: 'normal' | 'sensitive';
}

/**
 * Build a redacted diff between old and new values.
 * - secret fields: omitted completely
 * - redacted fields: `{action:'changed'}` only
 * - everything else: `{from, to}`
 */
export function buildRedactedDiff(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  entityType?: string,
): RedactedDiff {
  const diff: Record<string, DiffValue> = {};
  const keys = new Set<string>([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  let sensitivity: 'normal' | 'sensitive' = SENSITIVE_ENTITIES.has(entityType ?? '') ? 'sensitive' : 'normal';

  for (const key of keys) {
    if (SECRET_FIELDS.has(key)) continue; // never recorded
    const oldV = before?.[key];
    const newV = after?.[key];
    if (jsonEqual(oldV, newV)) continue;

    if (REDACTED_FIELDS.has(key)) {
      diff[key] = { action: 'changed' };
      sensitivity = 'sensitive';
    } else {
      diff[key] = { from: oldV ?? null, to: newV ?? null };
    }
  }
  return { diff, sensitivity };
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}
