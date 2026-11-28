import { describe, it, expect } from 'vitest';
import { agentStatus, listView, mergeAgents, noWorkerOnline } from './agentList';

describe('mergeAgents', () => {
  const ordi = [{ id: 'max', name: 'Max' }, { id: 'julius', name: 'Julius' }];
  const outside = [{ id: 'triage', name: 'triage bot' }, { id: 'max-bot', name: 'Max' }];

  it('puts both kinds in one list by name, each saying which kind it is', () => {
    expect(mergeAgents(ordi, outside, 'en').map((e) => [e.name, e.kind])).toEqual([
      ['Julius', 'ordi'], ['Max', 'ordi'], ['Max', 'outside'], ['triage bot', 'outside'],
    ]);
  });

  it('keeps each agent as it came, for its own row and its own dialog', () => {
    const [first] = mergeAgents([], outside, 'en');
    expect(first).toEqual({ kind: 'outside', id: 'max-bot', name: 'Max', agent: outside[1] });
  });

  it('is empty only when there is neither kind', () => {
    expect(mergeAgents([], [], 'en')).toEqual([]);
    expect(mergeAgents([], outside, 'en')).toHaveLength(2);
  });
});

describe('noWorkerOnline', () => {
  it('warns only when the api runs no worker and none has reported in as online', () => {
    expect(noWorkerOnline({ workerEnabled: false, workers: [] })).toBe(true);
    expect(noWorkerOnline({ workerEnabled: false, workers: [{ online: false }] })).toBe(true);
    // A separate worker container online: the api's own worker being off is fine.
    expect(noWorkerOnline({ workerEnabled: false, workers: [{ online: true }] })).toBe(false);
    expect(noWorkerOnline({ workerEnabled: true, workers: [] })).toBe(false);
    expect(noWorkerOnline(undefined)).toBe(false);
  });
});

describe('listView', () => {
  const ok = (data: unknown[]) => ({ isLoading: false, isError: false, data });
  const loading = { isLoading: true, isError: false, data: undefined };
  const failed = { isLoading: false, isError: true, data: undefined };

  it('shows the rows that have loaded while the other query is still on its way', () => {
    expect(listView([ok([1]), loading], 1)).toEqual({ skeleton: false, failed: false, empty: false });
    expect(listView([loading, loading], 0)).toEqual({ skeleton: true, failed: false, empty: false });
  });

  it('never calls the list empty when one of its queries failed', () => {
    expect(listView([ok([]), failed], 0)).toEqual({ skeleton: false, failed: true, empty: false });
    expect(listView([ok([1]), failed], 1)).toEqual({ skeleton: false, failed: true, empty: false });
  });

  it('is empty once both answered with none', () => {
    expect(listView([ok([]), ok([])], 0)).toEqual({ skeleton: false, failed: false, empty: true });
  });
});

describe('agentStatus', () => {
  const ready = { enabled: true, isActive: true, dispatchable: true };
  it('says an agent is ready only when a worker can run it', () => {
    expect(agentStatus(ready, false)).toBe('ready');
    expect(agentStatus(ready, true)).toBe('noWorker');
    expect(agentStatus({ ...ready, dispatchable: false }, true)).toBe('needsCredential');
    expect(agentStatus({ ...ready, enabled: false }, false)).toBe('off');
    expect(agentStatus({ ...ready, isActive: false }, false)).toBe('off');
  });
});
