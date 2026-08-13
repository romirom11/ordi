/**
 * Field groups (PRD §5.5 extension): named access boundaries over custom
 * fields. Groups are managed next to the field definitions (settings.manage);
 * their access grants are RBAC configuration (roles.manage) – a matrix of
 * roles plus dynamic principals such as 'self'.
 */
import { Hono } from 'hono';
import { getDb, schema, eq } from '@ordi/db';
import { ulid } from 'ulid';
import { fieldGroupInputSchema, fieldGroupGrantsSchema, CUSTOM_FIELD_ENTITIES } from '@ordi/shared';
import type { AppEnv } from '../../context';
import { requireAuth, currentActor } from '../../core/auth';
import { guard } from '../../core/rbac';
import { invalidateFieldGroups, loadFieldGroups } from '../../core/fieldgroups';
import { writeActivity } from '../../core/activity';
import { err } from '../../lib/errors';

export function fieldGroupsRoutes() {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth);

  // Names are needed to render grouped fields anywhere records show – readable to any authed user.
  app.get('/', async (c) => {
    const entityType = c.req.query('entityType');
    const { groups } = await loadFieldGroups();
    return c.json({ data: entityType ? groups.filter((g) => g.entityType === entityType) : groups });
  });

  app.post('/', guard('settings.manage'), async (c) => {
    const body = fieldGroupInputSchema.parse(await c.req.json());
    if (!CUSTOM_FIELD_ENTITIES.includes(body.entityType)) throw err.validation('Unknown entity');
    const { db } = getDb();
    const id = ulid();
    await db.insert(schema.customFieldGroups).values({
      id, entityType: body.entityType, name: body.name, position: body.position,
    });
    invalidateFieldGroups();
    const actor = currentActor(c);
    await writeActivity(db, {
      entityType: 'custom_field_group', entityId: id, action: 'created',
      after: { entityType: body.entityType, name: body.name },
      actorId: actor.userId, actorType: actor.actorType,
    });
    return c.json({ id }, 201);
  });

  app.patch('/:id', guard('settings.manage'), async (c) => {
    const patch = await c.req.json();
    const { db } = getDb();
    const id = c.req.param('id');
    const [group] = await db.select().from(schema.customFieldGroups).where(eq(schema.customFieldGroups.id, id));
    if (!group) throw err.notFound();
    await db.update(schema.customFieldGroups).set({
      ...(typeof patch.name === 'string' && patch.name.trim() ? { name: patch.name.trim() } : {}),
      ...(typeof patch.position === 'number' ? { position: patch.position } : {}),
    }).where(eq(schema.customFieldGroups.id, id));
    invalidateFieldGroups();
    const actor = currentActor(c);
    await writeActivity(db, {
      entityType: 'custom_field_group', entityId: id, action: 'updated',
      actorId: actor.userId, actorType: actor.actorType,
    });
    return c.json({ ok: true });
  });

  // Fields of a deleted group fall back to ungrouped (FK set null) – nothing is lost.
  app.delete('/:id', guard('settings.manage'), async (c) => {
    const { db } = getDb();
    const id = c.req.param('id');
    await db.delete(schema.customFieldGroups).where(eq(schema.customFieldGroups.id, id));
    invalidateFieldGroups();
    const actor = currentActor(c);
    await writeActivity(db, {
      entityType: 'custom_field_group', entityId: id, action: 'deleted',
      actorId: actor.userId, actorType: actor.actorType,
    });
    return c.json({ ok: true });
  });

  app.get('/:id/grants', guard('roles.manage'), async (c) => {
    const id = c.req.param('id');
    const { grants } = await loadFieldGroups();
    return c.json({ data: grants.filter((g) => g.groupId === id).map(({ principal, level }) => ({ principal, level })) });
  });

  /** Replace the group's grant set wholesale – the matrix saves its full row. */
  app.put('/:id/grants', guard('roles.manage'), async (c) => {
    const body = fieldGroupGrantsSchema.parse(await c.req.json());
    const { db } = getDb();
    const id = c.req.param('id');
    const [group] = await db.select().from(schema.customFieldGroups).where(eq(schema.customFieldGroups.id, id));
    if (!group) throw err.notFound();
    // One level per principal – the schema's array may not repeat a principal.
    const seen = new Set<string>();
    for (const g of body.grants) {
      if (seen.has(g.principal)) throw err.validation(`Duplicate principal '${g.principal}'`);
      seen.add(g.principal);
    }
    await db.transaction(async (tx) => {
      await tx.delete(schema.customFieldGroupGrants).where(eq(schema.customFieldGroupGrants.groupId, id));
      if (body.grants.length) {
        await tx.insert(schema.customFieldGroupGrants).values(
          body.grants.map((g) => ({ groupId: id, principal: g.principal, level: g.level })),
        );
      }
    });
    invalidateFieldGroups();
    const actor = currentActor(c);
    await writeActivity(db, {
      entityType: 'custom_field_group', entityId: id, action: 'grants_updated',
      after: { grants: body.grants },
      actorId: actor.userId, actorType: actor.actorType,
    });
    return c.json({ ok: true });
  });

  return app;
}
