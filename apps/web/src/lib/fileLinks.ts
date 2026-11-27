/**
 * File links expire within the hour (the API's lib/file-tokens). Every read of
 * a document brings its images signed afresh, so a page normally never sees a
 * lapsed one – except a page left open past that hour: a lazy image scrolled
 * into view, an editor reopened from a draft. When such an image fails to
 * load, this asks the API for a fresh link to the same path and swaps it in,
 * once per image. The API renews a path only for a reader with a right of
 * their own to the file (its uploader, a reader of the record it hangs off);
 * an image someone else embedded comes back signed with its document, so for
 * those the page's data is fetched again instead.
 */
import { api, appOrigin } from './api';

const FILE_PATH = /\/api\/v1\/files\/[^/?#]+\/[^/?#]+/;

/** The root-relative file path inside a src, or null when it is not one. */
export function filePathOf(src: string): string | null {
  return FILE_PATH.exec(src)?.[0] ?? null;
}

/** One request per path, however many images show it. */
const pending = new Map<string, Promise<string | null>>();

async function freshPath(path: string): Promise<string | null> {
  let answer = pending.get(path);
  if (!answer) {
    answer = api.post<{ srcs: string[] }>('/attachments/refresh', { srcs: [path] })
      .then((r) => {
        const next = r.srcs[0];
        return next && next !== path ? next : null;
      })
      .catch(() => null)
      .finally(() => {
        // Keep the answer briefly so a burst of images shares it.
        setTimeout(() => pending.delete(path), 60_000);
      });
    pending.set(path, answer);
  }
  return answer;
}

/** The path an image was last retried with: once per path, not once per element. */
const RETRIED = 'ordiFileRetried';

/**
 * A fresh, absolute link for a stored file src, for a button that opens it
 * (Download, Open in new tab) on a page that may have been open for hours.
 * Falls back to the src as it is.
 */
export async function freshFileHref(src: string): Promise<string> {
  const path = filePathOf(src);
  const next = path ? await freshPath(path) : null;
  return next ? appOrigin() + next : (/^[a-z][a-z0-9+.-]*:/i.test(src) ? src : appOrigin() + src);
}

let onStale: (() => void) | null = null;
let lastStale = 0;

/** Refetch the page's data, at most twice a minute however many images fail. */
function refetchDocuments(): void {
  const now = Date.now();
  if (!onStale || now - lastStale < 30_000) return;
  lastStale = now;
  onStale();
}

async function onImageError(event: Event): Promise<void> {
  const img = event.target;
  if (!(img instanceof HTMLImageElement)) return;
  const path = filePathOf(img.currentSrc || img.src);
  if (!path || img.dataset[RETRIED] === path) return;
  img.dataset[RETRIED] = path;
  const next = await freshPath(path);
  if (next) img.src = appOrigin() + next;
  else refetchDocuments();
}

let installed = false;

/**
 * Listen for failed images app-wide (`error` does not bubble, so capture it).
 * `refetch` reloads the documents on screen, whose reads sign their images afresh.
 */
export function installFileLinkRefresh(refetch: () => void): void {
  onStale = refetch;
  if (installed || typeof document === 'undefined') return;
  installed = true;
  document.addEventListener('error', (e) => { void onImageError(e); }, true);
}
