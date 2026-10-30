import { describe, expect, it } from 'vitest';
import { timerElapsedAt, type ActiveTimer } from './timer';

const timer: ActiveTimer = { taskId: 't1', startedAt: '2026-10-30T03:16:58Z', elapsedSeconds: 0 };

describe('timer elapsed time', () => {
  it('starts at zero even after the shell has been idle', () => {
    expect(timerElapsedAt(timer, 600_000, 600_000)).toBe(0);
    expect(timerElapsedAt(timer, 600_000, 608_999)).toBe(8);
  });

  it('does not count elapsed time twice after each server poll', () => {
    expect(timerElapsedAt({ ...timer, elapsedSeconds: 30 }, 630_000, 631_000)).toBe(31);
    expect(timerElapsedAt({ ...timer, elapsedSeconds: 60 }, 660_000, 661_000)).toBe(61);
  });

  it('catches up after a suspended browser without depending on tick count', () => {
    expect(timerElapsedAt({ ...timer, elapsedSeconds: 60 }, 660_000, 755_000)).toBe(155);
  });

  it('resets for the next timer and never subtracts time after a clock change', () => {
    expect(timerElapsedAt(timer, 900_000, 900_000)).toBe(0);
    expect(timerElapsedAt({ ...timer, elapsedSeconds: 30 }, 900_000, 899_000)).toBe(30);
    expect(timerElapsedAt(null, 900_000, 950_000)).toBe(0);
  });
});
