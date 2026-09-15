/**
 * Git links on tasks (PRD §13.1): the branches, commits and pull requests a
 * task is known by, one row per (task, type, external ref). The incoming git
 * webhook is the one writer, for a person's push and an agent's alike: it
 * finds task refs in what the forge sends and syncs the row with it. A pull
 * request's state moves (open → merged / closed) and its title can be
 * edited, so an existing pull request row takes what the forge just said; a
 * branch or a commit is what it is.
 */
import { getDb, schema, eq, and } from '@ordi/db';
import { ulid } from 'ulid';

export type GitLinkType = 'branch' | 'commit' | 'pr' | 'mr';

export interface GitLinkInput {
  taskId: string;
  repositoryId: string | null;
  type: GitLinkType;
  /** What the forge calls it: branch name, commit sha, pull request number. */
  externalRef: string;
  title?: string | null;
  url?: string | null;
  /** open | merged | closed, for pull requests. */
  state?: string | null;
  author?: string | null;
}

export interface GitLinkResult {
  id: string;
  /** No row existed for this ref on this task before the call. */
  created: boolean;
  /** The state the row had before the call; null for a new row or a stateless type. */
  previousState: string | null;
}

const { gitLinks } = schema;

async function findGitLink(input: Pick<GitLinkInput, 'taskId' | 'type' | 'externalRef'>) {
  const { db } = getDb();
  const [row] = await db.select({ id: gitLinks.id, state: gitLinks.state })
    .from(gitLinks)
    .where(and(eq(gitLinks.taskId, input.taskId), eq(gitLinks.type, input.type), eq(gitLinks.externalRef, input.externalRef)));
  return row;
}

/**
 * Record the link, or bring an existing pull request up to date with what the
 * forge just said. Two deliveries naming the same ref can land at the same
 * moment; the unique (task, type, ref) index decides, and the loser takes the
 * winner's row.
 */
export async function syncGitLink(input: GitLinkInput): Promise<GitLinkResult> {
  const { db } = getDb();
  const existing = await findGitLink(input);
  if (!existing) {
    const inserted = await db.insert(gitLinks).values({
      id: ulid(), taskId: input.taskId, repositoryId: input.repositoryId, type: input.type, externalRef: input.externalRef,
      title: input.title ?? null, url: input.url ?? null, state: input.state ?? null, author: input.author ?? null,
    }).onConflictDoNothing().returning({ id: gitLinks.id });
    if (inserted[0]) return { id: inserted[0].id, created: true, previousState: null };
  }
  const row = existing ?? (await findGitLink(input))!;
  if (input.type === 'pr' || input.type === 'mr') {
    await db.update(gitLinks)
      .set({ state: input.state ?? null, title: input.title ?? null, url: input.url ?? null, updatedAt: new Date() })
      .where(eq(gitLinks.id, row.id));
  }
  return { id: row.id, created: false, previousState: row.state };
}
