import { Hono } from 'hono';
import { getDb, schema, eq, and, sql } from '@ordi/db';
import { ulid } from 'ulid';
import { customFieldDefinitionSchema, CUSTOM_FIELD_ENTITIES } from '@ordi/shared';
import type { AppEnv } from '../../context';
import { requireAuth, currentActor } from '../../core/auth';
import { guard } from '../../core/rbac';
import { invalidateRegistry } from '../../core/customfields';
import { writeActivity } from '../../core/activity';
import { err } from '../../lib/errors';

export function customFieldsRoutes() {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth);

  // Read: any authenticated user can read definitions for entities they can see.
  app.get('/', async (c) => {
    const entityType = c.req.query('entityType');
    const { db } = getDb();
    const rows = entityType
      ? await db.select().from(schema.customFieldDefinitions).where(eq(schema.customFieldDefinitions.entityType, entityType))
      : await db.select().from(schema.customFieldDefinitions);
    return c.json({ data: rows });
  });

  app.post('/', guard('settings.manage'), async (c) => {
    const body = customFieldDefinitionSchema.parse(await c.req.json());
    if (!CUSTOM_FIELD_ENTITIES.includes(body.entityType)) throw err.validation('Unknown entity');
    const { db } = getDb();
    const dup = await db.select().from(schema.customFieldDefinitions)
      .where(and(eq(schema.customFieldDefinitions.entityType, body.entityType), eq(schema.customFieldDefinitions.key, body.key)));
    if (dup.length) throw err.domain('Field key already exists for this entity');
    const id = ulid();
    await db.insert(schema.customFieldDefinitions).values({
      id, entityType: body.entityType, key: body.key, label: body.label, type: body.type,
      options: body.options ?? [], required: body.required, position: body.position,
      showInList: body.showInList, isSortable: body.isSortable, indexed: body.indexed,
    });
    invalidateRegistry(body.entityType);
    if (body.indexed) await ensureExpressionIndex(body.entityType, body.key, body.type);
    const actor = currentActor(c);
    await writeActivity(db, {
      entityType: 'custom_field', entityId: id, action: 'created',
      after: { entityType: body.entityType, key: body.key, label: body.label, type: body.type },
      actorId: actor.userId, actorType: actor.actorType,
    });
    return c.json({ id }, 201);
  });

  // Non-destructive edits only (PRD §5.5): label/options/order/flags. Key & type immutable.
  app.patch('/:id', guard('settings.manage'), async (c) => {
    const patch = await c.req.json();
    const { db } = getDb();
    const id = c.req.param('id');
    const [def] = await db.select().from(schema.customFieldDefinitions).where(eq(schema.customFieldDefinitions.id, id));
    if (!def) throw err.notFound();
    await db.update(schema.customFieldDefinitions).set({
      ...(patch.label !== undefined ? { label: patch.label } : {}),
      ...(patch.options !== undefined ? { options: patch.options } : {}),
      ...(patch.required !== undefined ? { required: patch.required } : {}),
      ...(patch.position !== undefined ? { position: patch.position } : {}),
      ...(patch.showInList !== undefined ? { showInList: patch.showInList } : {}),
      ...(patch.isSortable !== undefined ? { isSortable: patch.isSortable } : {}),
      ...(patch.indexed !== undefined ? { indexed: patch.indexed } : {}),
      ...(patch.deprecated !== undefined ? { deprecated: patch.deprecated } : {}),
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

  app.delete('/:id', guard('settings.manage'), async (c) => {
    const { db } = getDb();
    const actor = currentActor(c);
    await db.delete(schema.customFieldDefinitions).where(eq(schema.customFieldDefinitions.id, c.req.param('id')));
    await writeActivity(db, {
      entityType: 'custom_field', entityId: c.req.param('id'), action: 'deleted',
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
