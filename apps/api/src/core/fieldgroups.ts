/**
 * Field-group access (PRD §5.5 extension). Custom fields can belong to a named
 * group, and a group is an access boundary: roles are granted read/write per
 * group in the RBAC editor, and dynamic principals cover relations a role
 * cannot express – today 'self', the person an employee record is about.
 *
 * The rules, deliberately few:
 *   - ungrouped fields keep the entity's default visibility (status quo);
 *   - roles with people.write (HR) implicitly hold write on every employees
 *     group – HR manages this data, grants exist to open it up to others;
 *   - otherwise access is the union of the actor's role grant and, when the
 *     record is their own, the 'self' grant.
 *
 * Enforcement lives server-side: reads strip values of unreadable groups,
 * the self-service endpoints accept only self-writable keys.
 */
import { getDb, schema, asc } from '@ordi/db';
import type { Actor } from '../context';

export type GroupLevel = 'read' | 'write';

export interface FieldGroupRow {
  id: string;
  entityType: string;
  name: string;
  position: number;
}

interface GrantRow { groupId: string; principal: string; level: string }

/** Per-process cache, same idiom as the custom-field registry. */
let cache: { groups: FieldGroupRow[]; grants: GrantRow[] } | null = null;

export function invalidateFieldGroups(): void {
  cache = null;
}

export async function loadFieldGroups(): Promise<{ groups: FieldGroupRow[]; grants: GrantRow[] }> {
  if (cache) return cache;
  const { db } = getDb();
  const groups = await db.select({
    id: schema.customFieldGroups.id,
    entityType: schema.customFieldGroups.entityType,
    name: schema.customFieldGroups.name,
    position: schema.customFieldGroups.position,
  }).from(schema.customFieldGroups).orderBy(asc(schema.customFieldGroups.position), asc(schema.customFieldGroups.name));
  const grants = await db.select({
    groupId: schema.customFieldGroupGrants.groupId,
    principal: schema.customFieldGroupGrants.principal,
    level: schema.customFieldGroupGrants.level,
  }).from(schema.customFieldGroupGrants);
  cache = { groups, grants };
  return cache;
}

export interface FieldGroupAccess {
  /** groupId → level. A group absent here is invisible to the actor. */
  levels: Map<string, GroupLevel>;
  /** HR shortcut: people.write holds write on everything. */
  full: boolean;
}

/** Access to the employees field groups for one actor looking at one record. */
export async function employeeFieldAccess(
  actor: Actor,
  employee: { userId?: string | null },
): Promise<FieldGroupAccess> {
  const { groups, grants } = await loadFieldGroups();
  const levels = new Map<string, GroupLevel>();
  const full = actor.access.permissions.has('people.write');
  const isSelf = employee.userId != null && employee.userId === actor.userId;
  for (const g of groups) {
    if (g.entityType !== 'employees') continue;
    if (full) { levels.set(g.id, 'write'); continue; }
    let level: GroupLevel | null = null;
    for (const gr of grants) {
      if (gr.groupId !== g.id) continue;
      const applies = gr.principal === `role:${actor.roleId}` || (gr.principal === 'self' && isSelf);
      if (!applies) continue;
      if (gr.level === 'write') level = 'write';
      else if (level == null) level = 'read';
    }
    if (level) levels.set(g.id, level);
  }
  return { levels, full };
}

/** groupId → level granted to 'self' – the groups that make up the questionnaire. */
export async function selfGrantLevels(): Promise<Map<string, GroupLevel>> {
  const { grants } = await loadFieldGroups();
  const map = new Map<string, GroupLevel>();
  for (const gr of grants) {
    if (gr.principal !== 'self') continue;
    if (gr.level === 'write') map.set(gr.groupId, 'write');
    else if (!map.has(gr.groupId)) map.set(gr.groupId, 'read');
  }
  return map;
}

interface DefLite { key: string; groupId: string | null }

/**
 * Strip the values an actor may not read from an employee's customFields blob.
 * Ungrouped fields (groupId null) pass through; unknown keys are inert and kept.
 */
export function stripGroupedValues(
  customFields: unknown,
  defs: DefLite[],
  access: FieldGroupAccess,
): Record<string, unknown> {
  const values = (customFields && typeof customFields === 'object' && !Array.isArray(customFields)
    ? { ...(customFields as Record<string, unknown>) }
    : {});
  if (access.full) return values;
  for (const def of defs) {
    if (!def.groupId) continue;
    if (!access.levels.has(def.groupId)) delete values[def.key];
  }
  return values;
}
