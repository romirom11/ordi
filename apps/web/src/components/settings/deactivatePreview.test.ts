import { describe, it, expect } from 'vitest';
import { hiddenTasksKey } from './deactivatePreview';

describe('hiddenTasksKey', () => {
  it('adds to a visible list, or stands alone when nothing is listed', () => {
    expect(hiddenTasksKey(3, 2, 'en')).toBe('settings.hiddenTasksMore.other');
    expect(hiddenTasksKey(3, 0, 'en')).toBe('settings.hiddenTasksOnly.other');
  });

  it('picks the plural form for the locale', () => {
    expect([1, 2, 21].map((n) => hiddenTasksKey(n, 1, 'en'))).toEqual([
      'settings.hiddenTasksMore.one', 'settings.hiddenTasksMore.other', 'settings.hiddenTasksMore.other',
    ]);
    expect([1, 3, 5, 11, 21, 24].map((n) => hiddenTasksKey(n, 0, 'uk'))).toEqual([
      'settings.hiddenTasksOnly.one', 'settings.hiddenTasksOnly.few', 'settings.hiddenTasksOnly.many',
      'settings.hiddenTasksOnly.many', 'settings.hiddenTasksOnly.one', 'settings.hiddenTasksOnly.few',
    ]);
  });
});
