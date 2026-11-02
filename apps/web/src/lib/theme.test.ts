import { afterEach, describe, expect, it, vi } from 'vitest';
import { getStoredStyle, getStoredTheme } from './theme';

afterEach(() => vi.unstubAllGlobals());

describe('initial appearance preference', () => {
  it('starts dark on a new installation or invalid stored value', () => {
    for (const value of [null, 'invalid']) {
      vi.stubGlobal('localStorage', { getItem: () => value });
      expect(getStoredTheme()).toBe('dark');
    }
  });
  it('preserves an explicit preference', () => {
    for (const value of ['light', 'dark', 'system']) {
      vi.stubGlobal('localStorage', { getItem: () => value });
      expect(getStoredTheme()).toBe(value);
    }
  });
  it('starts dark when browser storage is unavailable', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('unavailable'); } });
    expect(getStoredTheme()).toBe('dark');
  });
});

describe('initial surface style', () => {
  it('starts on glass on a new installation, invalid value or unavailable storage', () => {
    for (const value of [null, 'invalid']) {
      vi.stubGlobal('localStorage', { getItem: () => value });
      expect(getStoredStyle()).toBe('glass');
    }
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('unavailable'); } });
    expect(getStoredStyle()).toBe('glass');
  });
  it('preserves an explicit choice', () => {
    for (const value of ['classic', 'glass']) {
      vi.stubGlobal('localStorage', { getItem: () => value });
      expect(getStoredStyle()).toBe(value);
    }
  });
});
