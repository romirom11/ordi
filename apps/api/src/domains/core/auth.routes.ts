import { Hono } from 'hono';
import { setCookie, deleteCookie } from 'hono/cookie';
import { getDb, schema, eq, and, sql } from '@ordi/db';
import { ulid } from 'ulid';
import { z } from 'zod';
import * as OTPAuth from 'otpauth';
import { loginSchema, acceptInviteSchema, createApiTokenSchema, validateTokenScope } from '@ordi/shared';
import type { AppEnv } from '../../context';
import { env } from '../../env';
import { err } from '../../lib/errors';
import { SESSION_COOKIE, requireAuth, currentActor } from '../../core/auth';
import { hashPassword, verifyPassword, generateToken, sha256 } from '../../lib/crypto';
import { effectivePermissions } from '../../core/rbac';
import { writeActivity } from '../../core/activity';

const rateLimit = new Map<string, { count: number; resetAt: number }>();
function checkRate(key: string, max: number, windowMs: number): void {
  const now = Date.now();
  const rec = rateLimit.get(key);
  if (!rec || rec.resetAt < now) {
    rateLimit.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  rec.count += 1;
  if (rec.count > max) throw err.rateLimited('Too many attempts');
}

export function authRoutes() {
  const app = new Hono<AppEnv>();

  app.post('/login', async (c) => {
    const ip = c.req.header('x-forwarded-for') ?? 'local';
    checkRate(`login:${ip}`, 10, 60_000);
    const body = loginSchema.parse(await c.req.json());
    const { db } = getDb();
    const [user] = await db.select().from(schema.users).where(eq(schema.users.email, body.email.toLowerCase()));
    if (!user || !user.isActive) throw err.unauthenticated('Invalid credentials');
    if (user.lockedUntil && user.lockedUntil > new Date()) throw err.rateLimited('Account locked');

    if (!verifyPassword(body.password, user.passwordHash)) {
      const failed = user.failedLogins + 1;
      await db.update(schema.users).set({
        failedLogins: failed,
        lockedUntil: failed >= 20 ? new Date(Date.now() + 15 * 60_000) : null,
      }).where(eq(schema.users.id, user.id));
      throw err.unauthenticated('Invalid credentials');
    }

    if (user.totpEnabled && user.totpSecret) {
      if (!body.totp) throw err.domain('TOTP required', { totpRequired: true });
      const totp = new OTPAuth.TOTP({ secret: user.totpSecret });
      if (totp.validate({ token: body.totp, window: 1 }) === null) throw err.unauthenticated('Invalid TOTP');
    }

    await db.update(schema.users).set({ failedLogins: 0, lockedUntil: null }).where(eq(schema.users.id, user.id));
    const token = generateToken();
    await db.insert(schema.sessions).values({
      id: ulid(), userId: user.id, token,
      expiresAt: new Date(Date.now() + 30 * 24 * 3600_000),
      ipAddress: ip, userAgent: c.req.header('user-agent') ?? '',
    });
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true, sameSite: 'Lax', secure: env.isProd, path: '/', maxAge: 30 * 24 * 3600,
    });
    // sessionToken doubles as a bearer credential for the desktop client
    // (tauri:// origin cannot use same-site cookies); web ignores it.
    return c.json({ ok: true, userId: user.id, sessionToken: token });
  });

  app.post('/logout', async (c) => {
    const cookieTok = c.req.header('cookie')?.match(/ordi_session=([^;]+)/)?.[1];
    const bearer = c.req.header('Authorization')?.match(/^Bearer (.+)$/)?.[1];
    const { db } = getDb();
    for (const token of [cookieTok, bearer]) {
      if (token) await db.delete(schema.sessions).where(eq(schema.sessions.token, token));
    }
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  app.get('/invite/:token', async (c) => {
    const { db } = getDb();
    const [invite] = await db.select().from(schema.invites).where(eq(schema.invites.token, c.req.param('token')));
    if (!invite || invite.acceptedAt || invite.expiresAt < new Date()) throw err.notFound('Invite invalid or expired');
    return c.json({ email: invite.email, name: invite.name });
  });

  app.post('/accept-invite', async (c) => {
    const body = acceptInviteSchema.parse(await c.req.json());
    const { db } = getDb();
    const [invite] = await db.select().from(schema.invites).where(eq(schema.invites.token, body.token));
    if (!invite || invite.acceptedAt || invite.expiresAt < new Date()) throw err.notFound('Invite invalid or expired');
    const existing = await db.select().from(schema.users).where(eq(schema.users.email, invite.email.toLowerCase()));
    if (existing.length) throw err.domain('User already exists');
    const userId = ulid();
    await db.insert(schema.users).values({
      id: userId, email: invite.email.toLowerCase(), name: body.name,
      passwordHash: hashPassword(body.password), roleId: invite.roleId,
    });
    await db.update(schema.invites).set({ acceptedAt: new Date() }).where(eq(schema.invites.id, invite.id));
    return c.json({ ok: true, userId });
  });

  // ── API tokens (PRD §6, §4.5.5) ──
  const tokens = new Hono<AppEnv>();
  tokens.use('*', requireAuth);

  tokens.get('/', async (c) => {
    const actor = currentActor(c);
    const { db } = getDb();
    const rows = await db.select({
      id: schema.apiTokens.id, name: schema.apiTokens.name, prefix: schema.apiTokens.prefix,
      scopes: schema.apiTokens.scopes, readOnly: schema.apiTokens.readOnly,
      lastUsedAt: schema.apiTokens.lastUsedAt, revokedAt: schema.apiTokens.revokedAt,
      createdAt: schema.apiTokens.createdAt,
    }).from(schema.apiTokens).where(eq(schema.apiTokens.userId, actor.userId));
    return c.json({ data: rows });
  });

  tokens.post('/', async (c) => {
    const actor = currentActor(c);
    const body = createApiTokenSchema.parse(await c.req.json());
    const rolePerms = await effectivePermissions(actor.roleId, null);
    const check = validateTokenScope(rolePerms, body.scopes);
    if (!check.ok) throw err.domain('Token scope exceeds your role', { invalid: check.invalid });
    const raw = `ordi_${generateToken(24)}`;
    const { db } = getDb();
    const id = ulid();
    await db.insert(schema.apiTokens).values({
      id, userId: actor.userId, name: body.name, hash: sha256(raw),
      prefix: raw.slice(0, 12), scopes: body.scopes, readOnly: body.readOnly,
    });
    return c.json({ id, token: raw }, 201); // shown once
  });

  tokens.delete('/:id', async (c) => {
    const actor = currentActor(c);
    const { db } = getDb();
    await db.update(schema.apiTokens).set({ revokedAt: new Date() })
      .where(and(eq(schema.apiTokens.id, c.req.param('id')), eq(schema.apiTokens.userId, actor.userId)));
    return c.json({ ok: true });
  });

  app.route('/tokens', tokens);

  // ── TOTP two-factor auth (PRD §6) ──
  const totpCodeSchema = z.object({ code: z.string().min(1) });

  const totp = new Hono<AppEnv>();
  totp.use('*', requireAuth);

  totp.get('/', async (c) => {
    const actor = currentActor(c);
    const { db } = getDb();
    const [user] = await db.select({ totpEnabled: schema.users.totpEnabled })
      .from(schema.users).where(eq(schema.users.id, actor.userId));
    return c.json({ enabled: user?.totpEnabled ?? false });
  });

  totp.post('/setup', async (c) => {
    const actor = currentActor(c);
    const secret = new OTPAuth.Secret();
    const instance = new OTPAuth.TOTP({ issuer: 'ordi', label: actor.email, secret });
    const { db } = getDb();
    // Enabled stays false until the user confirms a valid code via /totp/enable.
    await db.update(schema.users).set({ totpSecret: secret.base32, totpEnabled: false })
      .where(eq(schema.users.id, actor.userId));
    await writeActivity(db, {
      entityType: 'user', entityId: actor.userId, action: 'totp_setup',
      actorId: actor.userId, actorType: actor.actorType, diff: {},
    });
    return c.json({ secret: secret.base32, otpauthUrl: instance.toString() });
  });

  totp.post('/enable', async (c) => {
    const actor = currentActor(c);
    const body = totpCodeSchema.parse(await c.req.json());
    const { db } = getDb();
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, actor.userId));
    if (!user?.totpSecret) throw err.domain('TOTP is not set up');
    const instance = new OTPAuth.TOTP({ secret: user.totpSecret });
    if (instance.validate({ token: body.code, window: 1 }) === null) throw err.domain('Invalid code');
    await db.update(schema.users).set({ totpEnabled: true }).where(eq(schema.users.id, actor.userId));
    await writeActivity(db, {
      entityType: 'user', entityId: actor.userId, action: 'totp_enabled',
      actorId: actor.userId, actorType: actor.actorType, diff: {},
    });
    return c.json({ ok: true, enabled: true });
  });

  totp.post('/disable', async (c) => {
    const actor = currentActor(c);
    const body = totpCodeSchema.parse(await c.req.json());
    const { db } = getDb();
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, actor.userId));
    if (!user?.totpSecret) throw err.domain('TOTP is not set up');
    const instance = new OTPAuth.TOTP({ secret: user.totpSecret });
    if (instance.validate({ token: body.code, window: 1 }) === null) throw err.domain('Invalid code');
    await db.update(schema.users).set({ totpEnabled: false, totpSecret: null }).where(eq(schema.users.id, actor.userId));
    await writeActivity(db, {
      entityType: 'user', entityId: actor.userId, action: 'totp_disabled',
      actorId: actor.userId, actorType: actor.actorType, diff: {},
    });
    return c.json({ ok: true, enabled: false });
  });

  app.route('/totp', totp);

  // ── Desktop sign-in through the browser ────────────────────────────────────
  // The desktop app opens the browser, the signed-in user approves, and the
  // browser hands back a one-time code over the ordi:// deep link. The desktop
  // proves it started the flow with a verifier it never sent (PKCE), so another
  // local app that grabs the deep link cannot redeem the code.
  const desktop = new Hono<AppEnv>();

  /** What the browser shows on the approval screen. */
  desktop.get('/request', async (c) => {
    const state = c.req.query('state') ?? '';
    const { db } = getDb();
    const [row] = await db.select().from(schema.desktopAuthRequests)
      .where(eq(schema.desktopAuthRequests.state, state));
    if (!row || row.expiresAt < new Date()) throw err.notFound('This sign-in request expired');
    return c.json({ deviceLabel: row.deviceLabel, approved: !!row.approvedAt });
  });

  /** Called by the desktop app before it opens the browser. */
  desktop.post('/start', async (c) => {
    const body = z.object({
      state: z.string().min(16).max(128),
      codeChallenge: z.string().length(64),
      deviceLabel: z.string().max(120).default(''),
    }).parse(await c.req.json());

    const { db } = getDb();
    // Opportunistic cleanup – these rows are short-lived and never read again.
    await db.delete(schema.desktopAuthRequests)
      .where(sql`${schema.desktopAuthRequests.expiresAt} < now()`);
    await db.insert(schema.desktopAuthRequests).values({
      id: ulid(),
      state: body.state,
      codeChallenge: body.codeChallenge,
      deviceLabel: body.deviceLabel,
      expiresAt: new Date(Date.now() + 10 * 60_000),
    });
    return c.json({ ok: true });
  });

  /** The signed-in browser user approves the waiting desktop app. */
  desktop.post('/approve', requireAuth, async (c) => {
    const body = z.object({ state: z.string() }).parse(await c.req.json());
    const actor = currentActor(c);
    const { db } = getDb();
    const [row] = await db.select().from(schema.desktopAuthRequests)
      .where(eq(schema.desktopAuthRequests.state, body.state));
    if (!row || row.expiresAt < new Date()) throw err.notFound('This sign-in request expired');
    if (row.consumedAt) throw err.domain('This sign-in request was already used');

    const code = generateToken(32);
    await db.update(schema.desktopAuthRequests)
      .set({ userId: actor.userId, code, approvedAt: new Date() })
      .where(eq(schema.desktopAuthRequests.id, row.id));
    await writeActivity(db, {
      entityType: 'user', entityId: actor.userId!, action: 'desktop.authorize',
      actorId: actor.userId, actorType: actor.actorType, diff: { device: row.deviceLabel },
    });
    return c.json({ code });
  });

  /** The desktop app redeems the code with the verifier it kept. */
  desktop.post('/exchange', async (c) => {
    const ip = c.req.header('x-forwarded-for') ?? 'local';
    checkRate(`desktop-exchange:${ip}`, 20, 60_000);
    const body = z.object({
      code: z.string().min(16),
      verifier: z.string().min(32).max(200),
    }).parse(await c.req.json());

    const { db } = getDb();
    const [row] = await db.select().from(schema.desktopAuthRequests)
      .where(eq(schema.desktopAuthRequests.code, body.code));
    if (!row || !row.userId || !row.approvedAt) throw err.unauthenticated('Invalid sign-in code');
    if (row.consumedAt || row.expiresAt < new Date()) throw err.unauthenticated('Invalid sign-in code');
    if (sha256(body.verifier) !== row.codeChallenge) throw err.unauthenticated('Invalid sign-in code');

    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, row.userId));
    if (!user || !user.isActive) throw err.unauthenticated('Invalid sign-in code');

    const token = generateToken();
    await db.insert(schema.sessions).values({
      id: ulid(), userId: user.id, token,
      expiresAt: new Date(Date.now() + 30 * 24 * 3600_000),
      ipAddress: ip, userAgent: row.deviceLabel,
    });
    // Single use: burn the request rather than leaving a redeemable code around.
    await db.delete(schema.desktopAuthRequests).where(eq(schema.desktopAuthRequests.id, row.id));
    return c.json({ sessionToken: token, userId: user.id });
  });

  app.route('/desktop', desktop);
  return app;
}
