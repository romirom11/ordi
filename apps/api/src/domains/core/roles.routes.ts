import { Hono } from 'hono';
import { getDb, schema, eq, sql, inArray } from '@ordi/db';
import { ulid } from 'ulid';
import { roleInputSchema, PERMISSION_META, PERMISSIONS, isPermission } from '@ordi/shared';
import type { AppEnv } from '../../context';
import { requireAuth, currentActor } from '../../core/auth';
import { guard } from '../../core/rbac';
import { invalidateRoleCache } from '../../core/rbac';
import { emit } from '../../core/events';
import { err } from '../../lib/errors';

export function rolesRoutes() {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth);

  // Catalog for the role editor UI (rendered from shared).
  app.get('/catalog', guard('roles.manage'), (c) =>
    c.json({ permissions: PERMISSIONS.map((p) => ({ key: p, ...PERMISSION_META[p] })) }));

  app.get('/', guard('roles.manage'), async (c) => {
    const { db } = getDb();
    const roles = await db.select().from(schema.roles);
    const perms = await db.select().from(schema.rolePermissions);
    const counts = await db.select({ roleId: schema.users.roleId, count: sql<number>`count(*)::int` })
      .from(schema.users).groupBy(schema.users.roleId);
    const countMap = new Map(counts.map((r) => [r.roleId, Number(r.count)]));
    return c.json({
      data: roles.map((r) => ({
        ...r,
        permissions: perms.filter((p) => p.roleId === r.id).map((p) => p.permission),
        userCount: countMap.get(r.id) ?? 0,
      })),
    });
  });

  app.post('/', guard('roles.manage'), async (c) => {
    const body = roleInputSchema.parse(await c.req.json());
    const { db } = getDb();
    const id = ulid();
    await db.insert(schema.roles).values({ id, key: `custom_${id}`, name: body.name, description: body.description });
    if (body.permissions.length) {
      await db.insert(schema.rolePermissions).values(body.permissions.map((p) => ({ roleId: id, permission: p })));
    }
    return c.json({ id }, 201);
  });

  app.patch('/:id', guard('roles.manage'), async (c) => {
    const body = roleInputSchema.parse(await c.req.json());
    const { db } = getDb();
    const id = c.req.param('id');
    const [role] = await db.select().from(schema.roles).where(eq(schema.roles.id, id));
    if (!role) throw err.notFound();
    if (role.isSystem) throw err.domain('System roles cannot be edited');
    for (const p of body.permissions) if (!isPermission(p)) throw err.validation(`Unknown permission ${p}`);
    await db.update(schema.roles).set({ name: body.name, description: body.description }).where(eq(schema.roles.id, id));
    await db.delete(schema.rolePermissions).where(eq(schema.rolePermissions.roleId, id));
    if (body.permissions.length) {
      await db.insert(schema.rolePermissions).values(body.permissions.map((p) => ({ roleId: id, permission: p })));
    }
    invalidateRoleCache(id);
    await emit({ type: 'role.updated', aggregateType: 'role', aggregateId: id, payload: {} });
    return c.json({ ok: true });
  });

  app.delete('/:id', guard('roles.manage'), async (c) => {
    const { db } = getDb();
    const id = c.req.param('id');
    const [role] = await db.select().from(schema.roles).where(eq(schema.roles.id, id));
    if (!role) throw err.notFound();
    if (role.isSystem) throw err.domain('System roles cannot be deleted');
    const countRows = await db.select({ count: sql<number>`count(*)::int` })
      .from(schema.users).where(eq(schema.users.roleId, id));
    if (Number(countRows[0]?.count ?? 0) > 0) throw err.domain('Role is assigned to users');
    await db.delete(schema.roles).where(eq(schema.roles.id, id));
    return c.json({ ok: true });
  });

  return app;
}
