import { describe, it, expect } from 'vitest';
import { BULK_TASK_LIMIT } from '@ordi/shared';
import { bulkTaskParts, sendBulkTaskEdit, type BulkTaskEdit } from './bulkTasks';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`);

describe('a bulk task edit larger than the API takes at once', () => {
  it('goes out in parts of at most BULK_TASK_LIMIT, in order, none empty', () => {
    expect(bulkTaskParts(ids(3), 2)).toEqual([['t0', 't1'], ['t2']]);
    expect(bulkTaskParts([])).toEqual([]);
    const parts = bulkTaskParts(ids(BULK_TASK_LIMIT * 2 + 1));
    expect(parts.map((p) => p.length)).toEqual([BULK_TASK_LIMIT, BULK_TASK_LIMIT, 1]);
    expect(parts.flat()).toEqual(ids(BULK_TASK_LIMIT * 2 + 1));
  });

  it('sends one request for a selection within the limit, with the same fields', async () => {
    const sent: BulkTaskEdit[] = [];
    const res = await sendBulkTaskEdit({ taskIds: ids(BULK_TASK_LIMIT), priority: 'high' }, async (b) => { sent.push(b); return { updated: b.taskIds.length }; });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ taskIds: ids(BULK_TASK_LIMIT), priority: 'high' });
    expect(res.updated).toBe(BULK_TASK_LIMIT);
  });

  it('adds up what each part updated, and stops at the first part refused', async () => {
    const sent: BulkTaskEdit[] = [];
    const total = await sendBulkTaskEdit({ taskIds: ids(BULK_TASK_LIMIT + 2), statusId: 's' }, async (b) => { sent.push(b); return { updated: b.taskIds.length - 1 }; });
    expect(sent.map((b) => b.taskIds.length)).toEqual([BULK_TASK_LIMIT, 2]);
    expect(sent.every((b) => b.statusId === 's')).toBe(true);
    expect(total.updated).toBe(BULK_TASK_LIMIT);

    let calls = 0;
    await expect(sendBulkTaskEdit({ taskIds: ids(BULK_TASK_LIMIT * 3) }, async () => {
      calls++;
      if (calls === 2) throw new Error('refused');
      return { updated: BULK_TASK_LIMIT };
    })).rejects.toThrow('refused');
    expect(calls).toBe(2);
  });
});
