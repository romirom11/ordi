import { describe, it, expect } from 'vitest';
import { denyRedirect, redirectAllowed } from './oauthRedirect';

describe('where the consent page sends the browser back', () => {
  const registered = ['https://claude.ai/api/mcp/auth_callback', 'http://127.0.0.1:33418/callback', 'cursor://anysphere.cursor-mcp/oauth/callback'];

  it('allows a registered redirect, and a loopback one on another port', () => {
    expect(redirectAllowed(registered, 'https://claude.ai/api/mcp/auth_callback')).toBe(true);
    expect(redirectAllowed(registered, 'http://127.0.0.1:47001/callback')).toBe(true);
    expect(redirectAllowed(registered, 'cursor://anysphere.cursor-mcp/oauth/callback')).toBe(true);
  });

  it('refuses one the client did not register, and script schemes even if registered', () => {
    expect(redirectAllowed(registered, 'https://evil.example.com/cb')).toBe(false);
    expect(redirectAllowed(registered, 'http://127.0.0.1:33418/other')).toBe(false);
    expect(redirectAllowed(['javascript:alert(1)//'], 'javascript:alert(1)//')).toBe(false);
    expect(redirectAllowed(registered, 'not a url')).toBe(false);
  });

  it('Deny goes back with access_denied only to the client\'s own redirect', () => {
    const url = new URL(denyRedirect(registered, 'http://127.0.0.1:5000/callback', 'xyz')!);
    expect(url.searchParams.get('error')).toBe('access_denied');
    expect(url.searchParams.get('state')).toBe('xyz');
    expect(denyRedirect(registered, 'javascript:alert(document.cookie)//')).toBeNull();
    expect(denyRedirect(registered, 'https://evil.example.com/cb')).toBeNull();
  });
});
