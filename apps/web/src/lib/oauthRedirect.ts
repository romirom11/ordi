/**
 * Where the consent page may send the browser back to. Mirrors the API's
 * check on approval (oauth.routes.ts): the redirect must be one the client
 * registered, a loopback one may vary its port (RFC 8252), and never a
 * scheme the browser would run or render itself – Deny navigates there too,
 * and a javascript: redirect would run on the ordi origin.
 */
const UNSAFE_SCHEMES = new Set(['javascript:', 'data:', 'vbscript:', 'file:', 'blob:', 'about:']);
const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]'];

export function redirectAllowed(registered: string[], presented: string): boolean {
  let p: URL;
  try { p = new URL(presented); } catch { return false; }
  if (UNSAFE_SCHEMES.has(p.protocol)) return false;
  if (registered.includes(presented)) return true;
  if (p.protocol !== 'http:' || !LOOPBACK.includes(p.hostname)) return false;
  return registered.some((r) => {
    try {
      const u = new URL(r);
      return u.protocol === 'http:' && u.hostname === p.hostname && u.pathname === p.pathname;
    } catch { return false; }
  });
}

/** The URL Deny sends the browser to, or null when the redirect is not the client's. */
export function denyRedirect(registered: string[], presented: string, state?: string): string | null {
  if (!redirectAllowed(registered, presented)) return null;
  const url = new URL(presented);
  url.searchParams.set('error', 'access_denied');
  if (state) url.searchParams.set('state', state);
  return url.toString();
}
