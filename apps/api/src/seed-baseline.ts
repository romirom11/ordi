/**
 * Baseline workspace configuration shared by the CLI seed (`pnpm seed`, dev demo)
 * and the first-run setup flow (POST /setup). This is the NON-demo config that any
 * fresh workspace needs: roles + permissions, workspace_settings, deal stages,
 * applicant stages, leave types, a default tax rate, and default task types.
 *
 * Everything here is idempotent (skips existing rows by natural key) so it is safe
 * to run repeatedly. Demo data (companies/deals/projects/tasks/extra users) lives
 * in seed.ts and is explicitly the DEV path only.
 */
import { getDb, schema, eq } from '@ordi/db';
import { ulid } from 'ulid';
import { ALL_ROLE_SEEDS, resolveRolePermissions } from '@ordi/shared';

type Db = ReturnType<typeof getDb>['db'];

/** Seed system + preset roles with their permission sets. Returns key → roleId. */
export async function seedRoles(db: Db): Promise<Map<string, string>> {
  const roleIds = new Map<string, string>();
  for (const seed of ALL_ROLE_SEEDS) {
    const [role] = await db.select().from(schema.roles).where(eq(schema.roles.key, seed.key));
    if (!role) {
      const id = ulid();
      await db.insert(schema.roles).values({ id, key: seed.key, name: seed.name, description: seed.description, isSystem: seed.isSystem });
      const perms = resolveRolePermissions(seed);
      if (perms.length) await db.insert(schema.rolePermissions).values(perms.map((p) => ({ roleId: id, permission: p })));
      roleIds.set(seed.key, id);
    } else {
      roleIds.set(seed.key, role.id);
    }
  }
  return roleIds;
}

/**
 * Seed baseline config idempotently. `workspaceName` sets the workspace_settings
 * name when the row is first created. Returns the role id map for the caller
 * (e.g. to create the owner user).
 */
export async function seedBaseline(db: Db, workspaceName = 'ordi'): Promise<{ roleIds: Map<string, string> }> {
  const roleIds = await seedRoles(db);

  // Workspace settings row
  const [ws] = await db.select().from(schema.workspaceSettings).where(eq(schema.workspaceSettings.id, 'workspace'));
  if (!ws) {
    await db.insert(schema.workspaceSettings).values({ id: 'workspace', name: workspaceName, defaultCurrency: 'USD' });
  }

  // Deal stages
  const existingStages = await db.select().from(schema.dealStages);
  if (!existingStages.length) {
    const stages = [
      { name: 'Lead', position: 0, probability: 10, isWon: false, isLost: false },
      { name: 'Qualified', position: 1, probability: 30, isWon: false, isLost: false },
      { name: 'Proposal', position: 2, probability: 60, isWon: false, isLost: false },
      { name: 'Won', position: 3, probability: 100, isWon: true, isLost: false },
      { name: 'Lost', position: 4, probability: 0, isWon: false, isLost: true },
    ];
    await db.insert(schema.dealStages).values(stages.map((s) => ({ id: ulid(), ...s })));
  }

  // Applicant stages
  const existingApp = await db.select().from(schema.applicantStages);
  if (!existingApp.length) {
    const stages = [
      { name: 'Applied', position: 0, isHired: false, isRejected: false },
      { name: 'Screening', position: 1, isHired: false, isRejected: false },
      { name: 'Interview', position: 2, isHired: false, isRejected: false },
      { name: 'Offer', position: 3, isHired: false, isRejected: false },
      { name: 'Hired', position: 4, isHired: true, isRejected: false },
      { name: 'Rejected', position: 5, isHired: false, isRejected: true },
    ];
    await db.insert(schema.applicantStages).values(stages.map((s) => ({ id: ulid(), ...s })));
  }

  // Leave types
  const existingLeave = await db.select().from(schema.leaveTypes);
  if (!existingLeave.length) {
    await db.insert(schema.leaveTypes).values([
      { id: ulid(), name: 'Annual leave', isPaid: true, needsApproval: true, affectsBalance: true, allowHalfDay: true, annualQuota: '20' },
      { id: ulid(), name: 'Sick leave', isPaid: true, needsApproval: false, affectsBalance: false, allowHalfDay: false, annualQuota: '0' },
      { id: ulid(), name: 'Unpaid', isPaid: false, needsApproval: true, affectsBalance: false, allowHalfDay: false, annualQuota: '0' },
    ]);
  }

  // Default tax rate
  const existingTax = await db.select().from(schema.taxRates);
  if (!existingTax.length) {
    await db.insert(schema.taxRates).values({ id: ulid(), name: 'VAT 20%', ratePercent: '20' });
  }

  // Default project types (also seeded idempotently by migration 0003 for existing DBs)
  const existingProjectTypes = await db.select().from(schema.projectTypes);
  if (!existingProjectTypes.length) {
    await db.insert(schema.projectTypes).values([
      { id: ulid(), name: 'Client work', icon: 'briefcase', color: '#6366f1', requiresClient: true, revenueSource: 'client_billing', isDefault: true, position: 0 },
      { id: ulid(), name: 'Internal', icon: 'wrench', color: '#64748b', requiresClient: false, revenueSource: 'none', isDefault: false, position: 1 },
      { id: ulid(), name: 'Product', icon: 'rocket', color: '#10b981', requiresClient: false, revenueSource: 'direct', isDefault: false, position: 2 },
    ]);
  }

  // Default (workspace-wide) task types
  const existingTypes = await db.select().from(schema.taskTypes);
  if (!existingTypes.length) {
    await db.insert(schema.taskTypes).values([
      { id: ulid(), projectId: null, name: 'Feature', icon: 'sparkles', color: '#6366f1', position: 0 },
      { id: ulid(), projectId: null, name: 'Bug', icon: 'bug', color: '#ef4444', position: 1 },
      { id: ulid(), projectId: null, name: 'Chore', icon: 'wrench', color: '#64748b', position: 2 },
    ]);
  }

  return { roleIds };
}
