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
import { postInvoiceSent, postPayment } from './domains/finance/ledger.service';

/** A date `offset` days from today as YYYY-MM-DD, so demo data always looks current. */
function day(offset: number): string {
  return at(offset).toISOString().slice(0, 10);
}

/** Same, as a timestamp – used to backdate rows and their activity history. */
function at(offset: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  d.setHours(11, 0, 0, 0);
  return d;
}

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

    const backlog = statusRows.find((s) => s.name === 'Backlog')!;
    const review = statusRows.find((s) => s.name === 'In Review')!;
    const done = statusRows.find((s) => s.name === 'Done')!;

    // Labels, so the board shows the same colour coding a real workspace has.
    // Task labels describe work; project labels describe the engagement – two
    // vocabularies, hence two scopes.
    const labelRows = [
      { id: ulid(), name: 'Design', color: '#a855f7', scope: 'task' },
      { id: ulid(), name: 'Frontend', color: '#3b82f6', scope: 'task' },
      { id: ulid(), name: 'Backend', color: '#14b8a6', scope: 'task' },
      { id: ulid(), name: 'Bug', color: '#ef4444', scope: 'task' },
      { id: ulid(), name: 'Content', color: '#eab308', scope: 'task' },
    ];
    const projectLabelRows = [
      { id: ulid(), name: 'Client work', color: '#6366f1', scope: 'project' },
      { id: ulid(), name: 'Retainer', color: '#10b981', scope: 'project' },
    ];
    await db.insert(schema.labels).values([...labelRows, ...projectLabelRows]);
    await db.insert(schema.projectLabels).values(projectLabelRows.map((l) => ({ projectId: id, labelId: l.id })));
    const label = (name: string) => labelRows.find((l) => l.name === name)!.id;

    // A cycle in flight, so Cycles and the burndown are not empty.
    const cycleId = ulid();
    await db.insert(schema.cycles).values({
      id: cycleId, projectId: id, name: 'Sprint 4',
      startDate: day(-6), endDate: day(8), status: 'active',
      goal: 'Ship the new homepage and pricing page to staging.',
    });

    // Tasks across every column with assignees, labels, estimates and due dates
    // (numbers are assigned by a trigger).
    // `born`/`started`/`finished` are day offsets: they backdate the rows and the
    // status transitions so the burn-up chart on the overview has real history.
    const demoTasks = [
      { title: 'Design the new homepage', status: review.id, priority: 'high', estimate: '8', labels: ['Design'], who: [ownerId], due: day(2), cycle: true, born: -18, started: -9, finished: null,
        body: 'Hero, social proof and pricing above the fold. Desktop first, mobile after sign-off.' },
      { title: 'Build the pricing page', status: inprog.id, priority: 'high', estimate: '13', labels: ['Frontend', 'Design'], who: [member!.id], due: day(4), cycle: true, born: -16, started: -5, finished: null,
        body: 'Three tiers with a monthly/annual toggle. Reuse the marketing card component.' },
      { title: 'Checkout returns 500 on expired cards', status: inprog.id, priority: 'urgent', estimate: '3', labels: ['Bug', 'Backend'], who: [member!.id], due: day(1), cycle: true, born: -4, started: -2, finished: null,
        body: 'Reproduced with a test card. The payment provider error is not mapped, so it surfaces as a 500.' },
      { title: 'Set up CI/CD', status: todo.id, priority: 'medium', estimate: '4', labels: ['Backend'], who: [ownerId], due: day(9), cycle: true, born: -14, started: null, finished: null, body: '' },
      { title: 'Content migration from the old CMS', status: todo.id, priority: 'low', estimate: '12', labels: ['Content'], who: [member!.id], due: day(14), cycle: false, born: -12, started: null, finished: null, body: '' },
      { title: 'Accessibility pass on forms', status: backlog.id, priority: 'medium', estimate: '5', labels: ['Frontend'], who: [], due: null, cycle: false, born: -7, started: null, finished: null, body: '' },
      { title: 'Analytics and conversion tracking', status: backlog.id, priority: 'low', estimate: '3', labels: ['Frontend'], who: [], due: null, cycle: false, born: -3, started: null, finished: null, body: '' },
      { title: 'Brand guidelines handover', status: done.id, priority: 'medium', estimate: '2', labels: ['Design'], who: [ownerId], due: day(-3), cycle: true, born: -21, started: -15, finished: -4, body: '' },
      { title: 'Kick-off workshop with Globex', status: done.id, priority: 'high', estimate: '4', labels: [], who: [ownerId, member!.id], due: day(-8), cycle: true, born: -21, started: -19, finished: -9, body: '' },
    ];
    for (const [i, t] of demoTasks.entries()) {
      const taskId = ulid();
      await db.insert(schema.tasks).values({
        id: taskId, projectId: id, number: 0, title: t.title, statusId: t.status,
        priority: t.priority as never, estimate: t.estimate, dueDate: t.due,
        cycleId: t.cycle ? cycleId : null, position: String((i + 1) * 1000), createdBy: ownerId,
        createdAt: at(t.born),
        description: t.body ? { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: t.body }] }] } : null,
      });
      if (t.who.length) await db.insert(schema.taskAssignees).values(t.who.map((userId) => ({ taskId, userId })));
      if (t.labels.length) await db.insert(schema.taskLabels).values(t.labels.map((n) => ({ taskId, labelId: label(n) })));

      // Status transitions – the progress chart reads these from the activity log.
      const moves: { on: number; from: string; to: string }[] = [];
      if (t.started !== null) moves.push({ on: t.started, from: todo.id, to: inprog.id });
      if (t.finished !== null) moves.push({ on: t.finished, from: inprog.id, to: done.id });
      if (moves.length) {
        await db.insert(schema.activityLog).values(moves.map((m) => ({
          id: ulid(), entityType: 'task', entityId: taskId, actorId: ownerId, action: 'update',
          diff: { statusId: { from: m.from, to: m.to } }, createdAt: at(m.on),
        })));
      }
    }

    // Summary, milestones and an update, so the project overview is populated.
    await db.update(schema.projects)
      .set({
        summary: 'Full redesign and rebuild of the Globex marketing site.',
        priority: 'high',
        startDate: day(-21),
        targetDate: day(45),
        // Stored as a JSON-serialized tiptap doc in a text column (see ProjectDetail).
        description: JSON.stringify({
          type: 'doc',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'Globex is replacing a five-year-old WordPress site. We own brand, design and build; they own copy. Launch is tied to their Q4 campaign, so the public launch date is fixed.' }] },
            { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Scope' }] },
            { type: 'bulletList', content: [
              { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Brand system and design library' }] }] },
              { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Marketing site: home, pricing, product, careers' }] }] },
              { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Headless CMS with a content migration from the old site' }] }] },
            ] },
          ],
        }),
      })
      .where(eq(schema.projects.id, id));
    await db.insert(schema.milestones).values([
      { id: ulid(), projectId: id, name: 'Brand guidelines', targetDate: day(-3), done: true, position: 0 },
      { id: ulid(), projectId: id, name: 'Design sign-off', targetDate: day(5), done: false, position: 1 },
      { id: ulid(), projectId: id, name: 'Beta launch', targetDate: day(24), done: false, position: 2 },
      { id: ulid(), projectId: id, name: 'Public launch', targetDate: day(45), done: false, position: 3 },
    ]);
    await db.insert(schema.projectUpdates).values({
      id: ulid(), projectId: id, health: 'on_track',
      body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Design is a week ahead; the checkout bug is the only thing between us and the beta. Client demo booked for Friday.' }] }] },
      createdBy: ownerId,
    });

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

  // A second client and a pipeline with deals at different stages.
  const [initech] = await db.select().from(schema.companies).where(eq(schema.companies.name, 'Initech'));
  if (!initech) {
    const id = ulid();
    await db.insert(schema.companies).values({
      id, name: 'Initech', domain: 'initech.com', status: 'active', ownerId,
      billingEmail: 'billing@initech.com', defaultCurrency: 'USD', portalToken: ulid(), portalEnabled: false, createdBy: ownerId,
    });
    await db.insert(schema.contacts).values({ id: ulid(), companyId: id, firstName: 'Peter', lastName: 'Gibbons', email: 'peter@initech.com', isPrimary: true, createdBy: ownerId });
    const stages = await db.select().from(schema.dealStages);
    const stage = (name: string) => stages.find((s) => s.name === name)?.id ?? stages[0]!.id;
    await db.insert(schema.deals).values([
      { id: ulid(), companyId: id, title: 'Mobile app discovery', stageId: stage('Lead'), amount: '9000', currency: 'USD', ownerId, createdBy: ownerId },
      { id: ulid(), companyId: id, title: 'Brand refresh', stageId: stage('Qualified'), amount: '24000', currency: 'USD', ownerId, createdBy: ownerId },
      { id: ulid(), companyId: company!.id, title: 'Retainer 2026', stageId: stage('Proposal'), amount: '48000', currency: 'USD', ownerId, createdBy: ownerId },
      { id: ulid(), companyId: id, title: 'Careers site', stageId: stage('Won'), amount: '12000', currency: 'USD', ownerId, createdBy: ownerId },
    ]);
  }

  // Invoices: one paid, one partly paid, one overdue – with matching ledger entries.
  const [firstInvoice] = await db.select().from(schema.invoices).where(eq(schema.invoices.number, 'INV-0001'));
  if (!firstInvoice) {
    const demoInvoices = [
      { number: 'INV-0001', issued: day(-45), due: day(-15), total: 6000, paid: 6000, status: 'paid', item: 'Discovery and design sprint' },
      { number: 'INV-0002', issued: day(-20), due: day(10), total: 9000, paid: 3000, status: 'partially_paid', item: 'Frontend build – milestone 1' },
      { number: 'INV-0003', issued: day(-40), due: day(-10), total: 4500, paid: 0, status: 'sent', item: 'Content migration' },
    ];
    for (const inv of demoInvoices) {
      const id = ulid();
      await db.insert(schema.invoices).values({
        id, companyId: company!.id, projectId: project!.id, number: inv.number, status: inv.status,
        currency: 'USD', issueDate: inv.issued, dueDate: inv.due, subtotal: String(inv.total),
        total: String(inv.total), amountPaid: String(inv.paid), publicToken: ulid(),
        sentAt: new Date(), createdBy: ownerId,
      });
      await db.insert(schema.invoiceItems).values({
        id: ulid(), invoiceId: id, description: inv.item, quantity: '1',
        unitPrice: String(inv.total), amount: String(inv.total), position: '1000',
      });
      await postInvoiceSent(null, { id, number: inv.number, total: String(inv.total), currency: 'USD', issueDate: inv.issued, projectId: project!.id, companyId: company!.id });
      if (inv.paid > 0) {
        const paymentId = ulid();
        await db.insert(schema.payments).values({
          id: paymentId, invoiceId: id, amount: String(inv.paid), currency: 'USD',
          date: inv.due, method: 'bank_transfer', createdBy: ownerId,
        });
        await postPayment(null, { id: paymentId, amount: inv.paid, currency: 'USD', date: inv.due }, { number: inv.number, projectId: project!.id, companyId: company!.id });
      }
    }
  }

  // A couple of expenses, including a recurring subscription.
  const [firstExpense] = await db.select().from(schema.expenses).where(eq(schema.expenses.description, 'Figma team plan'));
  if (!firstExpense) {
    const [softwareCat] = await db.select().from(schema.expenseCategories);
    await db.insert(schema.expenses).values([
      { id: ulid(), description: 'Figma team plan', amount: '135', currency: 'USD', date: day(-12), categoryId: softwareCat?.id ?? null, billable: false, createdBy: ownerId },
      { id: ulid(), description: 'Stock photography for Globex', amount: '240', currency: 'USD', date: day(-8), categoryId: softwareCat?.id ?? null, projectId: project!.id, billable: true, createdBy: ownerId },
    ]);
  }

  // Logged time, so Time and project profitability have something to show.
  const [firstEntry] = await db.select().from(schema.timeEntries).where(eq(schema.timeEntries.note, 'Homepage layout explorations'));
  if (!firstEntry) {
    const projectTasks = await db.select().from(schema.tasks).where(eq(schema.tasks.projectId, project!.id));
    const taskByTitle = (t: string) => projectTasks.find((x) => x.title.startsWith(t))?.id;
    const demoEntries = [
      { note: 'Homepage layout explorations', hours: 6.5, days: -3, user: ownerId, task: 'Design the new homepage' },
      { note: 'Pricing page implementation', hours: 7, days: -2, user: member!.id, task: 'Build the pricing page' },
      { note: 'Checkout bug investigation', hours: 2.5, days: -1, user: member!.id, task: 'Checkout returns 500' },
      { note: 'Client demo prep', hours: 3, days: -1, user: ownerId, task: 'Design the new homepage' },
    ];
    const entries = demoEntries.flatMap((e) => {
      const taskId = taskByTitle(e.task);
      if (!taskId) return [];
      const startedAt = new Date();
      startedAt.setDate(startedAt.getDate() + e.days);
      startedAt.setHours(10, 0, 0, 0);
      return [{
        id: ulid(), taskId, userId: e.user, projectId: project!.id, startedAt,
        durationSeconds: Math.round(e.hours * 3600), note: e.note, billable: true,
        // Billed to the client vs what the hour costs the agency – this is what
        // drives the margin column in Finance.
        hourlyRate: '120', costRate: '45',
      }];
    });
    if (entries.length) await db.insert(schema.timeEntries).values(entries);
  }

  // KB space + page for the project
  const [space] = await db.select().from(schema.kbSpaces).where(eq(schema.kbSpaces.name, 'Agency Processes'));
  if (!space) {
    const doc = (...paragraphs: string[]) => ({
      type: 'doc',
      content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
    });
    const spaceId = ulid();
    await db.insert(schema.kbSpaces).values({ id: spaceId, name: 'Agency Processes', visibility: 'workspace' });
    const handbookId = ulid();
    await db.insert(schema.kbSpaces).values({ id: handbookId, name: 'Team Handbook', visibility: 'workspace' });

    const pages = [
      { space: spaceId, title: 'Onboarding a new client', published: true,
        body: doc('Everything between a signed proposal and the kick-off call.',
          'Create the company in CRM, convert the deal, then create the project from the client template. Invite the client to the portal on the day of kick-off, not before.') },
      { space: spaceId, title: 'How we scope and estimate', published: false,
        body: doc('We estimate in hours, in ranges, and we never commit to a range we have not broken down.',
          'Anything above 40 hours gets split into milestones before it goes into a proposal.') },
      { space: spaceId, title: 'Invoicing and payment terms', published: false,
        body: doc('Standard terms are 50% up front and net-30 on the balance.',
          'Invoices go out from Finance, never from a personal mailbox. Reminders are automatic at 3 and 10 days overdue.') },
      { space: handbookId, title: 'Working hours and time tracking', published: false,
        body: doc('Log time the same day. An hour reconstructed on Friday is a guess, and guesses ruin project margins.') },
      { space: handbookId, title: 'Time off and public holidays', published: false,
        body: doc('Request leave in People. Anything longer than three days needs two weeks of notice so we can re-plan resourcing.') },
    ];
    for (const p of pages) {
      const pageId = ulid();
      await db.insert(schema.kbPages).values({
        id: pageId, spaceId: p.space, title: p.title, published: p.published,
        visibility: p.published ? 'public' : 'workspace', body: p.body, createdBy: ownerId,
      });
      await db.insert(schema.kbPageVersions).values({ id: ulid(), pageId, title: p.title, body: p.body, versionNo: 1, authorId: ownerId });
    }
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
