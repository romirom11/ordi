/**
 * fmtRelative is the only formatter the CRM uses for the due date of planned
 * work, so its handling of future instants is load-bearing: it once returned
 * "now" for every one of them, which made a follow-up due next week and one due
 * this minute read identically in the Work queue.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { fmtRelative } from './ui';

const NOW = new Date('2026-07-29T12:00:00.000Z');

function at(offsetMs: number): string {
  return new Date(NOW.getTime() + offsetMs).toISOString();
}

function freeze() {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('fmtRelative', () => {
  it('reads a past instant bare, as an activity feed expects', () => {
    freeze();
    expect(fmtRelative(at(-30 * 60_000))).toBe('30m');
    expect(fmtRelative(at(-3 * 3_600_000))).toBe('3h');
    expect(fmtRelative(at(-2 * 86_400_000))).toBe('2d');
  });

  it('marks a future instant instead of collapsing it to "now"', () => {
    freeze();
    expect(fmtRelative(at(30 * 60_000))).toBe('in 30m');
    expect(fmtRelative(at(3 * 3_600_000))).toBe('in 3h');
    expect(fmtRelative(at(86_400_000))).toBe('in 1d');
    expect(fmtRelative(at(5 * 86_400_000))).toBe('in 5d');
  });

  it('keeps "now" for the present in either direction', () => {
    freeze();
    expect(fmtRelative(at(0))).toBe('now');
    expect(fmtRelative(at(-20_000))).toBe('now');
    expect(fmtRelative(at(20_000))).toBe('now');
  });

  it('falls back to an absolute date beyond a month, future included', () => {
    freeze();
    expect(fmtRelative(at(60 * 86_400_000))).not.toContain('in ');
    expect(fmtRelative(at(-60 * 86_400_000))).not.toContain('in ');
  });

  it('renders nothing for a missing value', () => {
    expect(fmtRelative(null)).toBe('');
    expect(fmtRelative(undefined)).toBe('');
  });
});
