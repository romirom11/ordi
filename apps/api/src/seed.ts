/**
 * Seed: roles + permissions catalog, an Owner user, workspace defaults and a set
 * of demo data so the app is immediately usable (PRD §20 "сід демо-даних").
 * Idempotent: re-running skips existing rows by natural keys.
 */
import { getDb, schema, eq, runMigrations } from '@ordi/db';
import { ulid } from 'ulid';
import { ALL_ROLE_SEEDS, resolveRolePermissions } from '@ordi/shared';
import { hashPassword } from './lib/crypto';

async function seedRoles(): Promise<Map<string, string>> {
  const { db } = getDb();
  const roleIds = new Map<string, string>();
  for (const seed of ALL_ROLE_SEEDS) {
    let [role] = await db.select().from(schema.roles).where(eq(schema.roles.key, seed.key));
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

async function main() {
  const { db, close } = getDb();
  const ownerEmail = (process.env.SEED_OWNER_EMAIL ?? 'owner@ordi.local').toLowerCase();
  const ownerPassword = process.env.SEED_OWNER_PASSWORD ?? 'password123';

  const roleIds = await seedRoles();

  // Workspace settings
  const [ws] = await db.select().from(schema.workspaceSettings).where(eq(schema.workspaceSettings.id, 'workspace'));
  if (!ws) await db.insert(schema.workspaceSettings).values({ id: 'workspace', name: 'Acme Agency', defaultCurrency: 'USD' });

  // Owner + agent service user
  let [owner] = await db.select().from(schema.users).where(eq(schema.users.email, ownerEmail));
  if (!owner) {
    const id = ulid();
    await db.insert(schema.users).values({
      id, email: ownerEmail, name: 'Agency Owner', passwordHash: hashPassword(ownerPassword),
      roleId: roleIds.get('owner')!,
    });
    [owner] = await db.select().from(schema.users).where(eq(schema.users.id, id));
    // eslint-disable-next-line no-console
    console.log(`✓ owner: ${ownerEmail} / ${ownerPassword}`);
  }
  const ownerId = owner!.id;

  const [agentUser] = await db.select().from(schema.users).where(eq(schema.users.email, 'agent@ordi.local'));
  if (!agentUser) {
    await db.insert(schema.users).values({
      id: ulid(), email: 'agent@ordi.local', name: 'Agent', roleId: roleIds.get('manager')!, actorType: 'agent',
    });
  }

  // Extra demo members
  const memberEmail = 'member@ordi.local';
  let [member] = await db.select().from(schema.users).where(eq(schema.users.email, memberEmail));
  if (!member) {
    const id = ulid();
    await db.insert(schema.users).values({ id, email: memberEmail, name: 'Dev Member', passwordHash: hashPassword('password123'), roleId: roleIds.get('member')! });
    [member] = await db.select().from(schema.users).where(eq(schema.users.id, id));
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

  // Tax rate
  const existingTax = await db.select().from(schema.taxRates);
  if (!existingTax.length) {
    await db.insert(schema.taxRates).values({ id: ulid(), name: 'VAT 20%', ratePercent: '20' });
  }

  // Demo company + contact + deal
  let [company] = await db.select().from(schema.companies).where(eq(schema.companies.name, 'Globex Corp'));
  if (!company) {
    const id = ulid();
    await db.insert(schema.companies).values({
      id, name: 'Globex Corp', domain: 'globex.com', status: 'active', ownerId,
      billingEmail: 'ap@globex.com', defaultCurrency: 'USD', portalToken: ulid(), portalEnabled: true, createdBy: ownerId,
    });
    [company] = await db.select().from(schema.companies).where(eq(schema.companies.id, id));
    await db.insert(schema.contacts).values({ id: ulid(), companyId: id, firstName: 'Jane', lastName: 'Doe', email: 'jane@globex.com', isPrimary: true, createdBy: ownerId });
    const [leadStage] = await db.select().from(schema.dealStages).where(eq(schema.dealStages.name, 'Proposal'));
    await db.insert(schema.deals).values({ id: ulid(), companyId: id, title: 'Website redesign', stageId: leadStage!.id, amount: '15000', currency: 'USD', ownerId, createdBy: ownerId });
  }

  // Demo projects (client + internal)
  let [project] = await db.select().from(schema.projects).where(eq(schema.projects.key, 'GLX'));
  if (!project) {
    const id = ulid();
    await db.insert(schema.projects).values({
      id, companyId: company!.id, kind: 'client', name: 'Globex Website', key: 'GLX', status: 'active',
      visibility: 'workspace', leadId: ownerId, createdBy: ownerId, settings: { estimateUnit: 'hours' },
    });
    await db.insert(schema.projectMembers).values([
      { projectId: id, userId: ownerId, role: 'admin', canWriteTasks: true },
      { projectId: id, userId: member!.id, role: 'member', canWriteTasks: true },
    ]);
    const statuses = [
      { name: 'Backlog', category: 'backlog', position: 0, isDefault: false, color: '#94a3b8' },
      { name: 'Todo', category: 'todo', position: 1, isDefault: true, color: '#64748b' },
      { name: 'In Progress', category: 'in_progress', position: 2, isDefault: false, color: '#3b82f6' },
      { name: 'In Review', category: 'in_progress', position: 3, isDefault: false, color: '#a855f7' },
      { name: 'Done', category: 'done', position: 4, isDefault: false, color: '#22c55e' },
      { name: 'Canceled', category: 'canceled', position: 5, isDefault: false, color: '#ef4444' },
    ];
    const statusRows = statuses.map((s) => ({ id: ulid(), projectId: id, ...s }));
    await db.insert(schema.taskStatuses).values(statusRows);
    const todo = statusRows.find((s) => s.isDefault)!;
    const inprog = statusRows.find((s) => s.name === 'In Progress')!;
    await db.insert(schema.intakeSettings).values({ projectId: id, formToken: ulid(), formEnabled: true });
    // Tasks (number assigned by trigger)
    for (const [i, t] of [
      { title: 'Design homepage', statusId: inprog.id, priority: 'high', estimate: '8' },
      { title: 'Set up CI/CD', statusId: todo.id, priority: 'medium', estimate: '4' },
      { title: 'Content migration', statusId: todo.id, priority: 'low', estimate: '12' },
    ].entries()) {
      const taskId = ulid();
      await db.insert(schema.tasks).values({ id: taskId, projectId: id, number: 0, title: t.title, statusId: t.statusId, priority: t.priority as any, estimate: t.estimate, position: String((i + 1) * 1000), createdBy: ownerId });
      await db.insert(schema.taskAssignees).values({ taskId, userId: i === 0 ? ownerId : member!.id });
    }
    [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, id));
  }

  // Internal project (operations inbox)
  const [internal] = await db.select().from(schema.projects).where(eq(schema.projects.key, 'OPS'));
  if (!internal) {
    const id = ulid();
    await db.insert(schema.projects).values({ id, kind: 'internal', name: 'Operations', key: 'OPS', status: 'active', visibility: 'workspace', leadId: ownerId, createdBy: ownerId });
    await db.insert(schema.projectMembers).values({ projectId: id, userId: ownerId, role: 'admin', canWriteTasks: true });
    await db.insert(schema.taskStatuses).values([
      { id: ulid(), projectId: id, name: 'Todo', category: 'todo', position: 0, isDefault: true, color: '#64748b' },
      { id: ulid(), projectId: id, name: 'Done', category: 'done', position: 1, isDefault: false, color: '#22c55e' },
    ]);
  }

  // KB space + page for the project
  const [space] = await db.select().from(schema.kbSpaces).where(eq(schema.kbSpaces.name, 'Agency Processes'));
  if (!space) {
    const id = ulid();
    await db.insert(schema.kbSpaces).values({ id, name: 'Agency Processes', visibility: 'workspace' });
    const pageId = ulid();
    await db.insert(schema.kbPages).values({
      id: pageId, spaceId: id, title: 'Onboarding a new client', published: true, visibility: 'public',
      body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Welcome to the agency knowledge base.' }] }] },
      createdBy: ownerId,
    });
    await db.insert(schema.kbPageVersions).values({ id: ulid(), pageId, title: 'Onboarding a new client', body: {}, versionNo: 1, authorId: ownerId });
  }

  // Departments + a leave type balance for demo employee
  const [dept] = await db.select().from(schema.departments).where(eq(schema.departments.name, 'Engineering'));
  if (!dept) {
    const deptId = ulid();
    await db.insert(schema.departments).values({ id: deptId, name: 'Engineering' });
    const posId = ulid();
    await db.insert(schema.positions).values({ id: posId, title: 'Software Engineer' });
    await db.insert(schema.employees).values({
      id: ulid(), userId: member!.id, firstName: 'Dev', lastName: 'Member', email: memberEmail,
      positionId: posId, departmentId: deptId, employmentType: 'full_time', status: 'active', joinDate: '2024-01-15', createdBy: ownerId,
    });
  }

  // eslint-disable-next-line no-console
  console.log('✓ seed complete');
  await close();
}

if (process.env.SEED_WITH_MIGRATE === 'true') {
  runMigrations().then(main).catch((e) => { console.error(e); process.exit(1); });
} else {
  main().catch((e) => { console.error(e); process.exit(1); });
}
