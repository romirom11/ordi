/**
 * Every way into a DateField – typing, the grid, Today, Clear – goes through
 * these two functions. The regressions they guard: a due date typed (or set
 * with Today) before the issue date was accepted although the grid greyed the
 * same day out, and unparseable text was dropped without a word.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkDay, readTypedDay } from './dateBounds';

// parseTyped reads the preferred format from localStorage; node has none.
const store = new Map<string, string>();
beforeEach(() => {
  (globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  } as Storage;
  store.set('ordi:dateFormat', 'dd.MM.yyyy');
});
afterEach(() => store.clear());

describe('checkDay', () => {
  it('accepts the bounds themselves – they are inclusive', () => {
    expect(checkDay('2026-10-01', { min: '2026-10-01', max: '2026-10-31' })).toBeNull();
    expect(checkDay('2026-10-31', { min: '2026-10-01', max: '2026-10-31' })).toBeNull();
  });

  it('names the side a day falls off', () => {
    expect(checkDay('2026-09-30', { min: '2026-10-01' })).toBe('beforeMin');
    expect(checkDay('2026-11-01', { max: '2026-10-31' })).toBe('afterMax');
  });

  it('treats an empty value as an error only when the field is required', () => {
    expect(checkDay(null, { required: true })).toBe('required');
    expect(checkDay('', { required: true })).toBe('required');
    expect(checkDay(null, {})).toBeNull();
    // A bound alone does not make the field required (an optional due date).
    expect(checkDay(null, { min: '2026-10-01' })).toBeNull();
  });

  it('compares the day of a full timestamp, not the clock', () => {
    expect(checkDay('2026-10-01T23:59:00', { max: '2026-10-01' })).toBeNull();
  });
});

describe('readTypedDay', () => {
  it('turns text in the active format into a day value', () => {
    expect(readTypedDay('05.10.2026', {})).toEqual({ ok: true, value: '2026-10-05' });
    expect(readTypedDay(' 2026-10-05 ', {})).toEqual({ ok: true, value: '2026-10-05' });
  });

  it('rejects a typed day outside the bounds, the same days the grid disables', () => {
    expect(readTypedDay('30.09.2026', { min: '2026-10-01' })).toEqual({ ok: false, problem: 'beforeMin' });
    expect(readTypedDay('01.11.2026', { max: '2026-10-31' })).toEqual({ ok: false, problem: 'afterMax' });
  });

  it('reports unparseable text instead of silently discarding it', () => {
    expect(readTypedDay('next friday', {})).toEqual({ ok: false, problem: 'format' });
    expect(readTypedDay('31.02.2026', {})).toEqual({ ok: false, problem: 'format' });
  });

  it('lets empty text clear an optional field but not a required one', () => {
    expect(readTypedDay('   ', {})).toEqual({ ok: true, value: null });
    expect(readTypedDay('', { required: true })).toEqual({ ok: false, problem: 'required' });
  });
});
