/**
 * "Waiting on": a question put to one person on a task, without changing the
 * task's status (docs/architecture-decisions.md, "Waiting on is a flag, not a
 * status"). An agent – or a person – asks; the addressee answers by
 * commenting, or marks it answered; the asker or the project's lead withdraws
 * it. A task has at most one open question, kept in task_questions with the
 * ones before it, so an agent can ask what was answered since (listAnswered).
 *
 * Every write commits its event (publishEvent) and its activity record in the
 * same transaction as the row.
 */
import { getDb, schema, eq, and, inArray, isNull, gt, asc, sql } from '@ordi/db';
import { ulid } from 'ulid';
import type { Actor } from '../../context';
import { ApiException, err } from '../../lib/errors';
import { writeActivity } from '../../core/activity';
import { publishEvent } from '../../core/events';
import { accessibleProjectIds, assertProject, effectiveProjectRole, userCanOpenProject } from '../../core/access';

const { taskQuestions, tasks, projects, taskAssignees, users, externalAgents } = schema;

export type QuestionStatus = 'open' | 'answered' | 'withdrawn';

/** The open question as the task page and get_task show it. */
export interface OpenQuestionView {
  id: string;
  question: string;
  askedAt: Date;
  addressee: { id: string; name: string };
  askedBy: { id: string; name: string; actorType: string };
  /** What the reader may do with it – decided here, so the page does not guess. */
  canMarkAnswered: boolean;
  canWithdraw: boolean;
}

/**
 * A live task by id or by its ref ("ORD-12"), so an agent can name the task
 * the way people do. Visibility is checked by the caller (assertProject): a
 * ref into a project closed to them reads as not found, like an id does.
 */
async function loadLiveTask(idOrRef: string) {
  const { db } = getDb();
  const ref = /^([A-Za-z][A-Za-z0-9]*)-(\d{1,9})$/.exec(idOrRef.trim());
  const [task] = ref
    ? await db.select({ task: tasks }).from(tasks)
      .innerJoin(projects, and(eq(projects.id, tasks.projectId), isNull(projects.deletedAt)))
      .where(and(sql`upper(${projects.key}) = ${ref[1]!.toUpperCase()}`, eq(tasks.number, Number(ref[2])), isNull(tasks.deletedAt)))
      .then((rows) => rows.map((r) => r.task))
    : await db.select().from(tasks).where(and(eq(tasks.id, idOrRef), isNull(tasks.deletedAt)));
  if (!task) throw err.notFound('Task not found');
  return task;
}

async function refOfTask(task: { projectId: string; number: number }): Promise<string> {
  const { db } = getDb();
  const [p] = await db.select({ key: projects.key }).from(projects).where(eq(projects.id, task.projectId));
  return `${p?.key ?? ''}-${task.number}`;
}

/** Owner of an agent that has one (external agents: team bots and personal agents). */
async function ownerOfAgent(userId: string): Promise<string | null> {
  const { db } = getDb();
  const [row] = await db.select({ ownerUserId: externalAgents.ownerUserId })
    .from(externalAgents).where(eq(externalAgents.userId, userId));
  return row?.ownerUserId ?? null;
}

/** The person a personal agent acts for; null for anyone else. */
async function personalOwnerOf(userId: string): Promise<string | null> {
  const { db } = getDb();
  const [row] = await db.select({ ownerUserId: externalAgents.ownerUserId, kind: externalAgents.kind })
    .from(externalAgents).where(eq(externalAgents.userId, userId));
  return row?.kind === 'personal' ? row.ownerUserId : null;
}

/**
 * The task's project at the given role, read as the task: someone outside a
 * private project learns nothing from a ref, not even that the task exists.
 */
async function assertTaskProject(actor: Actor, task: { projectId: string }, role: 'viewer' | 'member'): Promise<void> {
  try {
    await assertProject(actor, task.projectId, role);
  } catch (e) {
    if (e instanceof ApiException && e.code === 'not_found') throw err.notFound('Task not found');
    throw e;
  }
}

/** An active human account: the only kind of user a question can wait on. */
async function isActivePerson(userId: string): Promise<boolean> {
  const { db } = getDb();
  const [u] = await db.select({ isActive: users.isActive, actorType: users.actorType }).from(users).where(eq(users.id, userId));
  return !!u && u.isActive && u.actorType === 'user';
}

/** Someone a question on this project can wait on: a person who can open it now. */
async function canBeAddressee(userId: string, projectId: string): Promise<boolean> {
  return (await isActivePerson(userId)) && userCanOpenProject(userId, projectId);
}

/**
 * Who a question goes to (the addressee rule):
 *
 * 1. the person named, who must be a human who can open the project – a name
 *    that is not one is refused rather than quietly sent to someone else;
 * 2. otherwise the task's human assignees: a personal agent's owner when the
 *    owner is one of them, else the first by name;
 * 3. otherwise the task's reporter – or, when the reporter is an agent, that
 *    agent's owner;
 * 4. otherwise the owner of the asking agent.
 *
 * A personal agent acts for its owner, so on its owner's task (owner assigned
 * or reporting) it asks its owner unless someone else is named. Candidates who
 * cannot open the project are passed over; the asker is never its own
 * addressee. Nobody left: refused.
 */
export async function resolveAddressee(
  actor: Actor,
  task: { id: string; projectId: string; reporterId: string | null },
  named?: string | null,
): Promise<string> {
  if (named) {
    if (named === actor.userId) throw err.validation('A question cannot wait on the one asking it');
    if (!(await isActivePerson(named))) {
      throw err.validation('A question waits on a person: the addressee must be an active user, not an agent');
    }
    if (!(await userCanOpenProject(named, task.projectId))) {
      throw err.validation('The addressee cannot open this project – add them to it first, or ask someone who can');
    }
    return named;
  }

  const { db } = getDb();
  const ok = async (id: string | null | undefined): Promise<boolean> =>
    !!id && id !== actor.userId && (await canBeAddressee(id, task.projectId));

  const owner = actor.agentKind === 'personal' ? actor.ownerUserId ?? null : null;
  const assigned = await db.select({ userId: taskAssignees.userId, name: users.name, actorType: users.actorType })
    .from(taskAssignees).innerJoin(users, eq(users.id, taskAssignees.userId))
    .where(eq(taskAssignees.taskId, task.id))
    .orderBy(asc(users.name), asc(users.id));
  const people = assigned.filter((a) => a.actorType === 'user').map((a) => a.userId);

  // A personal agent on its owner's task asks its owner.
  if (owner && (people.includes(owner) || task.reporterId === owner) && (await ok(owner))) return owner;

  for (const id of people) if (await ok(id)) return id;

  if (task.reporterId) {
    const [reporter] = await db.select({ actorType: users.actorType }).from(users).where(eq(users.id, task.reporterId));
    const reporterPerson = reporter?.actorType === 'agent' ? await ownerOfAgent(task.reporterId) : task.reporterId;
    if (await ok(reporterPerson)) return reporterPerson!;
  }

  const askerOwner = actor.actorType === 'agent' ? (actor.ownerUserId ?? (await ownerOfAgent(actor.userId))) : null;
  if (await ok(askerOwner)) return askerOwner!;

  throw err.domain('Nobody to ask: the task has no assignee or reporter who can open the project. Name the person with addresseeId.');
}

/**
 * Whether the actor may close the task's open question by hand. The asker –
 * or, for a personal agent's question, the person it acts for – and the
 * project's lead may withdraw it; those and the addressee may mark it
 * answered. The addressee may do so with read access alone: a viewer cannot
 * comment, so marking is their only way to answer. Only the person
 * themselves: their own agent closes nothing on their behalf.
 */
async function closeRights(
  actor: Actor,
  task: { projectId: string },
  q: { addresseeId: string; askedBy: string },
): Promise<{ canWithdraw: boolean; canMarkAnswered: boolean }> {
  const none = { canWithdraw: false, canMarkAnswered: false };
  const { db } = getDb();
  const [project] = await db.select({ id: projects.id, leadId: projects.leadId, visibility: projects.visibility })
    .from(projects).where(and(eq(projects.id, task.projectId), isNull(projects.deletedAt)));
  if (!project) return none;
  const role = effectiveProjectRole(actor, { id: project.id, visibility: project.visibility as 'workspace' | 'private' });
  if (!role) return none;
  const addressee = q.addresseeId === actor.userId;
  if (role === 'viewer') return { canWithdraw: false, canMarkAnswered: addressee };
  const asker = q.askedBy === actor.userId
    || (actor.actorType === 'user' && (await personalOwnerOf(q.askedBy)) === actor.userId);
  const canWithdraw = asker || project.leadId === actor.userId;
  return { canWithdraw, canMarkAnswered: canWithdraw || addressee };
}

/** The open question on a task, or null – for the task page and get_task. */
export async function openQuestionView(actor: Actor, task: { id: string; projectId: string }): Promise<OpenQuestionView | null> {
  const { db } = getDb();
  const [q] = await db.select().from(taskQuestions)
    .where(and(eq(taskQuestions.taskId, task.id), eq(taskQuestions.status, 'open')));
  if (!q) return null;
  const people = await db.select({ id: users.id, name: users.name, actorType: users.actorType })
    .from(users).where(inArray(users.id, [q.addresseeId, q.askedBy]));
  const find = (id: string) => people.find((p) => p.id === id);
  const rights = await closeRights(actor, task, q);
  return {
    id: q.id,
    question: q.question,
    askedAt: q.askedAt,
    addressee: { id: q.addresseeId, name: find(q.addresseeId)?.name ?? '' },
    askedBy: { id: q.askedBy, name: find(q.askedBy)?.name ?? '', actorType: find(q.askedBy)?.actorType ?? 'user' },
    ...rights,
  };
}

/** Who each of these tasks waits on (its open question's addressee), for the lists. */
export async function waitingOnFor(taskIds: string[]): Promise<Map<string, string>> {
  if (!taskIds.length) return new Map();
  const { db } = getDb();
  const rows = await db.select({ taskId: taskQuestions.taskId, addresseeId: taskQuestions.addresseeId })
    .from(taskQuestions).where(and(inArray(taskQuestions.taskId, taskIds), eq(taskQuestions.status, 'open')));
  return new Map(rows.map((r) => [r.taskId, r.addresseeId]));
}

/** Subquery: ids of tasks with an open question waiting on `userId`. */
export function tasksWaitingOn(userId: string) {
  const { db } = getDb();
  return db.select({ id: taskQuestions.taskId }).from(taskQuestions)
    .where(and(eq(taskQuestions.addresseeId, userId), eq(taskQuestions.status, 'open')));
}

/**
 * Open a question on a task. The asker needs write access to the project; the
 * addressee is resolved by resolveAddressee. If the task already waits on a
 * question the same actor asked, the new one replaces it (the old one is
 * withdrawn); a question someone else asked is never replaced – refused.
 */
export async function askForInput(
  actor: Actor,
  taskRef: string,
  input: { question: string; addresseeId?: string | null },
): Promise<{ id: string; taskId: string; ref: string; addressee: { id: string; name: string }; replaced: string | null }> {
  const task = await loadLiveTask(taskRef);
  const taskId = task.id;
  await assertTaskProject(actor, task, 'member');
  const addresseeId = await resolveAddressee(actor, task, input.addresseeId);
  const ref = await refOfTask(task);
  const { db } = getDb();
  const [addressee] = await db.select({ name: users.name }).from(users).where(eq(users.id, addresseeId));

  const id = ulid();
  const replaced = await db.transaction(async (tx) => {
    // Serialise questions on one task: two asks at once must not both pass
    // the check below and leave one of them to fail on the unique index.
    // A task moved or deleted meanwhile is gone: no question on a dead row.
    const [live] = await tx.select({ id: tasks.id }).from(tasks)
      .where(and(eq(tasks.id, taskId), isNull(tasks.deletedAt))).for('update');
    if (!live) throw err.notFound('Task not found');
    const [open] = await tx.select().from(taskQuestions)
      .where(and(eq(taskQuestions.taskId, taskId), eq(taskQuestions.status, 'open')));
    if (open && open.askedBy !== actor.userId) {
      throw err.domain('This task already waits on an answer to someone else\'s question. Comment on the task instead, or wait until it is answered or withdrawn.', { openQuestionId: open.id });
    }
    // Only while it is still open: an answer committed in the meantime (a
    // comment does not take the task lock) stays an answer.
    const [withdrawn] = open
      ? await tx.update(taskQuestions).set({ status: 'withdrawn', withdrawnAt: new Date(), withdrawnBy: actor.userId, updatedAt: new Date() })
        .where(and(eq(taskQuestions.id, open.id), eq(taskQuestions.status, 'open')))
        .returning({ id: taskQuestions.id })
      : [];
    await tx.insert(taskQuestions).values({ id, taskId, addresseeId, askedBy: actor.userId, question: input.question });
    await publishEvent(tx, {
      type: 'task.input_requested', aggregateType: 'task', aggregateId: taskId,
      payload: { ref, taskId, projectId: task.projectId, questionId: id, addresseeId, askedBy: actor.userId, question: input.question, replaced: withdrawn?.id ?? null },
      actorId: actor.userId, actorType: actor.actorType,
    });
    await writeActivity(tx, {
      entityType: 'task', entityId: taskId, action: 'input_requested',
      after: { questionId: id, addresseeId, question: input.question },
      actorId: actor.userId, actorType: actor.actorType,
    });
    return withdrawn?.id ?? null;
  });
  return { id, taskId, ref, addressee: { id: addresseeId, name: addressee?.name ?? '' }, replaced };
}

/**
 * Inside addComment's transaction: the addressee's first comment after the
 * question answers it. A comment by anyone else – the asker, a colleague, the
 * addressee's own agent – leaves it open.
 */
export async function answerByComment(
  tx: any,
  actor: Actor,
  task: { id: string; projectId: string },
  ref: string,
  commentId: string,
): Promise<void> {
  const now = new Date();
  const [answered] = await tx.update(taskQuestions)
    .set({ status: 'answered', answeredAt: now, answerCommentId: commentId, answeredBy: actor.userId, updatedAt: now })
    .where(and(eq(taskQuestions.taskId, task.id), eq(taskQuestions.status, 'open'), eq(taskQuestions.addresseeId, actor.userId)))
    .returning({ id: taskQuestions.id, askedBy: taskQuestions.askedBy });
  if (!answered) return;
  await publishEvent(tx, {
    type: 'task.input_answered', aggregateType: 'task', aggregateId: task.id,
    payload: { ref, taskId: task.id, projectId: task.projectId, questionId: answered.id, askedBy: answered.askedBy, commentId },
    actorId: actor.userId, actorType: actor.actorType,
  });
  await writeActivity(tx, {
    entityType: 'task', entityId: task.id, action: 'input_answered',
    after: { questionId: answered.id, commentId }, actorId: actor.userId, actorType: actor.actorType,
  });
}

/**
 * Close the open question by hand: marked answered (no comment) or withdrawn.
 * `questionId` is the question the caller is looking at: a page left open
 * while the question was replaced must not close the new one. The check and
 * the write happen under the task's lock, so a move or a replacement cannot
 * slip in between them.
 */
export async function closeQuestion(
  actor: Actor,
  taskRef: string,
  how: 'answered' | 'withdrawn',
  questionId?: string | null,
): Promise<{ ok: true; questionId: string }> {
  const task = await loadLiveTask(taskRef);
  const taskId = task.id;
  await assertTaskProject(actor, task, 'viewer');
  const ref = await refOfTask(task);
  const { db } = getDb();
  const closedId = await db.transaction(async (tx) => {
    // A moved task's old row is deleted: its questions went with the new one.
    const [live] = await tx.select({ id: tasks.id, projectId: tasks.projectId }).from(tasks)
      .where(and(eq(tasks.id, taskId), isNull(tasks.deletedAt))).for('update');
    if (!live || live.projectId !== task.projectId) throw err.notFound('Task not found');
    const [open] = await tx.select().from(taskQuestions)
      .where(and(eq(taskQuestions.taskId, taskId), eq(taskQuestions.status, 'open')));
    if (!open) throw err.notFound('This task is not waiting on anyone');
    if (questionId && open.id !== questionId) {
      throw err.conflict('The task now waits on a different question – reload to see it', { openQuestionId: open.id });
    }
    const rights = await closeRights(actor, live, open);
    if (how === 'answered' && !rights.canMarkAnswered) {
      throw err.forbidden('Only the person it waits on, the one who asked, or the project lead can mark this answered');
    }
    if (how === 'withdrawn' && !rights.canWithdraw) {
      throw err.forbidden('Only the one who asked or the project lead can withdraw this question');
    }
    const now = new Date();
    const set = how === 'answered'
      ? { status: 'answered', answeredAt: now, answeredBy: actor.userId, updatedAt: now }
      : { status: 'withdrawn', withdrawnAt: now, withdrawnBy: actor.userId, updatedAt: now };
    const [row] = await tx.update(taskQuestions).set(set)
      .where(and(eq(taskQuestions.id, open.id), eq(taskQuestions.status, 'open')))
      .returning({ id: taskQuestions.id });
    // Answered by a comment in between: nothing left to close.
    if (!row) throw err.notFound('This task is not waiting on anyone');
    await publishEvent(tx, {
      type: how === 'answered' ? 'task.input_answered' : 'task.input_withdrawn',
      aggregateType: 'task', aggregateId: taskId,
      payload: { ref, taskId, projectId: live.projectId, questionId: open.id, askedBy: open.askedBy, commentId: null },
      actorId: actor.userId, actorType: actor.actorType,
    });
    await writeActivity(tx, {
      entityType: 'task', entityId: taskId, action: how === 'answered' ? 'input_answered' : 'input_withdrawn',
      after: { questionId: open.id }, actorId: actor.userId, actorType: actor.actorType,
    });
    return open.id;
  });
  return { ok: true, questionId: closedId };
}

/**
 * Questions the actor asked that have been answered since `since` (all of them
 * when absent), oldest answer first – where an agent picks its work back up.
 * Scoped to the calling actor: a personal agent sees its own questions, not
 * its owner's; and to tasks the actor can still open.
 *
 * Paged: a full page carries `nextCursor`, an opaque "answered at + id" key
 * to pass back as `cursor`, so a burst of answers is read to the end instead
 * of being cut off at the page size.
 */
export async function listAnswered(actor: Actor, opts: { since?: Date | null; cursor?: string | null; limit?: number } = {}) {
  const limit = opts.limit ?? 100;
  const since = opts.since ?? null;
  const projectIds = await accessibleProjectIds(actor);
  if (!projectIds.length) return { data: [], nextCursor: null };
  let after: { at: string; id: string } | null = null;
  if (opts.cursor) {
    const at = opts.cursor.lastIndexOf('|');
    if (at <= 0) throw err.validation('cursor is not one this list returned');
    after = { at: opts.cursor.slice(0, at), id: opts.cursor.slice(at + 1) };
    if (Number.isNaN(new Date(after.at).getTime())) throw err.validation('cursor is not one this list returned');
  }
  const { db } = getDb();
  const rows = await db.select({
    id: taskQuestions.id, taskId: taskQuestions.taskId, question: taskQuestions.question,
    askedAt: taskQuestions.askedAt, answeredAt: taskQuestions.answeredAt, answeredBy: taskQuestions.answeredBy,
    addresseeId: taskQuestions.addresseeId, answerCommentId: taskQuestions.answerCommentId,
    projectId: tasks.projectId, number: tasks.number, title: tasks.title, key: projects.key,
    // Full precision for the cursor: a JS Date would round the microseconds.
    answeredAtKey: sql<string>`to_char(${taskQuestions.answeredAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
  })
    .from(taskQuestions)
    .innerJoin(tasks, eq(tasks.id, taskQuestions.taskId))
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(and(
      eq(taskQuestions.askedBy, actor.userId),
      eq(taskQuestions.status, 'answered'),
      isNull(tasks.deletedAt),
      inArray(tasks.projectId, projectIds),
      since ? gt(taskQuestions.answeredAt, since) : undefined,
      after ? sql`(${taskQuestions.answeredAt}, ${taskQuestions.id}) > (${after.at}::timestamptz, ${after.id})` : undefined,
    ))
    .orderBy(asc(taskQuestions.answeredAt), asc(taskQuestions.id))
    .limit(limit + 1);
  const more = rows.length > limit;
  if (more) rows.length = limit;
  const last = rows[rows.length - 1];
  const nextCursor = more && last ? `${last.answeredAtKey}|${last.id}` : null;
  const commentIds = rows.map((r) => r.answerCommentId).filter((id): id is string => !!id);
  const comments = commentIds.length
    ? await db.select({ id: schema.comments.id, body: schema.comments.body, authorId: schema.comments.authorId, createdAt: schema.comments.createdAt, deletedAt: schema.comments.deletedAt })
      .from(schema.comments).where(inArray(schema.comments.id, commentIds))
    : [];
  const peopleIds = [...new Set(rows.flatMap((r) => [r.addresseeId, r.answeredBy]).filter((id): id is string => !!id))];
  const names = new Map(peopleIds.length
    ? (await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, peopleIds))).map((u) => [u.id, u.name])
    : []);
  return {
    data: rows.map((r) => {
      const c = comments.find((x) => x.id === r.answerCommentId && !x.deletedAt);
      return {
        id: r.id,
        taskId: r.taskId,
        projectId: r.projectId,
        ref: `${r.key}-${r.number}`,
        title: r.title,
        question: r.question,
        askedAt: r.askedAt,
        answeredAt: r.answeredAt,
        addressee: { id: r.addresseeId, name: names.get(r.addresseeId) ?? '' },
        answeredBy: r.answeredBy ? { id: r.answeredBy, name: names.get(r.answeredBy) ?? '' } : null,
        answer: c ? { commentId: c.id, authorId: c.authorId, createdAt: c.createdAt, body: c.body } : null,
      };
    }),
    nextCursor,
  };
}

/**
 * A moved task's questions follow it to its new row. An open one whose
 * addressee cannot open the target project is withdrawn instead: it would
 * wait on someone who can no longer see the task.
 */
export async function moveQuestions(
  tx: any,
  actor: Actor,
  oldId: string,
  moved: { id: string; projectId: string; projectKey: string },
): Promise<void> {
  const [open] = await tx.select().from(taskQuestions)
    .where(and(eq(taskQuestions.taskId, oldId), eq(taskQuestions.status, 'open')));
  await tx.update(taskQuestions).set({ taskId: moved.id }).where(eq(taskQuestions.taskId, oldId));
  if (!open || (await userCanOpenProject(open.addresseeId, moved.projectId))) return;
  await tx.update(taskQuestions).set({ status: 'withdrawn', withdrawnAt: new Date(), withdrawnBy: actor.userId, updatedAt: new Date() })
    .where(eq(taskQuestions.id, open.id));
  const [row] = await tx.select({ number: tasks.number }).from(tasks).where(eq(tasks.id, moved.id));
  await publishEvent(tx, {
    type: 'task.input_withdrawn', aggregateType: 'task', aggregateId: moved.id,
    payload: { ref: `${moved.projectKey}-${row?.number ?? ''}`, taskId: moved.id, projectId: moved.projectId, questionId: open.id, askedBy: open.askedBy, commentId: null, reason: 'moved' },
    actorId: actor.userId, actorType: actor.actorType,
  });
  await writeActivity(tx, {
    entityType: 'task', entityId: moved.id, action: 'input_withdrawn',
    after: { questionId: open.id, reason: 'moved' }, actorId: actor.userId, actorType: actor.actorType,
  });
}


/**
 * Withdraw the open questions waiting on someone who can no longer answer:
 * deactivated (every project), or taken off a project they could otherwise
 * not open (`projectId`). Left open, the task would wait on nobody. Each
 * withdrawal is announced and recorded like one made by hand.
 */
export async function withdrawQuestionsWaitingOn(
  tx: any,
  actor: Actor,
  userId: string,
  reason: 'deactivated' | 'removed',
  projectId?: string,
): Promise<number> {
  const open = await tx.select({ id: taskQuestions.id, taskId: taskQuestions.taskId, askedBy: taskQuestions.askedBy, projectId: tasks.projectId, number: tasks.number, key: projects.key })
    .from(taskQuestions)
    .innerJoin(tasks, eq(tasks.id, taskQuestions.taskId))
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(and(
      eq(taskQuestions.addresseeId, userId),
      eq(taskQuestions.status, 'open'),
      projectId ? eq(tasks.projectId, projectId) : undefined,
    )) as { id: string; taskId: string; askedBy: string; projectId: string; number: number; key: string }[];
  let n = 0;
  for (const q of open) {
    const now = new Date();
    const [row] = await tx.update(taskQuestions).set({ status: 'withdrawn', withdrawnAt: now, withdrawnBy: actor.userId, updatedAt: now })
      .where(and(eq(taskQuestions.id, q.id), eq(taskQuestions.status, 'open')))
      .returning({ id: taskQuestions.id });
    if (!row) continue;
    n++;
    await publishEvent(tx, {
      type: 'task.input_withdrawn', aggregateType: 'task', aggregateId: q.taskId,
      payload: { ref: `${q.key}-${q.number}`, taskId: q.taskId, projectId: q.projectId, questionId: q.id, askedBy: q.askedBy, commentId: null, reason },
      actorId: actor.userId, actorType: actor.actorType,
    });
    await writeActivity(tx, {
      entityType: 'task', entityId: q.taskId, action: 'input_withdrawn',
      after: { questionId: q.id, reason }, actorId: actor.userId, actorType: actor.actorType,
    });
  }
  return n;
}
