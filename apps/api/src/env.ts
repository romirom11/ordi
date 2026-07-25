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
  /** GitHub OAuth app credentials for connecting git accounts (PRD §13.1). */
  githubOAuthClientId: process.env.GITHUB_OAUTH_CLIENT_ID ?? '',
  githubOAuthClientSecret: process.env.GITHUB_OAUTH_CLIENT_SECRET ?? '',
  /** Slack app credentials for the workspace Slack connection (OAuth v2). */
  slackClientId: process.env.SLACK_CLIENT_ID ?? '',
  slackClientSecret: process.env.SLACK_CLIENT_SECRET ?? '',
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
  // Desktop (Tauri) origins are always allowed on top of the configured list –
  // the desktop app authenticates with bearer tokens, and forgetting them in
  // CORS_ORIGINS would silently lock every desktop client out.
  corsOrigins: [
    ...new Set([
      ...(process.env.CORS_ORIGINS ?? 'http://localhost:5173').split(','),
      'tauri://localhost',
      'http://tauri.localhost',
    ]),
  ],
  /** disable workers (e.g. in tests) */
  workersEnabled: process.env.WORKERS_ENABLED !== 'false',
};
