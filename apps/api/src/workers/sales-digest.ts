import { getDb, schema, sql } from '@ordi/db';
import { ulid } from 'ulid';
import { publishEvent } from '../core/events';
import { salesWork, summarizeSalesWork } from '../domains/crm/work';
import { localDateKey, localHour, safeTimeZone } from '../lib/timezone';
import { logger } from '../lib/logger';

interface DigestUser {
  id: string;
  timezone: string;
  canReadDeals: boolean;
}

export interface SalesDigestRunResult {
  eligible: number;
  emitted: number;
}

/**
 * Emit one digest event during each seller's local working morning. The run
 * ledger also records empty mornings, so activity created later that day does
 * not produce a surprising second "morning" digest.
 */
export async function runSalesWorkDigests(now = new Date()): Promise<SalesDigestRunResult> {
  const { db } = getDb();
  const users = await db.execute(sql`
    select
      users.id,
      users.timezone,
      exists (
        select 1 from role_permissions
        where role_permissions.role_id = users.role_id
          and role_permissions.permission = 'deals.read'
      ) as "canReadDeals"
    from users
    where users.is_active = true
      and users.actor_type = 'user'
      and exists (
        select 1 from role_permissions
        where role_permissions.role_id = users.role_id
          and role_permissions.permission = 'crm.read'
      )
  `) as unknown as DigestUser[];

  const eligible = users.filter((user) => {
    const hour = localHour(now, user.timezone);
    return hour >= 8 && hour < 18;
  });
  let emitted = 0;

  for (const user of eligible) {
    const timeZone = safeTimeZone(user.timezone);
    const localDate = localDateKey(now, timeZone);
    const didEmit = await db.transaction(async (tx) => {
      const inserted = await tx.insert(schema.salesDigestRuns).values({
        id: ulid(),
        userId: user.id,
        localDate,
      }).onConflictDoNothing({
        target: [schema.salesDigestRuns.userId, schema.salesDigestRuns.localDate],
      }).returning({ id: schema.salesDigestRuns.id });
      if (!inserted.length) return false;

      const work = await salesWork({
        userId: user.id,
        timezone: timeZone,
        access: {
          permissions: new Set(user.canReadDeals ? ['crm.read', 'deals.read'] : ['crm.read']),
        },
      }, { scope: 'mine', limit: 1, now });
      const summary = summarizeSalesWork(work);
      if (summary.total === 0) return false;

      await publishEvent(tx, {
        type: 'sales.work_digest_due',
        aggregateType: 'user',
        aggregateId: user.id,
        payload: { userId: user.id, localDate, ...summary },
      });
      return true;
    });
    if (didEmit) emitted++;
  }

  if (emitted) logger.info({ eligible: eligible.length, emitted }, 'sales work digests emitted');
  return { eligible: eligible.length, emitted };
}
