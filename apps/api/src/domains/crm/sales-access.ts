import type { Actor } from '../../context';
import { err } from '../../lib/errors';

export function assertSalesWrite(actor: Actor, dealId?: string | null): void {
  const permission = dealId ? 'deals.write' : 'crm.write';
  if (actor.readOnly || !actor.access.permissions.has(permission)) {
    throw err.forbidden(`Missing permission ${permission}`, permission);
  }
}
