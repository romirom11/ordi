/**
 * Deterministic races for the API tests. A trigger parks one side on an
 * advisory lock the test holds, mid-way and holding its row locks; the other
 * side is started, the test waits until Postgres reports it blocked, then
 * lets the first go. Advisory locks are per database, and each test worker
 * has a database of its own, so files running in parallel do not meet.
 */
import { getDb, sql } from '@ordi/db';

const PARK_KEY = 4141;

/**
 * Hold the advisory lock on a connection of its own until `release` is
 * called. A trigger that takes the same lock parks whichever transaction
 * fires it, mid-way and holding its row locks.
 */
export async function holdPark(): Promise<{ release: () => Promise<void> }> {
  const { db } = getDb();
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  let taken!: () => void;
  const lockTaken = new Promise<void>((r) => { taken = r; });
  const tx = db.transaction(async (t) => {
    await t.execute(sql.raw(`SELECT pg_advisory_xact_lock(${PARK_KEY})`));
    taken();
    await held;
  });
  await lockTaken;
  return { release: async () => { release(); await tx; } };
}

/**
 * Wait until a backend of this database (each test worker has its own) is
 * blocked on a lock of the given kind while running a statement like
 * `queryLike` – so the park is released only once the very request we mean
 * is waiting, not on some unrelated wait.
 */
export async function waitUntilBlocked(kind: 'advisory' | 'row', ...queryLike: string[]): Promise<void> {
  const { db } = getDb();
  const events = kind === 'advisory' ? `'advisory'` : `'transactionid', 'tuple'`;
  for (let i = 0; i < 400; i++) {
    const rows = await db.execute(sql`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock' AND wait_event IN (${sql.raw(events)})
        AND query ILIKE ANY (${sql.raw(`ARRAY[${queryLike.map((q) => `'${q.replace(/'/g, "''")}'`).join(', ')}]`)})`);
    if (Number((rows as unknown as { n: number }[])[0]?.n ?? 0) > 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`no backend blocked on a ${kind} lock in ${queryLike.join(' or ')}`);
}

/** Requests a test started, all settled before its trigger is dropped. */
let inFlight: Promise<unknown>[] = [];

/** Forget the requests of an earlier test. */
export function resetInFlight(): void {
  inFlight = [];
}

export function start<T>(request: T | Promise<T>): Promise<T> {
  const pending = Promise.resolve(request);
  inFlight.push(pending.catch(() => undefined));
  return pending;
}

export async function parkOn(table: string, when: string) {
  await getDb().db.execute(sql.raw(`
    CREATE OR REPLACE FUNCTION test_park() RETURNS trigger AS $$
    BEGIN PERFORM pg_advisory_xact_lock(${PARK_KEY}); RETURN NEW; END $$ LANGUAGE plpgsql;
    CREATE TRIGGER test_park BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW WHEN (${when}) EXECUTE FUNCTION test_park();`));
}

export async function unpark(table: string) {
  await Promise.allSettled(inFlight);
  await getDb().db.execute(sql.raw(`DROP TRIGGER IF EXISTS test_park ON ${table}; DROP FUNCTION IF EXISTS test_park();`));
}
