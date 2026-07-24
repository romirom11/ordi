import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index';

export type Database = PostgresJsDatabase<typeof schema>;
export type Sql = ReturnType<typeof postgres>;

export interface DbHandle {
  db: Database;
  sql: Sql;
  close: () => Promise<void>;
}

let cached: DbHandle | null = null;

export function createDb(url = process.env.DATABASE_URL): DbHandle {
  if (!url) throw new Error('DATABASE_URL is not set');
  const sql = postgres(url, { max: 10, prepare: false, onnotice: () => {} });
  const db = drizzle(sql, { schema });
  return { db, sql, close: () => sql.end({ timeout: 5 }) };
}

/** Process-wide singleton used by the API. */
export function getDb(): DbHandle {
  if (!cached) cached = createDb();
  return cached;
}

export { schema };
