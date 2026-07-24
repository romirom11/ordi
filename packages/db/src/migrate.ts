/**
 * Migration runner: applies Drizzle SQL migrations then the triggers/FTS SQL.
 * Additive migrations run as a separate deploy step before switching traffic (PRD §19.2).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function runMigrations(url = process.env.DATABASE_URL): Promise<void> {
  if (!url) throw new Error('DATABASE_URL is not set');
  const sql = postgres(url, { max: 1 });
  const db = drizzle(sql);
  try {
    const migrationsFolder = join(__dirname, '..', 'drizzle');
    await migrate(db, { migrationsFolder });
    const triggers = readFileSync(join(__dirname, 'triggers.sql'), 'utf8');
    await sql.unsafe(triggers);
    // eslint-disable-next-line no-console
    console.log('✓ migrations + triggers applied');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
