/**
 * `orderTasks` used to sort on one key and leave ties to `Array#sort`
 * stability, i.e. to the order `/tasks` sent — newest first. A plan typed out
 * as "step 1 … step 10" therefore rendered 10…1 inside every priority band,
 * which is what these cases pin down: each ordering must end on the sequence
 * the tasks were written in, and must invert cleanly.
 */
import { describe, expect, it } from 'vitest';
import { orderTasks } from './taskViewPrefs';

interface T {
  title: string;
  priority?: string;
  dueDate?: string | null;
  createdAt?: string;
  position?: string | number | null;
  number?: number;
}

/** Tasks as the API sends them: newest first. */
function batch(...specs: T[]): T[] {
  return specs.slice().reverse();
}

const titles = (list: T[]) => list.map((x) => x.title);

const step = (n: number, extra: Partial<T> = {}): T => ({
  title: `Step ${n}`,
  number: n,
  position: String(n * 1000),
  createdAt: `2026-07-0${n}T00:00:00.000Z`,
  ...extra,
});

describe('orderTasks', () => {
  it('keeps a same-priority band in the order it was written', () => {
    const tasks = batch(step(1, { priority: 'high' }), step(2, { priority: 'high' }), step(3, { priority: 'high' }));
    expect(titles(orderTasks(tasks, 'priority'))).toEqual(['Step 1', 'Step 2', 'Step 3']);
  });

  it('still ranks priority above the sequence', () => {
    const tasks = batch(step(1, { priority: 'low' }), step(2, { priority: 'urgent' }), step(3, { priority: 'high' }));
    expect(titles(orderTasks(tasks, 'priority'))).toEqual(['Step 2', 'Step 3', 'Step 1']);
  });

  it('falls back to number, then createdAt, when position ties', () => {
    const tasks = batch(
      { title: 'a', position: '1000', number: 1 },
      { title: 'b', position: '1000', number: 2 },
      { title: 'c', position: '1000', number: 3 },
    );
    expect(titles(orderTasks(tasks, 'priority'))).toEqual(['a', 'b', 'c']);

    const undated = batch(
      { title: 'a', createdAt: '2026-07-01T00:00:00.000Z' },
      { title: 'b', createdAt: '2026-07-02T00:00:00.000Z' },
    );
    expect(titles(orderTasks(undated, 'priority'))).toEqual(['a', 'b']);
  });

  it('does not read a null position as zero', () => {
    const tasks = batch(
      { title: 'first', position: null, number: 1 },
      { title: 'second', position: null, number: 2 },
    );
    expect(titles(orderTasks(tasks, 'priority'))).toEqual(['first', 'second']);
  });

  it('sorts titles numerically', () => {
    const tasks = batch({ title: 'Plugin 2' }, { title: 'Plugin 10' }, { title: 'Plugin 1' });
    expect(titles(orderTasks(tasks, 'title'))).toEqual(['Plugin 1', 'Plugin 2', 'Plugin 10']);
  });

  it('orders by due date and sinks tasks without one in both directions', () => {
    const tasks = batch(
      { title: 'soon', dueDate: '2026-08-01', number: 1 },
      { title: 'later', dueDate: '2026-09-01', number: 2 },
      { title: 'undated', dueDate: null, number: 3 },
    );
    expect(titles(orderTasks(tasks, 'dueDate'))).toEqual(['soon', 'later', 'undated']);
    expect(titles(orderTasks(tasks, 'dueDate', 'desc'))).toEqual(['later', 'soon', 'undated']);
  });

  it('runs created oldest-first, and newest-first when reversed', () => {
    const tasks = batch(step(1), step(2), step(3));
    expect(titles(orderTasks(tasks, 'created'))).toEqual(['Step 1', 'Step 2', 'Step 3']);
    expect(titles(orderTasks(tasks, 'created', 'desc'))).toEqual(['Step 3', 'Step 2', 'Step 1']);
  });

  it('reverses the tie-break along with the key', () => {
    const tasks = batch(step(1, { priority: 'high' }), step(2, { priority: 'high' }), step(3, { priority: 'low' }));
    expect(titles(orderTasks(tasks, 'priority', 'desc'))).toEqual(['Step 3', 'Step 2', 'Step 1']);
  });

  it('leaves the input array alone', () => {
    const tasks = [step(3), step(1), step(2)];
    orderTasks(tasks, 'priority');
    expect(titles(tasks)).toEqual(['Step 3', 'Step 1', 'Step 2']);
  });
});
