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

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};

export function qs(params: Record<string, unknown>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}
