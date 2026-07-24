import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import { getDb, schema, sql, eq } from '@ordi/db';
import { ulid } from 'ulid';
import { setupSchema } from '@ordi/shared';
import type { AppEnv } from '../../context';
import { env } from '../../env';
import { err } from '../../lib/errors';
import { SESSION_COOKIE } from '../../core/auth';
import { hashPassword, generateToken } from '../../lib/crypto';
import { seedBaseline } from '../../seed-baseline';

/**
 * First-run setup (PRD §20). Public — mounted like /auth. Available only while
 * the users table is empty; once an owner exists this is locked (403).
 */
async function needsSetup(): Promise<boolean> {
  const { db } = getDb();
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.users);
  return (row?.n ?? 0) === 0;
}

export function setupRoutes() {
  const app = new Hono<AppEnv>();

  app.get('/status', async (c) => {
    return c.json({ needsSetup: await needsSetup() });
  });

  app.post('/', async (c) => {
    if (!(await needsSetup())) throw err.forbidden('Workspace already set up');
    const body = setupSchema.parse(await c.req.json());
    const { db } = getDb();

    // Baseline config (idempotent) + workspace name.
    const { roleIds } = await seedBaseline(db, body.workspaceName);
    // Ensure the workspace name reflects the chosen value even if the row pre-existed.
    await db.update(schema.workspaceSettings)
      .set({ name: body.workspaceName })
      .where(eq(schema.workspaceSettings.id, 'workspace'));

    // Owner user (same password hashing as auth).
    const ownerRoleId = roleIds.get('owner');
    if (!ownerRoleId) throw err.domain('Owner role missing after baseline seed');
    const userId = ulid();
    await db.insert(schema.users).values({
      id: userId,
      email: body.email.toLowerCase(),
      name: body.name,
      passwordHash: hashPassword(body.password),
      roleId: ownerRoleId,
    });

    // Log the client in immediately: same success shape as POST /auth/login.
    const ip = c.req.header('x-forwarded-for') ?? 'local';
    const token = generateToken();
    await db.insert(schema.sessions).values({
      id: ulid(), userId, token,
      expiresAt: new Date(Date.now() + 30 * 24 * 3600_000),
      ipAddress: ip, userAgent: c.req.header('user-agent') ?? '',
    });
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true, sameSite: 'Lax', secure: env.isProd, path: '/', maxAge: 30 * 24 * 3600,
    });
    return c.json({ ok: true, userId, sessionToken: token });
  });

  return app;
}
