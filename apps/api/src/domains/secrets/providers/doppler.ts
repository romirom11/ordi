/**
 * Doppler (R38), through a service token: read-only and scoped to one config.
 *
 *   names   GET /v3/configs/config/secrets/names?project&config&include_managed_secrets=false
 *   values  GET /v3/configs/config/secrets/download?format=json&project&config&secrets=A,B
 *
 * Values are only ever asked for by name, so ordi never holds more of a
 * config than the reveal or run in front of it needs. The base URL is fixed:
 * nothing a user enters decides where the token is sent.
 */
import { ProviderError, type ProviderCredentials, type ProviderTarget, type SecretProvider } from './types';

const DOPPLER_API = 'https://api.doppler.com';
const TIMEOUT_MS = 10_000;
/** Doppler's own variables, always present in a config: they say where the token points. */
const TARGET_NAMES = ['DOPPLER_PROJECT', 'DOPPLER_CONFIG'] as const;

/** What Doppler said, if it said anything readable: its errors are `{ messages: string[] }`. */
async function messageOf(res: Response): Promise<string> {
  const body = await res.json().catch(() => null) as { messages?: unknown } | null;
  const said = Array.isArray(body?.messages) ? body!.messages.filter((m): m is string => typeof m === 'string').join(' ') : '';
  return said.replace(/\s+/g, ' ').trim().slice(0, 200);
}

async function call(token: string, path: string, params: Record<string, string | undefined>): Promise<unknown> {
  const url = new URL(path, DOPPLER_API);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') url.searchParams.set(k, v);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new ProviderError('Doppler could not be reached', 'unavailable');
  }
  if (!res.ok) {
    const said = await messageOf(res);
    const suffix = said ? `: ${said}` : '';
    if (res.status === 401 || res.status === 403) throw new ProviderError(`Doppler refused the token${suffix}`, 'auth');
    if (res.status === 404) throw new ProviderError(`Doppler did not find the project or config${suffix}`, 'not_found');
    if (res.status === 429) throw new ProviderError('Doppler is rate-limiting requests; try again in a minute', 'rate_limited');
    if (res.status >= 400 && res.status < 500) throw new ProviderError(`Doppler refused the request${suffix}`, 'invalid');
    throw new ProviderError(`Doppler answered ${res.status}${suffix}`, 'unavailable');
  }
  try {
    return await res.json();
  } catch {
    throw new ProviderError('Doppler sent an answer ordi could not read', 'unavailable');
  }
}

function stringsOf(body: unknown): Record<string, string> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ProviderError('Doppler sent an answer ordi could not read', 'unavailable');
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) if (typeof v === 'string') out[k] = v;
  return out;
}

export function dopplerProvider(creds: ProviderCredentials): SecretProvider {
  const { token } = creds;
  let target: ProviderTarget | null = creds.project && creds.config ? { project: creds.project, config: creds.config } : null;

  const download = async (names: string[]): Promise<Record<string, string>> => stringsOf(await call(token, '/v3/configs/config/secrets/download', {
    format: 'json', project: target?.project, config: target?.config, secrets: names.join(','),
  }));

  const listNames = async (): Promise<string[]> => {
    if (!target) throw new ProviderError('The Doppler project and config are not known yet', 'invalid');
    const body = await call(token, '/v3/configs/config/secrets/names', {
      project: target.project, config: target.config, include_managed_secrets: 'false',
    }) as { names?: unknown };
    if (!Array.isArray(body?.names)) throw new ProviderError('Doppler sent an answer ordi could not read', 'unavailable');
    return body.names.filter((n): n is string => typeof n === 'string').sort();
  };

  return {
    async verify() {
      if (!target) {
        // A service token implies its project and config; Doppler's own variables name them.
        const own = await download([...TARGET_NAMES]);
        const project = own.DOPPLER_PROJECT;
        const config = own.DOPPLER_CONFIG;
        if (!project || !config) throw new ProviderError('Enter the Doppler project and config this token belongs to', 'invalid');
        target = { project, config };
      }
      await listNames();
      return target;
    },

    listNames,

    async getValues(names) {
      const wanted = [...new Set(names)];
      if (!wanted.length) return {};
      let got: Record<string, string>;
      try {
        got = await download(wanted);
      } catch (e) {
        // One renamed or deleted secret must not cost the others: ask again for the names that still exist.
        if (!(e instanceof ProviderError) || (e.kind !== 'invalid' && e.kind !== 'not_found') || !target) throw e;
        const present = new Set(await listNames());
        const remaining = wanted.filter((n) => present.has(n));
        if (!remaining.length || remaining.length === wanted.length) {
          if (remaining.length) throw e;
          return {};
        }
        got = await download(remaining);
      }
      const out: Record<string, string> = {};
      for (const n of wanted) if (n in got) out[n] = got[n]!;
      return out;
    },
  };
}
