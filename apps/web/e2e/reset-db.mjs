/**
 * Drop and recreate the e2e database so every run starts from the same
 * blank state. Connects to the server's default `postgres` database –
 * the target one may not exist yet, that being the point.
 */
import postgres from 'postgres';

const url = new URL(process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ordi_e2e');
const dbName = url.pathname.slice(1);
const admin = new URL(url);
admin.pathname = '/postgres';

const sql = postgres(admin.toString(), { max: 1 });
try {
  await sql.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
} catch {
  // Postgres < 13 has no WITH (FORCE).
  await sql.unsafe(`DROP DATABASE IF EXISTS "${dbName}"`);
}
await sql.unsafe(`CREATE DATABASE "${dbName}"`);
await sql.end();
console.log(`e2e database "${dbName}" reset`);
