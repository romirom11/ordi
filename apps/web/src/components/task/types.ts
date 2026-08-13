/** Shared types for the full task page (Linear-style). */

export interface TaskAssignee {
  userId: string;
  name: string;
  email?: string;
}

export interface TaskLabel {
  id: string;
  name: string;
  color: string;
}

export interface TaskComment {
  id: string;
  authorId?: string | null;
  authorName?: string | null;
  body: unknown;
  createdAt: string;
}

export interface TaskDetail {
  id: string;
  projectId: string;
  number: number;
  title: string;
  description: unknown | null;
  statusId: string;
  typeId: string | null;
  priority: string;
  parentId: string | null;
  milestoneId: string | null;
  dueDate: string | null;
  startDate: string | null;
  estimate: string | number | null;
  cycleId: string | null;
  version: number;
  ref?: string;
  createdAt: string;
  updatedAt: string;
  assignees: TaskAssignee[];
  labels: TaskLabel[];
  comments: TaskComment[];
  gitLinks?: TaskGitLink[];
  customFields?: Record<string, unknown>;
}

export interface TaskGitLink {
  id: string;
  type: string; // branch | commit | pr | mr
  externalRef: string;
  title?: string | null;
  url?: string | null;
  state?: string | null; // open | merged | closed
}

export interface TaskStatus {
  id: string;
  name: string;
  category: string;
  color: string;
  position: number;
  isDefault?: boolean;
}

export interface UserLite {
  id: string;
  name: string;
  avatar?: string | null;
}

export interface SubtaskRow {
  id: string;
  title: string;
  parentId: string | null;
  statusId: string;
  priority?: string;
  number?: number;
  version: number;
}

export interface AuditEntry {
  id: string;
  action: string;
  actorId?: string | null;
  actorType?: string;
  createdAt: string;
}

/** Fields PATCHable on /tasks/:id (version is appended by the mutation). */
export interface TaskPatch {
  title?: string;
  description?: unknown;
  statusId?: string;
  priority?: string;
  dueDate?: string | null;
  startDate?: string | null;
  estimate?: number | null;
  assigneeIds?: string[];
  labelIds?: string[];
  parentId?: string | null;
  milestoneId?: string | null;
  customFields?: Record<string, unknown>;
}

/** A project milestone as the task sidebar needs it. */
export interface MilestoneLite {
  id: string;
  name: string;
  done: boolean;
  targetDate?: string | null;
}
