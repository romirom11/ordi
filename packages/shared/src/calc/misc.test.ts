import { describe, it, expect } from 'vitest';
import { parseTaskRefs, buildBranchName } from './git-mentions';
import { buildRedactedDiff } from './redaction';
import { leaveDays, availableBalance, carryForward, rangesOverlap } from './leave';
import { computeAging } from './aging';
import { positionBetween } from './fractional';

describe('parseTaskRefs', () => {
  it('extracts KEY-N refs, deduped', () => {
    const refs = parseTaskRefs('Fix KLD-42 and KLD-42 also APR-7');
    expect(refs.map((r) => r.raw).sort()).toEqual(['APR-7', 'KLD-42']);
  });
  it('ignores lowercase / non-matching', () => {
    expect(parseTaskRefs('branch feature-42 no ref')).toEqual([]);
    expect(parseTaskRefs('encoded as utf-8 today')).toEqual([]);
  });
  it('anyCase matches our own lowercase branch convention and uppercases the key', () => {
    const refs = parseTaskRefs('feature/kld-42-add-login-flow', { anyCase: true });
    expect(refs).toEqual([{ key: 'KLD', number: 42, raw: 'kld-42' }]);
    // Long words before a number still do not become refs (no word boundary mid-word).
    expect(parseTaskRefs('branch feature-42 no ref', { anyCase: true })).toEqual([]);
  });
});

describe('buildBranchName', () => {
  it('builds slugged branch name', () => {
    expect(buildBranchName({ key: 'KLD', number: 42, title: 'Add Login Flow!' })).toBe('feature/kld-42-add-login-flow');
  });
});

describe('buildRedactedDiff', () => {
  it('redacts sensitive value but records fact', () => {
    const { diff, sensitivity } = buildRedactedDiff({ amount: 3000 }, { amount: 4000 }, 'compensation');
    expect(diff.amount).toEqual({ action: 'changed' });
    expect(sensitivity).toBe('sensitive');
  });
  it('omits secrets entirely', () => {
    const { diff } = buildRedactedDiff({ hash: 'a', name: 'x' }, { hash: 'b', name: 'y' });
    expect(diff.hash).toBeUndefined();
    expect(diff.name).toEqual({ from: 'x', to: 'y' });
  });
});

describe('leave calc', () => {
  it('counts working days', () => {
    // 2024-07-01 Mon .. 2024-07-05 Fri = 5 days
    expect(leaveDays('2024-07-01', '2024-07-05', false)).toBe(5);
  });
  it('half day', () => {
    expect(leaveDays('2024-07-01', '2024-07-01', true)).toBe(0.5);
  });
  it('available balance', () => {
    expect(availableBalance({ allocated: 20, used: 5, carried: 3 })).toBe(18);
  });
  it('carry-forward capped', () => {
    expect(carryForward(10, 5)).toBe(5);
  });
  it('overlap detection', () => {
    expect(rangesOverlap('2024-07-01', '2024-07-05', '2024-07-04', '2024-07-10')).toBe(true);
    expect(rangesOverlap('2024-07-01', '2024-07-05', '2024-07-06', '2024-07-10')).toBe(false);
  });
});

describe('computeAging', () => {
  it('buckets by days overdue', () => {
    const rows = computeAging([
      { currency: 'USD', outstanding: 100, dueDate: '2024-07-01' }, // 0-30 wrt 2024-07-10
      { currency: 'USD', outstanding: 200, dueDate: '2024-05-01' }, // 61-90
    ], '2024-07-10');
    const usd = rows.find((r) => r.currency === 'USD')!;
    expect(usd.bucket_0_30).toBe(100);
    expect(usd.bucket_61_90).toBe(200);
    expect(usd.total).toBe(300);
  });
});

describe('positionBetween', () => {
  it('midpoint', () => {
    expect(positionBetween(1000, 2000)).toBe(1500);
    expect(positionBetween(null, null)).toBe(1000);
  });
});
