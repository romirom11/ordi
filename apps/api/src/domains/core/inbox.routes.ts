/**
 * The Inbox ("Вхідні"): everything waiting on the signed-in person, in one
 * place. Four sections, each read from data the product already keeps:
 *
 * - waitingOnYou – open task questions addressed to them (task_questions);
 * - agentStopped – agent runs whose latest attempt failed or is parked for a
 *   quota, on tasks they are assigned to or reported, or by agents they own;
 * - mentions – their recent @-mention notifications, on tasks and KB pages;
 * - approvals – leave requests waiting on their decision, the same set the
 *   People page lists under "approvals" (approver = them, still pending).
 *
 * Every row is checked against what the person can open *now*: a project
 * they were removed from, a private one, a deleted task or a page closed to
 * them drops out, however the row was addressed when it was written.
 */
import { Hono } from 'hono';
import { getDb, schema, eq, and, inArray, isNull, gt, desc, sql } from '@ordi/db';
import type { AppEnv, Actor } from '../../context';
import { requireAuth, currentActor } from '../../core/auth';
import { accessibleProjectIds, accessibleSpaceIds, editableSpaceIds } from '../../core/access';
import { moduleEnabled } from '../../core/modules';
import { err } from '../../lib/errors';
import { canSeePage } from '@ordi/shared';
import { employeeOfUser, listLeaveRequests } from '../people/service';

const { taskQuestions, tasks, projects, users, agentRuns, taskAssignees, externalAgents, notifications } = schema;

/** How far back the Inbox looks for mentions: they are news, not open work. */
const RECENT_DAYS = 30;
/** Rows per section. Open work (questions, approvals) is counted in full. */
const LIMIT = 100;
/** Mentions read before the access filter, so a run of closed ones cannot empty the section. */
const MENTION_SCAN = 300;

function recent(): Date {
  return new Date(Date.now() - RECENT_DAYS * 86_400_000);
}

function assertPerson(actor: Actor): void {
  // An agent is never asked anything, has no mentions to read and approves
  // nothing: the Inbox is a person's. Agents read answers with list_answered.
  if (actor.actorType !== 'user') throw err.forbidden('The Inbox belongs to a person, not an agent');
}

async function waitingOnYou(actor: Actor, projectIds: string[]) {
  if (!projectIds.length) return [];
  const { db } = getDb();
  const rows = await db.select({
    id: taskQuestions.id, question: taskQuestions.question, askedAt: taskQuestions.askedAt,
    askedById: taskQuestions.askedBy, askedByName: users.name, askedByType: users.actorType,
    taskId: tasks.id, projectId: tasks.projectId, number: tasks.number, title: tasks.title, key: projects.key,
  })
    .from(taskQuestions)
    .innerJoin(tasks, eq(tasks.id, taskQuestions.taskId))
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .leftJoin(users, eq(users.id, taskQuestions.askedBy))
    .where(and(
      eq(taskQuestions.addresseeId, actor.userId),
      eq(taskQuestions.status, 'open'),
      isNull(tasks.deletedAt),
      inArray(tasks.projectId, projectIds),
    ))
    .orderBy(desc(taskQuestions.askedAt))
    .limit(LIMIT);
  return rows.map((r) => ({
    id: r.id, question: r.question, askedAt: r.askedAt,
    askedBy: { id: r.askedById, name: r.askedByName ?? '', actorType: r.askedByType ?? 'user' },
    task: { id: r.taskId, projectId: r.projectId, ref: `${r.key}-${r.number}`, title: r.title },
  }));
}

async function agentStopped(actor: Actor, projectIds: string[]) {
  if (!projectIds.length) return [];
  const { db } = getDb();
  const me = actor.userId;
  const inProjects = sql.join(projectIds.map((id) => sql`${id}`), sql`, `);
  // The latest run per task and agent, however old: a failure a retry has
  // since fixed is not news any more, and one still parked or failed is open
  // work whenever it started.
  const rows = await db.execute(sql`
    select r.id, r.status, r.error, r.task_id, r.project_id, r.agent_user_id, r.updated_at, r.next_attempt_at,
      t.number, t.title, p.key, a.name as agent_name
    from (
      select distinct on (task_id, agent_user_id) *
      from ${agentRuns}
      where project_id in (${inProjects})
      order by task_id, agent_user_id, created_at desc, id desc
    ) r
    join ${tasks} t on t.id = r.task_id and t.deleted_at is null
    join ${projects} p on p.id = t.project_id
    join ${users} a on a.id = r.agent_user_id
    where r.status in ('failed', 'waiting_quota')
      and (
        t.reporter_id = ${me}
        or exists (select 1 from ${taskAssignees} ta where ta.task_id = t.id and ta.user_id = ${me})
        or exists (select 1 from ${externalAgents} ea where ea.user_id = r.agent_user_id and ea.owner_user_id = ${me})
      )
    order by r.updated_at desc
    limit ${LIMIT}`) as unknown as {
      id: string; status: string; error: string | null; task_id: string; project_id: string; agent_user_id: string;
      updated_at: string | Date; next_attempt_at: string | Date | null; number: number; title: string; key: string; agent_name: string;
    }[];
  return rows.map((r) => ({
    id: r.id,
    status: r.status as 'failed' | 'waiting_quota',
    error: r.error,
    at: r.updated_at,
    retryAt: r.next_attempt_at,
    agent: { id: r.agent_user_id, name: r.agent_name },
    task: { id: r.task_id, projectId: r.project_id, ref: `${r.key}-${r.number}`, title: r.title },
  }));
}

async function mentions(actor: Actor, projectIds: Set<string>) {
  const { db } = getDb();
  const rows = await db.select().from(notifications)
    .where(and(
      eq(notifications.userId, actor.userId),
      inArray(notifications.type, ['comment.mentioned', 'page.mentioned']),
      gt(notifications.createdAt, recent()),
    ))
    .orderBy(desc(notifications.createdAt))
    .limit(MENTION_SCAN);
  const payloadOf = (r: typeof rows[number]) => r.payload as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  // The bell row was gated when it was delivered; access may have changed
  // since. Everything is read for this request's own access – a token scoped
  // narrower than its owner's role sees no more than it may open.
  const taskIds = [...new Set(rows.map((r) => str(payloadOf(r).taskId)).filter((id): id is string => !!id))];
  const liveTasks = new Map(taskIds.length
    ? (await db.select({ id: tasks.id, projectId: tasks.projectId }).from(tasks)
      .where(and(inArray(tasks.id, taskIds), isNull(tasks.deletedAt)))).map((t) => [t.id, t.projectId])
    : []);
  const pageIds = [...new Set(rows.map((r) => str(payloadOf(r).pageId)).filter((id): id is string => !!id))];
  const kbOn = pageIds.length > 0 && (await moduleEnabled('kb'));
  const pages = new Map(kbOn
    ? (await db.select({
      id: schema.kbPages.id, spaceId: schema.kbPages.spaceId, published: schema.kbPages.published,
      visibility: schema.kbPages.visibility, createdBy: schema.kbPages.createdBy,
    }).from(schema.kbPages).where(and(inArray(schema.kbPages.id, pageIds), isNull(schema.kbPages.deletedAt)))).map((p) => [p.id, p])
    : []);
  const viewerSpaces = new Set<string>(kbOn ? await accessibleSpaceIds(actor) : []);
  const editorSpaces = new Set<string>(kbOn ? await editableSpaceIds(actor) : []);
  // A mention in a comment that has since been deleted points at nothing.
  const commentIds = rows.map((r) => str(payloadOf(r).commentId)).filter((id): id is string => !!id);
  const liveComments = new Set<string>();
  if (commentIds.length) {
    for (const c of await db.select({ id: schema.comments.id }).from(schema.comments)
      .where(and(inArray(schema.comments.id, commentIds), isNull(schema.comments.deletedAt)))) liveComments.add(c.id);
    for (const c of await db.select({ id: schema.kbPageComments.id }).from(schema.kbPageComments)
      .where(and(inArray(schema.kbPageComments.id, commentIds), isNull(schema.kbPageComments.deletedAt)))) liveComments.add(c.id);
  }

  const out = [];
  for (const r of rows) {
    if (out.length >= LIMIT) break;
    const p = payloadOf(r);
    const commentId = str(p.commentId);
    if (commentId && !liveComments.has(commentId)) continue;
    const pageId = str(p.pageId);
    if (pageId) {
      const page = pages.get(pageId);
      if (!page || !viewerSpaces.has(page.spaceId) || !canSeePage(page, actor.userId, editorSpaces.has(page.spaceId))) continue;
    } else {
      const taskId = str(p.taskId);
      const projectId = taskId ? liveTasks.get(taskId) : undefined;
      if (!projectId || !projectIds.has(projectId)) continue;
    }
    out.push({
      id: r.id,
      type: r.type,
      at: r.createdAt,
      readAt: r.readAt,
      ref: r.entityRef ?? str(p.ref),
      title: str(p.title),
      actorName: str(p.actorName),
      payload: { taskId: str(p.taskId), projectId: str(p.projectId), pageId, spaceId: str(p.spaceId) },
    });
  }
  return out;
}

/**
 * Leave waiting on this person's decision: requests addressed to them that
 * they can still decide – the rule decideLeave applies: the employee's
 * current manager, or someone with people.approve_leave. A manager the
 * employee has since moved away from no longer sees their dates.
 */
async function approvals(actor: Actor) {
  if (!(await moduleEnabled('people'))) return [];
  const rows = await listLeaveRequests({ approverId: actor.userId, status: 'pending' });
  if (!rows.length) return [];
  let decidable = rows;
  if (!actor.access.permissions.has('people.approve_leave')) {
    const { db } = getDb();
    const employeeIds = [...new Set(rows.map((r) => r.employeeId))];
    const lines = await db.select({ id: schema.employees.id, managerUserId: sql<string | null>`m.user_id` })
      .from(schema.employees)
      .leftJoin(sql`employees m`, sql`m.id = ${schema.employees.managerId}`)
      .where(inArray(schema.employees.id, employeeIds));
    const managedByMe = new Set(lines.filter((l) => l.managerUserId === actor.userId).map((l) => l.id));
    decidable = rows.filter((r) => managedByMe.has(r.employeeId));
  }
  return decidable.map((r) => ({
    kind: 'leave' as const,
    id: r.id,
    at: r.createdAt,
    employeeName: r.employeeName,
    leaveTypeName: r.leaveTypeName,
    fromDate: r.fromDate,
    toDate: r.toDate,
    halfDay: r.halfDay,
  }));
}

export async function inbox(actor: Actor) {
  const projectIds = await accessibleProjectIds(actor);
  const [w, s, m, a, waitingTotal] = await Promise.all([
    waitingOnYou(actor, projectIds),
    agentStopped(actor, projectIds),
    mentions(actor, new Set(projectIds)),
    approvals(actor),
    countWaiting(actor, projectIds),
  ]);
  // Approvals are decided on the approver's own employee card (its leave
  // card lists them with Approve / Reject); without one, on People → Leave.
  const me = a.length ? await employeeOfUser(actor.userId) : null;
  // The list shows the newest LIMIT; the header counts them all.
  return { waitingOnYou: w, agentStopped: s, mentions: m, approvals: a, approverEmployeeId: me?.id ?? null, totals: { waitingOnYou: waitingTotal } };
}

/** Open questions waiting on the person, in projects they can open now. */
async function countWaiting(actor: Actor, projectIds: string[]): Promise<number> {
  const { db } = getDb();
  const [q] = projectIds.length
    ? await db.select({ n: sql<number>`count(*)::int` }).from(taskQuestions)
      .innerJoin(tasks, eq(tasks.id, taskQuestions.taskId))
      .where(and(
        eq(taskQuestions.addresseeId, actor.userId), eq(taskQuestions.status, 'open'),
        isNull(tasks.deletedAt), inArray(tasks.projectId, projectIds),
      ))
    : [{ n: 0 }];
  return Number(q?.n ?? 0);
}

/** The nav badge: what needs the person to act – questions and approvals. */
export async function inboxCount(actor: Actor) {
  const projectIds = await accessibleProjectIds(actor);
  const [waiting, approvalsCount] = await Promise.all([
    countWaiting(actor, projectIds),
    approvals(actor).then((a) => a.length),
  ]);
  return { waitingOnYou: waiting, approvals: approvalsCount, total: waiting + approvalsCount };
}

export function inboxRoutes() {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth);
  app.get('/', async (c) => {
    const actor = currentActor(c);
    assertPerson(actor);
    return c.json(await inbox(actor));
  });
  app.get('/count', async (c) => {
    const actor = currentActor(c);
    assertPerson(actor);
    return c.json(await inboxCount(actor));
  });
  return app;
}
