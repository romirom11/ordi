/**
 * fmtRelative is the only formatter the CRM uses for the due date of planned
 * work, so its handling of future instants is load-bearing: it once returned
 * "now" for every one of them, which made a follow-up due next week and one due
 * this minute read identically in the Work queue.
 *
 * Wording comes from Intl, so the assertions check direction and magnitude
 * rather than exact strings — the point is that past and future differ.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { fmtDate, fmtRelative } from './ui';

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
  it('carries the magnitude and unit of a past instant', () => {
    freeze();
    expect(fmtRelative(at(-30 * 60_000))).toMatch(/30/);
    expect(fmtRelative(at(-3 * 3_600_000))).toMatch(/3/);
    expect(fmtRelative(at(-2 * 86_400_000))).toMatch(/2/);
  });

  it('distinguishes a future instant from a past one of the same size', () => {
    freeze();
    // The regression this guards: every future instant used to render as "now",
    // so a follow-up due in five days read the same as one due this minute.
    for (const ms of [30 * 60_000, 3 * 3_600_000, 86_400_000, 5 * 86_400_000]) {
      const ahead = fmtRelative(at(ms));
      expect(ahead).not.toBe(fmtRelative(at(0)));
      expect(ahead).not.toBe(fmtRelative(at(-ms)));
    }
  });

  it('reads the present as the present in either direction', () => {
    freeze();
    const present = fmtRelative(at(0));
    expect(fmtRelative(at(-20_000))).toBe(present);
    expect(fmtRelative(at(20_000))).toBe(present);
  });

  it('falls back to an absolute date beyond a month, future included', () => {
    freeze();
    expect(fmtRelative(at(60 * 86_400_000))).toBe(fmtDate(at(60 * 86_400_000)));
    expect(fmtRelative(at(-60 * 86_400_000))).toBe(fmtDate(at(-60 * 86_400_000)));
  });

  it('renders nothing for a missing value', () => {
    expect(fmtRelative(null)).toBe('');
    expect(fmtRelative(undefined)).toBe('');
  });
});
