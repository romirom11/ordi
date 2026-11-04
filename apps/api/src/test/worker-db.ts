/**
 * Runs in each test worker before its test files: point DATABASE_URL at this
 * worker's own copy of the test database (created by global-setup), so files
 * in different workers never truncate each other's rows.
 */
import { workerDatabaseUrl } from './worker-db-url';

process.env.DATABASE_URL = workerDatabaseUrl(process.env.ORDI_TEST_TEMPLATE_URL!, process.env.VITEST_POOL_ID ?? '1');
