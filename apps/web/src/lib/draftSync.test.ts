/**
 * The draft rules behind the task description and KB page editors. Each case
 * is a way typed text used to disappear: a refused write that left nothing
 * behind the text on screen, a 409 that swapped the draft for the server's
 * copy, an edit made while a save was in flight that was then counted as
 * saved, and a draft that leaked between pages or vanished on navigation.
 */
import { describe, expect, it } from 'vitest';
import {
  ack, begin, conflictKeys, discardAll, draftStorageKey, edit, fail, initDraft, keepMine,
  readStoredDraft, receiveServer, sameValue, syncStatus, takeTheirs, writeStoredDraft, type DraftStore,
} from './draftSync';

type Page = { title: string; body: unknown };

const doc = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

function memoryStore(): DraftStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => { data.set(k, v); },
    removeItem: (k) => { data.delete(k); },
  };
}

const server1: Page = { title: 'Handbook', body: doc('v1') };

describe('a failed write', () => {
  it('keeps the draft, reports it, and a retry resends the current text', () => {
    let s = edit(initDraft(server1, 1), { body: doc('mine') });
    const first = begin(s)!;
    expect(first.payload).toEqual({ body: doc('mine') });
    s = fail(first.state, false);
    expect(s.draft.body).toEqual(doc('mine'));
    expect(syncStatus(s)).toBe('failed');
    // The background save does not hammer a failing server…
    expect(begin(s)).toBeNull();
    // …the explicit Retry sends what is on screen now, not what was dispatched.
    s = edit(s, { body: doc('mine, more') });
    const retry = begin(s, { force: true })!;
    expect(retry.payload).toEqual({ body: doc('mine, more') });
    expect(retry.version).toBe(1);
    s = ack(retry.state, { title: 'Handbook', body: doc('mine, more') }, 2);
    expect(syncStatus(s)).toBe('saved');
  });
});

describe('editing while a save is in flight', () => {
  it('keeps a newer realtime snapshot when an older write response lands later', () => {
    const started = begin(edit(initDraft(server1, 1), { body: doc('mine') }))!;
    let s = receiveServer(started.state, { title: 'Renamed remotely', body: doc('remote v3') }, 3);
    s = ack(s, { title: 'Handbook', body: doc('mine') }, 2);
    expect(s.version).toBe(3);
    expect(s.draft.title).toBe('Renamed remotely');
    expect(s.server.body).toEqual(doc('remote v3'));
    expect(s.draft.body).toEqual(doc('remote v3'));
    expect(receiveServer(s, server1, 1)).toBe(s);
  });
  it('keeps the newer text unsaved instead of treating the dispatch as saved', () => {
    let s = edit(initDraft(server1, 1), { body: doc('a') });
    const w = begin(s)!;
    s = edit(w.state, { body: doc('ab') });
    // No second write while the first one is out – it needs the new version.
    expect(begin(s)).toBeNull();
    s = ack(s, { title: 'Handbook', body: doc('a') }, 2);
    expect(s.draft.body).toEqual(doc('ab'));
    expect(syncStatus(s)).toBe('unsaved');
    const next = begin(s)!;
    expect(next.payload).toEqual({ body: doc('ab') });
    expect(next.version).toBe(2);
  });
});

describe('a conflict', () => {
  it('keeps the draft on screen when the server changed the same field', () => {
    let s = edit(initDraft(server1, 1), { body: doc('mine') });
    s = fail(begin(s)!.state, true);
    expect(syncStatus(s)).toBe('saving'); // waiting for the latest version
    s = receiveServer(s, { title: 'Handbook', body: doc('theirs') }, 2);
    expect(s.draft.body).toEqual(doc('mine'));
    expect(s.server.body).toEqual(doc('theirs'));
    expect(conflictKeys(s)).toEqual(['body']);
    expect(syncStatus(s)).toBe('conflict');
    // Nothing goes out on its own – not even with the fresh version.
    expect(begin(s)).toBeNull();
    expect(begin(s, { force: true })).toBeNull();
  });

  it('keep mine overwrites deliberately, with the latest version', () => {
    let s = edit(initDraft(server1, 1), { body: doc('mine') });
    s = receiveServer(s, { title: 'Handbook', body: doc('theirs') }, 2);
    s = keepMine(s);
    const w = begin(s)!;
    expect(w.payload).toEqual({ body: doc('mine') });
    expect(w.version).toBe(2);
  });

  it('take theirs drops only the conflicting field', () => {
    let s = edit(initDraft(server1, 1), { title: 'Handbook 2', body: doc('mine') });
    s = receiveServer(s, { title: 'Handbook', body: doc('theirs') }, 2);
    s = takeTheirs(s);
    expect(s.draft).toEqual({ title: 'Handbook 2', body: doc('theirs') });
    expect(begin(s)!.payload).toEqual({ title: 'Handbook 2' });
  });

  it('is no conflict when the server only changed a field nobody here touched', () => {
    let s = edit(initDraft({ title: 'T', body: doc('v1') }, 1), { body: doc('mine') });
    s = fail(begin(s)!.state, true);
    s = receiveServer(s, { title: 'T renamed', body: doc('v1') }, 2);
    expect(conflictKeys(s)).toEqual([]);
    expect(s.draft).toEqual({ title: 'T renamed', body: doc('mine') });
    expect(begin(s)!.version).toBe(2);
  });

  it('ignores jsonb key order when comparing documents', () => {
    const reordered = { content: [{ content: [{ text: 'v1', type: 'text' }], type: 'paragraph' }], type: 'doc' };
    expect(sameValue(doc('v1'), reordered)).toBe(true);
    let s = edit(initDraft(server1, 1), { title: 'New' });
    s = receiveServer(s, { title: 'Handbook', body: reordered }, 2);
    expect(syncStatus(s)).toBe('unsaved');
  });

  it('discard shows the server version and leaves nothing to send', () => {
    let s = edit(initDraft(server1, 1), { body: doc('mine') });
    s = receiveServer(s, { title: 'Handbook', body: doc('theirs') }, 2);
    s = discardAll(s);
    expect(s.draft.body).toEqual(doc('theirs'));
    expect(syncStatus(s)).toBe('saved');
  });
});

describe('stored drafts', () => {
  it('restores the draft for its own entity only, held until the person acts', () => {
    const store = memoryStore();
    const keyA = draftStorageKey('u1', 'kb-page', 'A');
    const s = edit(initDraft(server1, 1), { body: doc('draft for A') });
    expect(writeStoredDraft(store, keyA, s)).toBe(true);

    expect(readStoredDraft(store, draftStorageKey('u1', 'kb-page', 'B'))).toBeNull();
    expect(readStoredDraft(store, draftStorageKey('u2', 'kb-page', 'A'))).toBeNull();

    const back = initDraft(server1, 1, readStoredDraft<Page>(store, keyA));
    expect(back.draft.body).toEqual(doc('draft for A'));
    expect(syncStatus(back)).toBe('restored');
    expect(begin(back)).toBeNull(); // the background save leaves it alone
    expect(begin(back, { force: true })!.payload).toEqual({ body: doc('draft for A') });
  });

  it('a restored draft whose base moved on is a conflict, not a silent overwrite', () => {
    const store = memoryStore();
    const key = draftStorageKey('u1', 'task', 't1');
    writeStoredDraft(store, key, edit(initDraft(server1, 1), { body: doc('mine') }));
    const back = initDraft({ title: 'Handbook', body: doc('theirs') }, 3, readStoredDraft<Page>(store, key));
    expect(syncStatus(back)).toBe('conflict');
    expect(back.draft.body).toEqual(doc('mine'));
  });

  it('settles a restored draft the server already has', () => {
    const store = memoryStore();
    const key = draftStorageKey('u1', 'task', 't1');
    writeStoredDraft(store, key, begin(edit(initDraft(server1, 1), { body: doc('mine') }))!.state);
    const back = initDraft({ title: 'Handbook', body: doc('mine') }, 2, readStoredDraft<Page>(store, key));
    expect(syncStatus(back)).toBe('saved');
  });

  it('clears the stored copy once the server acknowledged it, and reports a failed write', () => {
    const store = memoryStore();
    const key = draftStorageKey('u1', 'task', 't1');
    let s = edit(initDraft(server1, 1), { body: doc('mine') });
    writeStoredDraft(store, key, s);
    const w = begin(s)!;
    writeStoredDraft(store, key, w.state);
    expect(store.data.has(key)).toBe(true); // in flight is not saved yet
    s = ack(w.state, { title: 'Handbook', body: doc('mine') }, 2);
    writeStoredDraft(store, key, s);
    expect(store.data.has(key)).toBe(false);

    const full: DraftStore = { getItem: () => null, setItem: () => { throw new Error('quota'); }, removeItem: () => {} };
    expect(writeStoredDraft(full, key, edit(s, { body: doc('more') }))).toBe(false);
  });
});
