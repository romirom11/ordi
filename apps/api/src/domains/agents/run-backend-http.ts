/**
 * The RunBackend for a worker process without the database: every call is
 * a request to `/api/v1/agent-worker/*`, authenticated with the shared
 * worker secret. What comes back is what `run-service.ts` would have
 * returned in-process.
 */
import type { RepoBinding } from './workspace';
import type { RunEventType } from './run-events';
import type { ClaimedRun, ParkInput, RunBackend, RunBundle, RunReport, RunStart, StartInput, WorkerInfo } from './run-backend';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface HttpRunBackendOptions {
  /** The API's origin, e.g. http://ordi-api:3000 – without /api. */
  apiUrl: string;
  secret: string;
  /** Test seam: the app's own request handler instead of a socket. */
  fetch?: FetchLike;
}

export class AgentWorkerApiError extends Error {
  constructor(readonly path: string, readonly status: number, body: string) {
    super(`agent worker API ${path} failed with ${status}: ${body.slice(0, 300)}`);
    this.name = 'AgentWorkerApiError';
  }
}

/** Calls that end a run are retried: the alternative is a run left `running` until the stale sweep. */
const RETRIES = 3;

export function createHttpRunBackend(options: HttpRunBackendOptions): RunBackend {
  const origin = options.apiUrl.replace(/\/+$/, '').replace(/\/api$/i, '');
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));

  async function call<T>(path: string, body?: unknown, method: 'POST' | 'GET' = 'POST'): Promise<T> {
    const response = await doFetch(`${origin}/api/v1/agent-worker${path}`, {
      method,
      headers: { authorization: `Bearer ${options.secret}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    if (!response.ok) throw new AgentWorkerApiError(path, response.status, text);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async function withRetries<T>(fn: () => Promise<T>): Promise<T> {
    let last: unknown;
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      try {
        return await fn();
      } catch (e) {
        last = e;
        // A refusal will not change on retry; only a failure to reach the API might.
        if (e instanceof AgentWorkerApiError && e.status < 500) throw e;
        await new Promise((resolve) => setTimeout(resolve, 2_000 * (attempt + 1)));
      }
    }
    throw last;
  }

  return {
    apiBase: () => `${origin}/api/v1`,
    heartbeat: (info: WorkerInfo) => call<void>('/heartbeat', info),
    claim: async (workerId, limit) => (await call<{ data: ClaimedRun[] }>('/claim', { workerId, limit })).data,
    prepare: (runId) => call<RunBundle>(`/runs/${runId}/prepare`, {}),
    start: async (runId, input: StartInput) => (await call<{ started: RunStart | null }>(`/runs/${runId}/start`, input)).started,
    progress: (runId, input) => call<void>(`/runs/${runId}/progress`, input),
    touch: (runId) => call<void>(`/runs/${runId}/touch`, {}),
    event: (runId, type: RunEventType, payload) => call<void>(`/runs/${runId}/events`, { type, payload }),
    cancelRequested: async (runId) => (await call<{ cancel: boolean }>(`/runs/${runId}/control`, undefined, 'GET')).cancel,
    repository: async (runId) => (await call<{ repo: RepoBinding | null }>(`/runs/${runId}/repository`, undefined, 'GET')).repo,
    park: (runId, input: ParkInput) => withRetries(() => call<void>(`/runs/${runId}/park`, input)),
    finish: (runId, report: RunReport) => withRetries(() => call<void>(`/runs/${runId}/finish`, report)),
    fail: (runId, error) => withRetries(() => call<void>(`/runs/${runId}/fail`, { error })),
  };
}
