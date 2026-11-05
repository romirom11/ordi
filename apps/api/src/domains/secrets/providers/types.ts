/** The provider contract (R37), apart from the adapters so they can import it without a cycle. */

export type ProviderErrorKind = 'auth' | 'not_found' | 'rate_limited' | 'unavailable' | 'invalid';

/** A provider refused or failed. The message is safe to show: it never carries the token or a value. */
export class ProviderError extends Error {
  constructor(message: string, readonly kind: ProviderErrorKind) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** Where a token points, read back from it or given when connecting. */
export interface ProviderTarget { project: string; config: string }

export interface SecretProvider {
  /** Check the token works and find out what it points at. */
  verify(): Promise<ProviderTarget>;
  /** The names of the secrets the token can read; no values. */
  listNames(): Promise<string[]>;
  /** The values of the named secrets. A name the provider does not have is absent from the result. */
  getValues(names: string[]): Promise<Record<string, string>>;
}

export interface ProviderCredentials {
  token: string;
  /** Empty until verify() has read it back or someone entered it. */
  project?: string;
  config?: string;
}
