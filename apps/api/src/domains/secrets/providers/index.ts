/**
 * External secret providers (plan 2026-11-05-001, U5, R37): one interface,
 * one adapter per store. Doppler is the only one so far; 1Password,
 * Infisical, Vault, AWS Secrets Manager and Bitwarden take the same shape.
 *
 * Nothing here keeps a value: `getValues` answers one reveal or one run and
 * the caller drops the result. Only names are cached, briefly, so a picker
 * and the panel's "is this name still there" check do not hit the provider
 * on every keystroke.
 */
import type { SecretProviderKind } from '@ordi/shared';
import { dopplerProvider } from './doppler';
import type { ProviderCredentials, SecretProvider } from './types';

export * from './types';

export const PROVIDER_LABEL: Record<SecretProviderKind, string> = { doppler: 'Doppler' };

export function providerFor(kind: SecretProviderKind, creds: ProviderCredentials): SecretProvider {
  switch (kind) {
    case 'doppler': return dopplerProvider(creds);
  }
}

// ── Names, cached for a minute per connection ──

const NAMES_TTL_MS = 60_000;
const namesCache = new Map<string, { at: number; names: string[] }>();

export async function cachedNames(connectionId: string, provider: SecretProvider, now = Date.now()): Promise<string[]> {
  const hit = namesCache.get(connectionId);
  if (hit && now - hit.at < NAMES_TTL_MS) return hit.names;
  const names = await provider.listNames();
  namesCache.set(connectionId, { at: now, names });
  return names;
}

export function forgetNames(connectionId?: string): void {
  if (connectionId) namesCache.delete(connectionId);
  else namesCache.clear();
}
