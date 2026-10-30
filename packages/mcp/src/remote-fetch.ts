/**
 * Server-side URL fetch for upload_attachment. The hosted MCP runs inside the
 * API process, so a URL an agent hands over must reach nothing the public
 * internet could not: loopback, private ranges, link-local (cloud metadata),
 * CGNAT and the like are refused.
 *
 * The address check runs inside the socket's own DNS lookup, so the IP that is
 * checked is the IP that is connected to – a hostname cannot resolve public
 * for a check and private for the connect. Every redirect hop goes through the
 * same check, and the body is streamed and cut off at the cap instead of being
 * buffered whole first.
 */
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';

const BLOCKED = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) BLOCKED.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32],
  ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) BLOCKED.addSubnet(addr, prefix, 'ipv6');

/** True for an address on the public internet. */
export function isPublicAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return isPublicAddress(mapped[1]!);
  const family = net.isIP(address);
  if (family === 4) return !BLOCKED.check(address, 'ipv4');
  if (family === 6) return !BLOCKED.check(address, 'ipv6');
  return false;
}

export class BlockedUrlError extends Error {}

const REFUSED = 'url points at a private or internal address; only public URLs can be fetched.';

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

function lookupFor(isAllowed: (address: string) => boolean) {
  return (hostname: string, options: dns.LookupOptions, callback: LookupCallback) => {
    dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error, '');
      const list = addresses as dns.LookupAddress[];
      if (!list.length || list.some((a) => !isAllowed(a.address))) return callback(new BlockedUrlError(REFUSED), '');
      if (options.all) return callback(null, list);
      callback(null, list[0]!.address, list[0]!.family);
    });
  };
}

export interface RemoteFile { bytes: Uint8Array; contentType: string | null }

export interface FetchPublicOptions {
  maxBytes: number;
  timeoutMs?: number;
  maxRedirects?: number;
  /** Address policy; tests widen it to reach a local server. */
  isAllowed?: (address: string) => boolean;
}

export async function fetchPublicUrl(url: string, opts: FetchPublicOptions): Promise<RemoteFile> {
  const isAllowed = opts.isAllowed ?? isPublicAddress;
  const maxRedirects = opts.maxRedirects ?? 3;
  let current = new URL(url);
  for (let hop = 0; ; hop++) {
    const res = await requestOnce(current, opts, isAllowed);
    if ('redirect' in res) {
      if (hop >= maxRedirects) throw new Error(`Fetching url failed: more than ${maxRedirects} redirects`);
      current = new URL(res.redirect, current);
      continue;
    }
    return res;
  }
}

function requestOnce(
  target: URL, opts: FetchPublicOptions, isAllowed: (address: string) => boolean,
): Promise<RemoteFile | { redirect: string }> {
  return new Promise((resolve, reject) => {
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      return reject(new BlockedUrlError(`Only http(s) urls can be fetched, not ${target.protocol}`));
    }
    // An IP literal never goes through DNS lookup, so it is checked here.
    const host = target.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && !isAllowed(host)) return reject(new BlockedUrlError(REFUSED));

    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.get(target, { lookup: lookupFor(isAllowed) as never, headers: { accept: '*/*' } }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        return resolve({ redirect: res.headers.location });
      }
      if (status < 200 || status >= 300) {
        res.resume();
        return reject(new Error(`Fetching url failed: ${status} ${res.statusMessage ?? ''}`.trim()));
      }
      const declared = Number(res.headers['content-length'] ?? NaN);
      if (Number.isFinite(declared) && declared > opts.maxBytes) {
        req.destroy();
        return reject(new Error(`Remote file is ${declared} bytes, exceeds the ${opts.maxBytes} byte cap.`));
      }
      const chunks: Buffer[] = [];
      let received = 0;
      res.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > opts.maxBytes) {
          req.destroy();
          reject(new Error(`Remote file exceeds the ${opts.maxBytes} byte cap.`));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({
        bytes: new Uint8Array(Buffer.concat(chunks)),
        contentType: res.headers['content-type'] ?? null,
      }));
      res.on('error', reject);
    });
    req.setTimeout(opts.timeoutMs ?? 20_000, () => req.destroy(new Error('Fetching url failed: timed out')));
    req.on('error', reject);
  });
}
