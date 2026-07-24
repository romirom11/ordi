import { Hono } from 'hono';
import { getDb, schema, eq, sql } from '@ordi/db';
import { ulid } from 'ulid';
import { inviteUserSchema, changeRoleSchema } from '@ordi/shared';
import type { AppEnv } from '../../context';
import { requireAuth, currentActor } from '../../core/auth';
import { guard } from '../../core/rbac';
import { generateToken } from '../../lib/crypto';
import { err } from '../../lib/errors';
import { writeActivity } from '../../core/activity';
import { queueEmail } from '../../lib/email';
import { env } from '../../env';

export function usersRoutes() {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth);

  app.get('/', guard('users.manage'), async (c) => {
    const { db } = getDb();
    const rows = await db.select({
      id: schema.users.id, email: schema.users.email, name: schema.users.name,
      roleId: schema.users.roleId, isActive: schema.users.isActive, avatar: schema.users.avatar,
      actorType: schema.users.actorType, createdAt: schema.users.createdAt,
    }).from(schema.users);
    return c.json({ data: rows });
  });

  // Lightweight directory for assignee pickers and @mentions: any authenticated
  // user; only public fields (id, name, avatar) — no emails or role data.
  app.get('/lookup', async (c) => {
    const { db } = getDb();
    const rows = await db.select({
      id: schema.users.id, name: schema.users.name, avatar: schema.users.avatar,
    }).from(schema.users).where(eq(schema.users.isActive, true));
    return c.json({ data: rows });
  });

  app.post('/invite', guard('users.manage'), async (c) => {
    const actor = currentActor(c);
    const body = inviteUserSchema.parse(await c.req.json());
    const { db } = getDb();
    const [role] = await db.select().from(schema.roles).where(eq(schema.roles.id, body.roleId));
    if (!role) throw err.validation('Unknown role');
    const token = generateToken();
    const id = ulid();
    await db.insert(schema.invites).values({
      id, email: body.email.toLowerCase(), name: body.name, roleId: body.roleId, token,
      expiresAt: new Date(Date.now() + 7 * 24 * 3600_000), createdBy: actor.userId,
    });
    await queueEmail({
      to: body.email,
      subject: 'You have been invited to ordi',
      body: `Accept your invite: ${env.appUrl}/accept-invite?token=${token}`,
    });
    return c.json({ id, inviteUrl: `${env.appUrl}/accept-invite?token=${token}` }, 201);
  });

  app.patch('/:id/role', guard('users.manage'), async (c) => {
    const actor = currentActor(c);
    const body = changeRoleSchema.parse(await c.req.json());
    const { db } = getDb();
    const id = c.req.param('id');
    const [target] = await db.select().from(schema.users).where(eq(schema.users.id, id));
    if (!target) throw err.notFound();
    // Cannot demote the last Owner (PRD §4.3).
    await ensureNotLastOwner(target, body.roleId);
    await db.update(schema.users).set({ roleId: body.roleId }).where(eq(schema.users.id, id));
    await writeActivity(db, {
      entityType: 'user', entityId: id, action: 'role_changed',
      before: { roleId: target.roleId }, after: { roleId: body.roleId },
      actorId: actor.userId, actorType: actor.actorType,
    });
    return c.json({ ok: true });
  });

  app.post('/:id/deactivate', guard('users.manage'), async (c) => {
    const actor = currentActor(c);
    const { db } = getDb();
    const id = c.req.param('id');
    const [target] = await db.select().from(schema.users).where(eq(schema.users.id, id));
    if (!target) throw err.notFound();
    await ensureNotLastOwner(target, null);
    await db.update(schema.users).set({ isActive: false }).where(eq(schema.users.id, id));
    await db.delete(schema.sessions).where(eq(schema.sessions.userId, id));
    await db.update(schema.apiTokens).set({ revokedAt: new Date() }).where(eq(schema.apiTokens.userId, id));
    await writeActivity(db, {
      entityType: 'user', entityId: id, action: 'deactivated',
      actorId: actor.userId, actorType: actor.actorType,
    });
    return c.json({ ok: true });
  });

  app.post('/:id/reactivate', guard('users.manage'), async (c) => {
    const { db } = getDb();
    await db.update(schema.users).set({ isActive: true }).where(eq(schema.users.id, c.req.param('id')));
    return c.json({ ok: true });
  });

  return app;
}

async function ensureNotLastOwner(target: { roleId: string }, newRoleId: string | null): Promise<void> {
  const { db } = getDb();
  const [ownerRole] = await db.select().from(schema.roles).where(eq(schema.roles.key, 'owner'));
  if (!ownerRole || target.roleId !== ownerRole.id) return;
  if (newRoleId === ownerRole.id) return;
  const rows = await db.select({ count: sql<number>`count(*)::int` })
    .from(schema.users).where(eq(schema.users.roleId, ownerRole.id));
  if (Number(rows[0]?.count ?? 0) <= 1) throw err.domain('Cannot remove the last Owner');
}
