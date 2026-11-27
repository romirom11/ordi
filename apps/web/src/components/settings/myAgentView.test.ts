import { describe, expect, it } from 'vitest';
import { myAgentView } from './myAgentView';

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
