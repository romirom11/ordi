/** Vitest global setup: ensure the test database schema + triggers exist. */
import { runMigrations } from '@ordi/db';

export default async function setup() {
  await runMigrations(process.env.DATABASE_URL);
}
