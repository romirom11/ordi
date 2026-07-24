/**
 * Seed (DEV): baseline config (shared with first-run /setup) PLUS a set of demo
 * data – companies, deals, projects, tasks and extra users – so the app is
 * immediately usable for local development (PRD §20 "сід демо-даних"). The
 * baseline-only part lives in seed-baseline.ts and is what production first-run
 * setup uses; everything below the baseline call here is the DEV-only demo path.
 * Idempotent: re-running skips existing rows by natural keys.
 */
import { getDb, schema, eq, runMigrations } from '@ordi/db';
import { ulid } from 'ulid';
import { hashPassword } from './lib/crypto';
import { seedBaseline } from './seed-baseline';

async function main() {
  const { db, close } = getDb();
  const ownerEmail = (process.env.SEED_OWNER_EMAIL ?? 'owner@ordi.local').toLowerCase();
  const ownerPassword = process.env.SEED_OWNER_PASSWORD ?? 'password123';

  // ── Baseline config (roles, workspace settings, stages, leave types, tax, task types) ──
  const { roleIds } = await seedBaseline(db, 'Acme Agency');

  // ─────────────────────────────────────────────────────────────────────────
  // DEV-ONLY DEMO DATA below: owner + extra users, companies, deals, projects,
  // tasks, KB, departments. Not created by production first-run setup.
  // ─────────────────────────────────────────────────────────────────────────

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

  // Demo projects (client work + internal) referencing the baseline project types
  const [clientType] = await db.select().from(schema.projectTypes).where(eq(schema.projectTypes.name, 'Client work'));
  const [internalType] = await db.select().from(schema.projectTypes).where(eq(schema.projectTypes.name, 'Internal'));
  let [project] = await db.select().from(schema.projects).where(eq(schema.projects.key, 'GLX'));
  if (!project) {
    const id = ulid();
    await db.insert(schema.projects).values({
      id, companyId: company!.id, projectTypeId: clientType!.id, name: 'Globex Website', key: 'GLX', status: 'active',
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
    await db.insert(schema.projects).values({ id, projectTypeId: internalType!.id, name: 'Operations', key: 'OPS', status: 'active', visibility: 'workspace', leadId: ownerId, createdBy: ownerId });
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
