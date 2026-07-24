/** Environment configuration. Secrets only from env (PRD §19.1). */

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing env ${name}`);
  return v;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  isProd: process.env.NODE_ENV === 'production',
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: required('DATABASE_URL', 'postgres://postgres:postgres@localhost:5432/ordi'),
  appUrl: process.env.APP_URL ?? 'http://localhost:5173',
  apiUrl: process.env.API_URL ?? 'http://localhost:3000',
  authSecret: process.env.AUTH_SECRET ?? 'dev-insecure-secret-change-me',
  /** 32-byte hex key for AES-256-GCM (git credentials, PRD §13.1). */
  encryptionKey: process.env.ENCRYPTION_KEY ?? '0'.repeat(64),
  smtpUrl: process.env.SMTP_URL ?? '',
  smtpFrom: process.env.SMTP_FROM ?? 'ordi <no-reply@ordi.local>',
  s3: {
    endpoint: process.env.S3_ENDPOINT ?? '',
    bucket: process.env.S3_BUCKET ?? 'ordi',
    accessKey: process.env.S3_ACCESS_KEY ?? '',
    secretKey: process.env.S3_SECRET_KEY ?? '',
    region: process.env.S3_REGION ?? 'auto',
  },
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:5173,tauri://localhost').split(','),
  /** disable workers (e.g. in tests) */
  workersEnabled: process.env.WORKERS_ENABLED !== 'false',
};
