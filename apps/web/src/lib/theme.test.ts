import { afterEach, describe, expect, it, vi } from 'vitest';
import { getStoredTheme } from './theme';

afterEach(() => vi.unstubAllGlobals());

describe('initial appearance preference', () => {
  it('follows the system on a new installation or invalid stored value', () => {
    for (const value of [null, 'invalid']) {
      vi.stubGlobal('localStorage', { getItem: () => value });
      expect(getStoredTheme()).toBe('system');
    }
  });
  it('preserves an explicit preference', () => {
    for (const value of ['light', 'dark', 'system']) {
      vi.stubGlobal('localStorage', { getItem: () => value });
      expect(getStoredTheme()).toBe(value);
    }
  });
  it('follows the system when browser storage is unavailable', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('unavailable'); } });
    expect(getStoredTheme()).toBe('system');
  });
});
