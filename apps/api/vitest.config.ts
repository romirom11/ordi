import os from 'node:os';
import { defineConfig } from 'vitest/config';

// Point the whole test run at the test database and disable background workers.
// TEST_DATABASE_URL is the template: global-setup migrates it once and clones
// one copy per worker (worker-db.ts points each worker at its own copy).
process.env.ORDI_TEST_TEMPLATE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ordi_test';
process.env.DATABASE_URL = process.env.ORDI_TEST_TEMPLATE_URL;
process.env.WORKERS_ENABLED = 'false';
process.env.NODE_ENV = 'test';

/**
 * Test files run in parallel, each worker on a database of its own: they used
 * to share one and so ran one at a time. TEST_WORKERS overrides the count.
 */
const workers = Number(process.env.TEST_WORKERS) || Math.min(4, os.availableParallelism());
process.env.ORDI_TEST_WORKERS = String(workers);

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    poolOptions: { forks: { minForks: 1, maxForks: workers } },
    hookTimeout: 60_000,
    testTimeout: 30_000,
    globalSetup: './src/test/global-setup.ts',
    setupFiles: ['./src/test/worker-db.ts'],
  },
});
