import { expect, it } from 'vitest';
import { createDraftStore } from './draftStorage';

function device(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
    clear: () => values.clear(),
  };
}

it('restores after reload or desktop relaunch without mixing two windows', () => {
  const disk = device();
  createDraftStore(() => disk, 'desktop').setItem('ordi:draft:u:page:1', 'Desktop work');
  createDraftStore(() => disk, 'browser-b').setItem('ordi:draft:u:page:1', 'Other window');
  expect(createDraftStore(() => disk, 'desktop').getItem('ordi:draft:u:page:1')).toBe('Desktop work');
  expect(createDraftStore(() => disk, 'browser-b').getItem('ordi:draft:u:page:1')).toBe('Other window');
});

it('expires old windows after thirty days without touching other preferences', () => {
  const disk = device();
  disk.setItem('ordi:theme', 'dark');
  createDraftStore(() => disk, 'closed-window', () => 1000).setItem('ordi:draft:u:page:1', 'Expired work');
  createDraftStore(() => disk, 'new-window', () => 1000 + 31 * 86400_000);
  expect(disk.length).toBe(1);
  expect(disk.getItem('ordi:theme')).toBe('dark');
});

it('retains a memory copy when the device write fails but reports the failure', () => {
  const store = createDraftStore(() => null, 'window');
  expect(() => store.setItem('draft', 'Unsaved work')).toThrow('draft storage unavailable');
  expect(store.getItem('draft')).toBe('Unsaved work');
});
