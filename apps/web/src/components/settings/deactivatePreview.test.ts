import { describe, it, expect } from 'vitest';
import { hiddenTasksKey, previewTail } from './deactivatePreview';

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

describe('previewTail', () => {
  it('marks visible tasks cut off by the page, then the hidden ones', () => {
    // 21 visible (20 listed) and 1 hidden.
    expect(previewTail({ count: 22, hiddenCount: 1, listed: 20 }, 'en'))
      .toEqual({ truncated: true, hiddenKey: 'settings.hiddenTasksMore.one' });
  });

  it('shows no ellipsis when every visible task is listed', () => {
    expect(previewTail({ count: 21, hiddenCount: 1, listed: 20 }, 'en'))
      .toEqual({ truncated: false, hiddenKey: 'settings.hiddenTasksMore.one' });
  });

  it('has no hidden line when nothing is hidden, and stands alone when everything is', () => {
    expect(previewTail({ count: 2, hiddenCount: 0, listed: 2 }, 'en')).toEqual({ truncated: false, hiddenKey: null });
    expect(previewTail({ count: 5, hiddenCount: 5, listed: 0 }, 'uk'))
      .toEqual({ truncated: false, hiddenKey: 'settings.hiddenTasksOnly.many' });
  });
});
