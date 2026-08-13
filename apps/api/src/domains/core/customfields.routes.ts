import { Hono } from 'hono';
import { getDb, schema, eq, and, asc, isNull, or, sql } from '@ordi/db';
import { ulid } from 'ulid';
import { customFieldDefinitionSchema, CUSTOM_FIELD_ENTITIES } from '@ordi/shared';
import type { AppEnv, Actor } from '../../context';
import { requireAuth, currentActor } from '../../core/auth';
import { hasPerm } from '../../core/rbac';
import { assertProject } from '../../core/access';
import { invalidateRegistry } from '../../core/customfields';
import { writeActivity } from '../../core/activity';
import { err } from '../../lib/errors';

/**
 * Who may manage a definition: workspace-wide fields need settings.manage,
 * project-scoped fields are the project admin's to manage (that is where they
 * are configured – the project's settings tab).
 */
async function assertCanManage(actor: Actor, projectId: string | null | undefined): Promise<void> {
  if (projectId) {
    await assertProject(actor, projectId, 'admin');
    return;
  }
  if (!hasPerm(actor, 'settings.manage')) throw err.forbidden('Missing permission settings.manage', 'settings.manage');
}

export function customFieldsRoutes() {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth);

  // Read: any authenticated user can read definitions for entities they can see.
  // Without projectId only workspace-wide fields return; with projectId the
  // project's own fields are included. Explicit position/creation order – a
  // heap scan's order is not a contract.
  app.get('/', async (c) => {
    const entityType = c.req.query('entityType');
    const projectId = c.req.query('projectId');
    const { db } = getDb();
    const order = [asc(schema.customFieldDefinitions.position), asc(schema.customFieldDefinitions.createdAt)];
    const scope = projectId
      ? or(isNull(schema.customFieldDefinitions.projectId), eq(schema.customFieldDefinitions.projectId, projectId))
      : isNull(schema.customFieldDefinitions.projectId);
    const rows = await db.select().from(schema.customFieldDefinitions)
      .where(entityType ? and(eq(schema.customFieldDefinitions.entityType, entityType), scope) : scope)
      .orderBy(...order);
    return c.json({ data: rows });
  });

  app.post('/', async (c) => {
    const body = customFieldDefinitionSchema.parse(await c.req.json());
    if (!CUSTOM_FIELD_ENTITIES.includes(body.entityType)) throw err.validation('Unknown entity');
    const actor = currentActor(c);
    await assertCanManage(actor, body.projectId);
    const { db } = getDb();
    // A project field must not shadow a workspace field (both would render on
    // the same record under one JSONB key), and vice versa – so a global create
    // collides with any scope, a project create with global + its own project.
    const dup = await db.select().from(schema.customFieldDefinitions)
      .where(and(
        eq(schema.customFieldDefinitions.entityType, body.entityType),
        eq(schema.customFieldDefinitions.key, body.key),
        body.projectId
          ? or(isNull(schema.customFieldDefinitions.projectId), eq(schema.customFieldDefinitions.projectId, body.projectId))
          : undefined,
      ));
    if (dup.length) throw err.domain('Field key already exists for this entity');
    const id = ulid();
    await db.insert(schema.customFieldDefinitions).values({
      id, entityType: body.entityType, key: body.key, label: body.label, type: body.type,
      projectId: body.projectId ?? null,
      options: body.options ?? [], required: body.required, position: body.position,
      showInList: body.showInList, isSortable: body.isSortable, indexed: body.indexed,
      // Field groups are a workspace-level access mechanism – not applicable to project fields.
      groupId: body.projectId ? null : (body.groupId ?? null),
      icon: body.icon ?? null,
    });
    invalidateRegistry(body.entityType);
    if (body.indexed) await ensureExpressionIndex(body.entityType, body.key, body.type);
    await writeActivity(db, {
      entityType: 'custom_field', entityId: id, action: 'created',
      after: { entityType: body.entityType, key: body.key, label: body.label, type: body.type, projectId: body.projectId ?? null },
      actorId: actor.userId, actorType: actor.actorType,
    });
    return c.json({ id }, 201);
  });

  // Non-destructive edits only (PRD §5.5): label/options/order/flags. Key & type immutable.
  app.patch('/:id', async (c) => {
    const patch = await c.req.json();
    const { db } = getDb();
    const id = c.req.param('id');
    const [def] = await db.select().from(schema.customFieldDefinitions).where(eq(schema.customFieldDefinitions.id, id));
    if (!def) throw err.notFound();
    await assertCanManage(currentActor(c), def.projectId);
    await db.update(schema.customFieldDefinitions).set({
      ...(patch.label !== undefined ? { label: patch.label } : {}),
      ...(patch.options !== undefined ? { options: patch.options } : {}),
      ...(patch.required !== undefined ? { required: patch.required } : {}),
      ...(patch.position !== undefined ? { position: patch.position } : {}),
      ...(patch.showInList !== undefined ? { showInList: patch.showInList } : {}),
      ...(patch.isSortable !== undefined ? { isSortable: patch.isSortable } : {}),
      ...(patch.indexed !== undefined ? { indexed: patch.indexed } : {}),
      ...(patch.deprecated !== undefined ? { deprecated: patch.deprecated } : {}),
      ...(patch.groupId !== undefined ? { groupId: patch.groupId || null } : {}),
      ...(patch.icon !== undefined ? { icon: patch.icon || null } : {}),
    }).where(eq(schema.customFieldDefinitions.id, id));
    invalidateRegistry(def.entityType);
    if (patch.indexed === true) await ensureExpressionIndex(def.entityType, def.key, def.type as any);
    const actor = currentActor(c);
    await writeActivity(db, {
      entityType: 'custom_field', entityId: id, action: 'updated',
      actorId: actor.userId, actorType: actor.actorType,
    });
    return c.json({ ok: true });
  });

  app.delete('/:id', async (c) => {
    const { db } = getDb();
    const actor = currentActor(c);
    const id = c.req.param('id');
    const [def] = await db.select().from(schema.customFieldDefinitions).where(eq(schema.customFieldDefinitions.id, id));
    if (!def) throw err.notFound();
    await assertCanManage(actor, def.projectId);
    await db.delete(schema.customFieldDefinitions).where(eq(schema.customFieldDefinitions.id, id));
    invalidateRegistry(def.entityType);
    await writeActivity(db, {
      entityType: 'custom_field', entityId: id, action: 'deleted',
      actorId: actor.userId, actorType: actor.actorType,
    });
    return c.json({ ok: true });
  });

  return app;
}

/** Create a point B-tree expression index for a frequently-filtered field (PRD §5.5). */
async function ensureExpressionIndex(entityType: string, key: string, type: string): Promise<void> {
  const { db } = getDb();
  const cast = type === 'number' ? '::numeric' : type === 'date' ? '::date' : '';
  const idxName = `cf_${entityType}_${key}_idx`.replace(/[^a-z0-9_]/gi, '_');
  const expr = `((custom_fields->>'${key.replace(/'/g, "''")}')${cast})`;
  try {
    await db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS ${idxName} ON ${entityType} (${expr})`));
  } catch {
    // best-effort; migration worker handles CONCURRENTLY in production
  }
}
