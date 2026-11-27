/**
 * POST /tasks/bulk takes at most BULK_TASK_LIMIT tasks, each request all or
 * nothing. A larger selection goes out in parts of that size, one after the
 * other; the first part the API refuses stops the rest and its error is
 * thrown. The parts before it stay saved, so a caller refreshes its tasks on
 * an error as well as on success.
 */
import { BULK_TASK_LIMIT } from '@ordi/shared';

export type BulkTaskEdit = { taskIds: string[] } & Record<string, unknown>;

export function bulkTaskParts(taskIds: string[], size = BULK_TASK_LIMIT): string[][] {
  const parts: string[][] = [];
  for (let i = 0; i < taskIds.length; i += size) parts.push(taskIds.slice(i, i + size));
  return parts;
}

export async function sendBulkTaskEdit(
  edit: BulkTaskEdit,
  post: (body: BulkTaskEdit) => Promise<{ updated: number }>,
): Promise<{ updated: number }> {
  let updated = 0;
  for (const taskIds of bulkTaskParts(edit.taskIds)) {
    updated += (await post({ ...edit, taskIds })).updated;
  }
  return { updated };
}
