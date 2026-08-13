/**
 * End-to-end suite: the real stack, driven through a real browser. The API
 * webServer command owns its world – it (re)creates the ordi_e2e database,
 * migrates, seeds the owner account and only then listens; a throwaway
 * s3rver stands in for object storage so uploads work; Vite serves the SPA.
 * Locally `pnpm --filter @ordi/web e2e`; CI runs the same in its own job.
 */
import { defineConfig } from '@playwright/test';

const DB = process.env.E2E_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ordi_e2e';

const apiEnv = {
  NODE_ENV: 'development',
  PORT: '3000',
  APP_URL: 'http://localhost:5173',
  API_URL: 'http://localhost:3000',
  DATABASE_URL: DB,
  AUTH_SECRET: 'e2e-only-secret',
  ENCRYPTION_KEY: '0'.repeat(64),
  CORS_ORIGINS: 'http://localhost:5173',
  WORKERS_ENABLED: 'false',
  S3_ENDPOINT: 'http://localhost:4568',
  S3_BUCKET: 'ordi',
  S3_ACCESS_KEY: 'S3RVER',
  S3_SECRET_KEY: 'S3RVER',
  S3_REGION: 'auto',
  SEED_OWNER_EMAIL: 'owner@e2e.local',
  SEED_OWNER_PASSWORD: 'password123',
};

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // One worker: the suite shares one seeded workspace.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:5173',
    locale: 'en-US',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    // Sandboxed environments ship a system Chromium instead of the
    // playwright-managed download – point at it via env and skip the registry.
    ...(process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH, args: ['--no-sandbox'] } }
      : {}),
  },
  webServer: [
    {
      command: 'pnpm exec s3rver --directory ../../.e2e-s3 --configure-bucket ordi --port 4568',
      port: 4568,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'bash -c "node e2e/reset-db.mjs && pnpm --dir ../.. run db:migrate && pnpm --dir ../api run seed && pnpm --dir ../api exec tsx src/server.ts"',
      port: 3000,
      env: apiEnv,
      reuseExistingServer: false,
      timeout: 180_000,
    },
    {
      command: 'pnpm exec vite --port 5173 --strictPort',
      port: 5173,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
