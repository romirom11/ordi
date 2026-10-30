import { describe, it, expect } from 'vitest';
import { addMonthsIso } from './dates';

describe('addMonthsIso', () => {
  it('clamps to the last day of a shorter month instead of rolling over', () => {
    expect(addMonthsIso('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonthsIso('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonthsIso('2026-03-31', 1)).toBe('2026-04-30');
    expect(addMonthsIso('2026-11-30', 3)).toBe('2027-02-28');
    expect(addMonthsIso('2028-02-29', 12)).toBe('2029-02-28');
  });
  it('leaves ordinary days alone, across year ends too', () => {
    expect(addMonthsIso('2026-01-15', 1)).toBe('2026-02-15');
    expect(addMonthsIso('2026-12-31', 1)).toBe('2027-01-31');
    expect(addMonthsIso('2026-10-30', -1)).toBe('2026-09-30');
  });
});
