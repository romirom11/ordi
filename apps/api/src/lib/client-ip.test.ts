import { describe, it, expect } from 'vitest';
import { pickForwardedIp } from './client-ip';

describe('pickForwardedIp', () => {
  it('takes the entry the trusted proxies appended, not what the client sent', () => {
    expect(pickForwardedIp('6.6.6.6, 203.0.113.5', 1)).toBe('203.0.113.5');
    expect(pickForwardedIp('6.6.6.6, 203.0.113.5, 10.0.0.2', 2)).toBe('203.0.113.5');
  });

  it('gives up when the chain is shorter than the proxies configured, or trust is off', () => {
    expect(pickForwardedIp('203.0.113.5', 2)).toBeNull();
    expect(pickForwardedIp('203.0.113.5', 0)).toBeNull();
    expect(pickForwardedIp(undefined, 1)).toBeNull();
  });
});
