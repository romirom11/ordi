/**
 * File links expire within the hour (the API's lib/file-tokens). Every read of
 * a document brings its images signed afresh, so a page normally never sees a
 * lapsed one – except a page left open past that hour: a lazy image scrolled
 * into view, an editor reopened from a draft. When such an image fails to
 * load, this asks the API for a fresh link to the same path and swaps it in,
 * once per image. The API decides whether the path still opens for this
 * reader; when it does not, the image simply stays broken.
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

const RETRIED = 'ordiFileRetried';

async function onImageError(event: Event): Promise<void> {
  const img = event.target;
  if (!(img instanceof HTMLImageElement)) return;
  if (img.dataset[RETRIED]) return;
  const path = filePathOf(img.currentSrc || img.src);
  if (!path) return;
  img.dataset[RETRIED] = '1';
  const next = await freshPath(path);
  if (next) img.src = appOrigin() + next;
}

let installed = false;

/** Listen for failed images app-wide. `error` does not bubble, so capture it. */
export function installFileLinkRefresh(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  document.addEventListener('error', (e) => { void onImageError(e); }, true);
}
