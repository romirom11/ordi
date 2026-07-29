/** REST client for the MCP server: every call goes through the ordi API with the
 * agent's API token (PRD §16). No direct DB access – the token's scope is the
 * agent's permission boundary. */

export interface OrdiClientConfig {
  baseUrl: string;
  token: string;
}

/**
 * A failed API call, with the machine-readable code the API returns
 * (`not_found`, `forbidden`, `version_conflict`, …) kept intact. The tools turn
 * that code into the sentence a model can act on: "someone else edited this
 * record" is a different situation from "this id does not exist", and a
 * flattened `HTTP 409` told them apart for nobody.
 */
export class OrdiApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'OrdiApiError';
  }
}

export class OrdiClient {
  constructor(private cfg: OrdiClientConfig) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.cfg.baseUrl}/api/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.cfg.token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const error = ((data as any)?.error ?? {}) as { code?: unknown; message?: unknown; details?: unknown };
      throw new OrdiApiError(
        res.status,
        typeof error.code === 'string' ? error.code : 'http_error',
        typeof error.message === 'string' ? error.message : `HTTP ${res.status}`,
        error.details,
      );
    }
    return data as T;
  }

  get<T>(path: string) { return this.request<T>('GET', path); }
  post<T>(path: string, body?: unknown) { return this.request<T>('POST', path, body); }
  patch<T>(path: string, body?: unknown) { return this.request<T>('PATCH', path, body); }
}
