import { defineConfig } from 'vitest/config';

// Point the whole test run at the test database and disable background workers.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ordi_test';
process.env.WORKERS_ENABLED = 'false';
process.env.NODE_ENV = 'test';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    hookTimeout: 60_000,
    testTimeout: 30_000,
    globalSetup: './src/test/global-setup.ts',
  },
});
