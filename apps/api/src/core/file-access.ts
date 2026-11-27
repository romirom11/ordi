/**
 * Who may open a file, and which files a record may point at.
 *
 * A file either hangs off a record (a company's Files section, a project's
 * resources, an employee's documents) and then answers to that record's read
 * rule, or it hangs off nothing – an image pasted into a document, a receipt
 * named on an expense, a PDF a knowledge-base page shows. A loose file opens
 * for its uploader, and for whoever can read a record that names it (a leave
 * request, an expense, an applicant, a PDF page). A document that embeds one is
 * handled where documents are read (core/file-links): the route has decided the
 * reader may see the document, and the paths in it are signed for them there.
 */
import { getDb, schema, eq, and, isNull } from '@ordi/db';
import type { Permission } from '@ordi/shared';
import type { Actor } from '../context';
import { assertProject } from './access';
import { ApiException, err } from '../lib/errors';
import { getPage } from '../domains/kb/service';

/** Which permission covers files hanging off each entity type. */
export const READ_PERM: Record<string, Permission> = { company: 'crm.read', lead: 'crm.read', deal: 'deals.read', task: 'projects.read', project: 'projects.read', employee: 'people.read_documents', intake_item: 'projects.read' };
export const WRITE_PERM: Record<string, Permission> = { company: 'crm.write', lead: 'crm.write', deal: 'deals.write', task: 'projects.read', project: 'projects.read', employee: 'people.write', intake_item: 'projects.read' };

/** Entity types whose files answer to a project's membership (assertEntityAccess). */
export const PROJECT_SCOPED = new Set(['project', 'task', 'intake_item']);

export function requireEntityPerm(perms: ReadonlySet<string>, map: Record<string, Permission>, entityType: string): void {
  const needed = map[entityType];
  if (!needed) throw err.validation('Unknown entity type');
  if (!perms.has(needed)) throw err.forbidden(`Requires ${needed}`, needed);
}

/**
 * A workspace-wide `projects.read` is not access to a *private* project, and
 * files are exactly what a private project keeps private. Anything hanging off
 * a project or one of its tasks is therefore membership-gated too, the same way
 * the project's own reads are (core/access).
 */
export async function assertEntityAccess(
  actor: Actor, entityType: string, entityId: string | null | undefined, minRole: 'viewer' | 'member' | 'admin',
): Promise<void> {
  if (!entityId) return;
  if (entityType === 'project') {
    await assertProject(actor, entityId, minRole);
    return;
  }
  if (entityType === 'task') {
    const { db } = getDb();
    const [task] = await db.select({ projectId: schema.tasks.projectId }).from(schema.tasks).where(eq(schema.tasks.id, entityId));
    if (!task) throw err.notFound('Task not found');
    await assertProject(actor, task.projectId, minRole);
  }
  if (entityType === 'intake_item') {
    const { db } = getDb();
    const [item] = await db.select({ projectId: schema.intakeItems.projectId }).from(schema.intakeItems).where(eq(schema.intakeItems.id, entityId));
    if (!item) throw err.notFound('Intake item not found');
    // The triage queue itself demands project membership; its files do too.
    await assertProject(actor, item.projectId, minRole === 'admin' ? 'admin' : 'member');
  }
}

export interface AttachmentRef {
  id: string;
  entityType: string | null;
  entityId: string | null;
  createdBy: string | null;
}

/** A refusal (403/404) read as "no"; anything else is a real failure. */
async function allowed(check: () => Promise<unknown>): Promise<boolean> {
  try {
    await check();
    return true;
  } catch (e) {
    if (e instanceof ApiException && (e.code === 'forbidden' || e.code === 'not_found')) return false;
    throw e;
  }
}

/** Whether a record the actor can read names this loose file. */
async function readableThroughRecord(actor: Actor, attachmentId: string): Promise<boolean> {
  const { db } = getDb();
  const perms = actor.access.permissions;

  const leaves = await db.select({ approverId: schema.leaveRequests.approverId, employeeUserId: schema.employees.userId })
    .from(schema.leaveRequests)
    .innerJoin(schema.employees, eq(schema.employees.id, schema.leaveRequests.employeeId))
    .where(eq(schema.leaveRequests.attachmentId, attachmentId));
  // The leave read rule (people/routes): HR, the employee, the approver.
  if (leaves.some((l) => perms.has('people.read') || l.employeeUserId === actor.userId || l.approverId === actor.userId)) return true;

  if (perms.has('finance.read')) {
    const [expense] = await db.select({ id: schema.expenses.id }).from(schema.expenses)
      .where(and(eq(schema.expenses.attachmentId, attachmentId), isNull(schema.expenses.deletedAt))).limit(1);
    if (expense) return true;
  }

  if (perms.has('people.recruit')) {
    const [applicant] = await db.select({ id: schema.applicants.id }).from(schema.applicants)
      .where(and(eq(schema.applicants.resumeAttachmentId, attachmentId), isNull(schema.applicants.deletedAt))).limit(1);
    if (applicant) return true;
  }

  // Filed before filing claimed the file for the employee's record.
  if (perms.has('people.read_documents')) {
    const [doc] = await db.select({ id: schema.employeeDocuments.id }).from(schema.employeeDocuments)
      .where(eq(schema.employeeDocuments.attachmentId, attachmentId)).limit(1);
    if (doc) return true;
  }

  // Only a pdf page shows its file (kb/service getPage).
  const pages = await db.select({ id: schema.kbPages.id }).from(schema.kbPages)
    .where(and(eq(schema.kbPages.fileId, attachmentId), eq(schema.kbPages.type, 'pdf')));
  for (const page of pages) {
    if (await allowed(() => getPage(actor, page.id, false))) return true;
  }
  return false;
}

/** Whether the actor may open this file by its id, outside any document. */
export async function canReadAttachment(actor: Actor, att: AttachmentRef): Promise<boolean> {
  if (att.entityType) {
    const needed = READ_PERM[att.entityType];
    if (!needed || !actor.access.permissions.has(needed)) return false;
    return allowed(() => assertEntityAccess(actor, att.entityType!, att.entityId, 'viewer'));
  }
  if (att.createdBy && att.createdBy === actor.userId) return true;
  return readableThroughRecord(actor, att.id);
}

/**
 * The file a record is about to name (a leave request's certificate, an
 * expense's receipt, an applicant's CV). Whoever can read the record can then
 * open the file, so it may only be the caller's own upload that hangs off
 * nothing yet – or the file the record already names. Any attachment id used
 * to do: someone else's contract, named on one's own expense, opened for one.
 */
export async function assertAttachable(
  actor: Actor | null, attachmentId: string | null | undefined, current?: string | null,
): Promise<void> {
  if (!attachmentId || attachmentId === current) return;
  const { db } = getDb();
  const [att] = await db.select({ entityType: schema.attachments.entityType, createdBy: schema.attachments.createdBy })
    .from(schema.attachments).where(eq(schema.attachments.id, attachmentId));
  // One answer for every refusal, so ids cannot be probed for existence.
  if (!att || att.entityType || !actor || att.createdBy !== actor.userId) {
    throw err.validation('Unknown attachment: upload the file first');
  }
}
