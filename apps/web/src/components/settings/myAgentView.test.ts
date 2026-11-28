import { describe, expect, it } from 'vitest';
import { myAgentView, renameOutcome } from './myAgentView';

describe('myAgentView', () => {
  it('reports a failed first load as an error, never as "no agent yet"', () => {
    expect(myAgentView({ isError: true, data: undefined })).toBe('error');
  });

  it('offers creation only when the answer says there is none', () => {
    expect(myAgentView({ isError: false, data: null })).toBe('none');
    expect(myAgentView({ isError: false, data: undefined })).toBe('loading');
  });

  it('keeps showing the agent after a failed refetch', () => {
    expect(myAgentView({ isError: true, data: { id: 'a' } })).toBe('ready');
  });
});

describe('renameOutcome', () => {
  it('saves a new name, trimmed', () => {
    expect(renameOutcome('  Friday ', 'Jarvis')).toEqual({ kind: 'save', name: 'Friday' });
  });

  it('just closes when the name did not change', () => {
    expect(renameOutcome('Jarvis ', 'Jarvis')).toEqual({ kind: 'close' });
  });

  it('keeps editing open for a blank name instead of saving or dropping it', () => {
    expect(renameOutcome('   ', 'Jarvis')).toEqual({ kind: 'invalid' });
  });
});
