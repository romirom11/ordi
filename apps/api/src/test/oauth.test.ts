/**
 * The OAuth path an MCP client walks: discover, register, get approved by a
 * signed-in user, exchange the code with PKCE, and use the token on the API.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { app, resetDb, seedRolesAndUsers, reqAs, json } from './helpers';

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
});

function pkce() {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function registerClient(redirectUri = 'http://127.0.0.1:33418/callback') {
  const res = await app.request('/api/v1/oauth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [redirectUri], client_name: 'Test MCP client' }),
  });
  expect(res.status).toBe(201);
  return await res.json() as { client_id: string };
}

describe('OAuth for MCP clients', () => {
  it('serves discovery metadata on the paths clients probe', async () => {
    for (const path of [
      '/.well-known/oauth-authorization-server',
      '/.well-known/oauth-authorization-server/api/v1/mcp',
      '/api/v1/.well-known/oauth-protected-resource',
    ]) {
      const res = await app.request(path);
      expect(res.status).toBe(200);
    }
    const meta = await (await app.request('/.well-known/oauth-authorization-server')).json() as any;
    expect(meta.code_challenge_methods_supported).toEqual(['S256']);
    expect(meta.token_endpoint).toContain('/api/v1/oauth/token');
    const pr = await (await app.request('/.well-known/oauth-protected-resource')).json() as any;
    expect(pr.resource).toContain('/api/v1/mcp');
  });

  it('advertises the host the request came in on, not APP_URL', async () => {
    // The failure this guards: APP_URL left at its default while the server is
    // reachable at some public https host. Discovery answers (the client got
    // there), but every endpoint in it points at localhost, so the client
    // cannot register and reports the sign-in service as broken.
    const headers = { host: 'ordi.example.com', 'x-forwarded-proto': 'https' };
    const meta = await (await app.request('/.well-known/oauth-authorization-server', { headers })).json() as any;
    expect(meta.issuer).toBe('https://ordi.example.com');
    expect(meta.registration_endpoint).toBe('https://ordi.example.com/api/v1/oauth/register');
    expect(meta.authorization_endpoint).toBe('https://ordi.example.com/oauth/authorize');
    expect(meta.token_endpoint).toBe('https://ordi.example.com/api/v1/oauth/token');

    const pr = await (await app.request('/.well-known/oauth-protected-resource', { headers })).json() as any;
    expect(pr.resource).toBe('https://ordi.example.com/api/v1/mcp');
    expect(pr.authorization_servers).toEqual(['https://ordi.example.com']);

    // A proxy that rewrites the Host header sends x-forwarded-host instead.
    const fwd = await (await app.request('/.well-known/oauth-authorization-server', {
      headers: { host: 'api-internal:3000', 'x-forwarded-host': 'ordi.example.com', 'x-forwarded-proto': 'https' },
    })).json() as any;
    expect(fwd.issuer).toBe('https://ordi.example.com');

    // The 401 that starts the whole dance points at the same host.
    const res = await app.request('/api/v1/mcp', { method: 'POST', body: '{}', headers });
    expect(res.headers.get('WWW-Authenticate')).toContain('https://ordi.example.com/api/v1/.well-known/oauth-protected-resource');
  });

  it('registers the client Claude actually sends', async () => {
    const res = await app.request('/api/v1/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Claude',
        redirect_uris: ['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: 'user',
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.client_id).toMatch(/^mcp_/);
    expect(body.redirect_uris).toHaveLength(2);
  });

  it('an unauthenticated /mcp request points at the resource metadata', async () => {
    const res = await app.request('/api/v1/mcp', { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('resource_metadata=');
  });

  it('register -> approve -> token -> the token works on the API', async () => {
    const { client_id } = await registerClient();
    const { verifier, challenge } = pkce();

    // The signed-in user approves on the consent page.
    const owner = reqAs(users.owner!.cookie);
    const approved = await json(owner.post('/oauth/approve', {
      clientId: client_id, redirectUri: 'http://127.0.0.1:33418/callback',
      state: 'xyz', codeChallenge: challenge, codeChallengeMethod: 'S256',
    }));
    const redirect = new URL(approved.redirectTo);
    expect(redirect.searchParams.get('state')).toBe('xyz');
    const code = redirect.searchParams.get('code')!;
    expect(code.length).toBeGreaterThan(20);

    // Loopback port may differ at exchange time (RFC 8252).
    const tokenRes = await app.request('/api/v1/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code, code_verifier: verifier,
        redirect_uri: 'http://127.0.0.1:33418/callback', client_id,
      }),
    });
    expect(tokenRes.status).toBe(200);
    const grant = await tokenRes.json() as { access_token: string; token_type: string };
    expect(grant.token_type).toBe('bearer');
    expect(grant.access_token).toMatch(/^ordi_/);

    // The token is a normal API credential with the user's own permissions.
    const me = await app.request('/api/v1/me', { headers: { Authorization: `Bearer ${grant.access_token}` } });
    expect(me.status).toBe(200);
    expect(((await me.json()) as any).user.email).toBe('owner@test.local');

    // ...and single use: the same code cannot be redeemed twice.
    const replay = await app.request('/api/v1/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier }),
    });
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as any).error).toBe('invalid_grant');
  });

  it('a wrong PKCE verifier is rejected', async () => {
    const { client_id } = await registerClient('http://127.0.0.1:40000/cb');
    const { challenge } = pkce();
    const owner = reqAs(users.owner!.cookie);
    const approved = await json(owner.post('/oauth/approve', {
      clientId: client_id, redirectUri: 'http://127.0.0.1:40000/cb',
      codeChallenge: challenge, codeChallengeMethod: 'S256',
    }));
    const code = new URL(approved.redirectTo).searchParams.get('code')!;
    const res = await app.request('/api/v1/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: randomBytes(48).toString('base64url') }),
    });
    expect(res.status).toBe(400);
  });

  it('an unregistered redirect_uri cannot be approved', async () => {
    const { client_id } = await registerClient('https://claude.ai/api/mcp/auth_callback');
    const { challenge } = pkce();
    const owner = reqAs(users.owner!.cookie);
    const res = await owner.post('/oauth/approve', {
      clientId: client_id, redirectUri: 'https://evil.example.com/steal',
      codeChallenge: challenge, codeChallengeMethod: 'S256',
    });
    expect(res.status).toBe(400); // validation error – the redirect never happens
  });
});
