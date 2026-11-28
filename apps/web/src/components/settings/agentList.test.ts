import { describe, it, expect } from 'vitest';
import { mergeAgents, noWorkerOnline } from './agentList';

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
