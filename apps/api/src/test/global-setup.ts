/**
 * Vitest global setup: migrate the template test database (schema + triggers)
 * once, then clone it for every worker. CREATE DATABASE … TEMPLATE copies the
 * migrated schema in a moment, far cheaper than migrating each copy.
 */
import postgres from 'postgres';
import { runMigrations } from '@ordi/db';
import { workerDatabaseUrl } from './worker-db-url';

export default async function setup() {
  const templateUrl = process.env.ORDI_TEST_TEMPLATE_URL!;
  await runMigrations(templateUrl);

  const template = new URL(templateUrl).pathname.slice(1);
  const admin = new URL(templateUrl);
  admin.pathname = '/postgres';
  const sql = postgres(admin.toString(), { max: 1, onnotice: () => {} });
  try {
    const workers = Number(process.env.ORDI_TEST_WORKERS) || 1;
    for (let id = 1; id <= workers; id += 1) {
      const name = new URL(workerDatabaseUrl(templateUrl, id)).pathname.slice(1);
      await sql.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await sql.unsafe(`CREATE DATABASE "${name}" TEMPLATE "${template}"`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}
