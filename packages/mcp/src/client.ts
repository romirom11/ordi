/** REST client for the MCP server: every call goes through the ordi API with the
 * agent's API token (PRD §16). No direct DB access — the token's scope is the
 * agent's permission boundary. */

export interface OrdiClientConfig {
  baseUrl: string;
  token: string;
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
      const msg = (data as any)?.error?.message ?? `HTTP ${res.status}`;
      throw new Error(`ordi API error (${res.status}): ${msg}`);
    }
    return data as T;
  }

  get<T>(path: string) { return this.request<T>('GET', path); }
  post<T>(path: string, body?: unknown) { return this.request<T>('POST', path, body); }
  patch<T>(path: string, body?: unknown) { return this.request<T>('PATCH', path, body); }
}
