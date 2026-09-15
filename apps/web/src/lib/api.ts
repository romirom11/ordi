/**
 * Thin fetch client for the ordi API. Web uses same-origin cookies; the desktop
 * (Tauri) build points at a configured instance URL (PRD §18 first launch) and
 * authenticates with a bearer session token, since the tauri:// origin cannot
 * share same-site cookies with the API domain.
 */
function storedInstanceUrl(): string {
  try { return (localStorage.getItem('ordi:apiUrl') ?? '').replace(/\/+$/, ''); } catch { return ''; }
}

export function setInstanceUrl(url: string): void {
  try { localStorage.setItem('ordi:apiUrl', url.replace(/\/+$/, '')); } catch { /* private mode */ }
}

export function getInstanceUrl(): string {
  return storedInstanceUrl();
}

/**
 * The origin links should carry when shown or copied for a human. In the
 * browser that is this origin; in the desktop app window.location.origin is
 * tauri://localhost, which is meaningless outside the app – the configured
 * instance URL is the address that actually opens.
 */
export function appOrigin(): string {
  return storedInstanceUrl() || window.location.origin;
}

export function setSessionToken(token: string | null): void {
  try {
    if (token) localStorage.setItem('ordi:sessionToken', token);
    else localStorage.removeItem('ordi:sessionToken');
  } catch { /* private mode */ }
}

function sessionToken(): string | null {
  try { return localStorage.getItem('ordi:sessionToken'); } catch { return null; }
}

/** The desktop bearer credential, for callers that build their own requests (SSE). */
export function getSessionToken(): string | null {
  return sessionToken();
}

const BASE = `${storedInstanceUrl()}/api/v1`;

export interface ApiErrorShape {
  error: { code: string; message: string; details?: unknown };
}

export class ApiError extends Error {
  code: string;
  status: number;
  details?: unknown;
  constructor(status: number, body: ApiErrorShape) {
    super(body.error?.message ?? 'Request failed');
    this.status = status;
    this.code = body.error?.code ?? 'internal_error';
    this.details = body.error?.details;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = body ? { 'Content-Type': 'application/json' } : {};
  const token = sessionToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, {
    method,
    headers,
    credentials: 'include',
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ApiError(res.status, data as ApiErrorShape);
  return data as T;
}

/** Multipart POST: the browser sets the boundary header itself. */
async function requestForm<T>(path: string, form: FormData): Promise<T> {
  const headers: Record<string, string> = {};
  const token = sessionToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method: 'POST', headers, credentials: 'include', body: form });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ApiError(res.status, data as ApiErrorShape);
  return data as T;
}

/**
 * Fetch a file endpoint and hand the result to the browser as a download.
 *
 * An export cannot be a plain <a href> anchor: a navigation carries cookies but
 * never the Authorization header, so on the desktop build the link would answer
 * 401 instead of a file. Going through fetch keeps one code path for both.
 */
async function download(path: string, filename: string): Promise<void> {
  const headers: Record<string, string> = {};
  const token = sessionToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { headers, credentials: 'include' });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let body: ApiErrorShape = { error: { code: 'internal_error', message: 'Request failed' } };
    try { body = JSON.parse(text) as ApiErrorShape; } catch { /* not a JSON error body */ }
    throw new ApiError(res.status, body);
  }
  const url = URL.createObjectURL(await res.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  // Revoking in the same tick cancels the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  download,
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  postForm: <T>(path: string, form: FormData) => requestForm<T>(path, form),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};

/**
 * Walk a cursor-paged list to the end.
 *
 * A view that groups and sorts client-side needs the whole set, not the newest
 * page: `/tasks` answers 50 rows by default, so a project past that showed a
 * partial board with no hint that the rest existed. `maxPages` is a runaway
 * guard, not a page size — 40 pages of 200 is 8k rows, past which a screen that
 * renders every row is the wrong tool anyway.
 */
export async function getAllPages<T>(path: string, params: Record<string, unknown> = {}, maxPages = 40): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < maxPages; i++) {
    const res: { data: T[]; nextCursor?: string | null } =
      await api.get<{ data: T[]; nextCursor?: string | null }>(`${path}${qs({ ...params, limit: 200, cursor })}`);
    out.push(...(res.data ?? []));
    cursor = res.nextCursor ?? null;
    if (!cursor) break;
  }
  return out;
}

export function qs(params: Record<string, unknown>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}
