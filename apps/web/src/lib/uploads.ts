/**
 * The one upload path: presign → PUT to storage → register (PRD §14.5).
 *
 * Every uploader goes through here – the CRM Files section and the rich text
 * editor both did their own three-step dance before, and the editor's copy would
 * have been the second place to forget the keyToken presign now demands.
 */
import { ApiError, api, appOrigin } from './api';
import { MAX_UPLOAD_BYTES } from '@ordi/shared';

export interface Uploaded {
  id: string;
  /**
   * Root-relative, signed, non-expiring path for embedding in a document.
   * Resolve it with resolveFileSrc() before putting it in an <img>.
   */
  src: string;
  filename: string;
  mime: string;
}

/** Thrown before any request when the file itself is unacceptable. */
export class UploadError extends Error {
  /** i18n key so the caller can phrase it in the user's language. */
  messageKey: string;
  constructor(messageKey: string) {
    super(messageKey);
    this.messageKey = messageKey;
  }
}

export interface UploadOptions {
  /** Attach the file to a record. Omit for a file embedded in a document. */
  entityType?: string;
  entityId?: string;
}

export async function uploadAttachment(file: File, opts: UploadOptions = {}): Promise<Uploaded> {
  if (file.size > MAX_UPLOAD_BYTES) throw new UploadError('uploads.tooLarge');
  const mime = file.type || 'application/octet-stream';
  const presign = await api.post<{ uploadUrl: string; fileKey: string; keyToken: string }>(
    '/attachments/presign',
    { filename: file.name, size: file.size, mime, ...opts },
  );
  // Dev without S3 returns a local:// stub. Registering anyway keeps the flow
  // demonstrable, but nothing can be fetched back, so an embedded image would
  // be a permanent broken box – say so instead.
  if (presign.uploadUrl.startsWith('local://')) throw new UploadError('uploads.noStorage');

  const put = await fetch(presign.uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': mime } });
  if (!put.ok) throw new UploadError('uploads.failed');

  const registered = await api.post<{ id: string; src: string }>('/attachments/register', {
    ...opts, fileKey: presign.fileKey, keyToken: presign.keyToken,
    filename: file.name, size: file.size, mime,
  });
  return { id: registered.id, src: registered.src, filename: file.name, mime };
}

/** Images only, so a slash-menu image block cannot end up holding a PDF. */
export const IMAGE_MIME = /^image\/(png|jpe?g|gif|webp|avif|svg\+xml|bmp)$/i;

export async function uploadImage(file: File): Promise<Uploaded> {
  if (!IMAGE_MIME.test(file.type)) throw new UploadError('uploads.notImage');
  return uploadAttachment(file);
}

/**
 * Turn a stored file path into something an <img> can load.
 *
 * Documents store the root-relative path, not an absolute url, so an instance
 * that moves domain does not break every image ever embedded. In the browser
 * that path already resolves; in the desktop shell it would resolve against
 * tauri://localhost, which serves the app bundle and knows nothing about files.
 */
export function resolveFileSrc(src: string): string {
  if (!src) return src;
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('//')) return src;
  if (!src.startsWith('/')) return src;
  return appOrigin() + src;
}

/** Message for an upload failure, mapped to an i18n key where we know one. */
export function uploadErrorKey(e: unknown): string {
  if (e instanceof UploadError) return e.messageKey;
  if (e instanceof ApiError) return 'uploads.failed';
  return 'uploads.failed';
}
