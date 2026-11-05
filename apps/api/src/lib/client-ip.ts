/**
 * The client's IP for rate limits on public endpoints.
 *
 * X-Forwarded-For is a list each proxy appends to, so only its right end is
 * trustworthy: the left entries are whatever the client sent. With
 * TRUST_PROXY_HOPS proxies in front (default 1 – one TLS terminator), the
 * client is the entry that many places from the right. A request that came
 * through fewer proxies than configured, or with no header, falls back to
 * the socket address.
 */
import type { Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { env } from '../env';

export function pickForwardedIp(header: string | undefined, hops: number): string | null {
  if (!header || hops < 1) return null;
  const chain = header.split(',').map((part) => part.trim()).filter(Boolean);
  return chain.length >= hops ? chain[chain.length - hops]! : null;
}

export function clientIp(c: Context): string {
  const forwarded = pickForwardedIp(c.req.header('x-forwarded-for'), env.trustProxyHops);
  if (forwarded) return forwarded;
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown'; // no socket (in-process requests in tests)
  }
}
