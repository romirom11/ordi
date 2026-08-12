/**
 * The one upload path: a single multipart POST through the API (PRD §14.5).
 * The API puts the bytes in storage itself, so storage never has to be
 * reachable from the browser – which, on a self-hosted MinIO inside a docker
 * network, it is not.
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
  const form = new FormData();
  form.append('file', file, file.name);
  if (opts.entityType) form.append('entityType', opts.entityType);
  if (opts.entityId) form.append('entityId', opts.entityId);
  try {
    const uploaded = await api.postForm<{ id: string; src: string }>('/attachments', form);
    return { id: uploaded.id, src: uploaded.src, filename: file.name, mime };
  } catch (e) {
    // Dev without S3 configured: the API says so; keep the phrasing localized.
    if (e instanceof ApiError && /storage is not configured/i.test(e.message)) {
      throw new UploadError('uploads.noStorage');
    }
    throw e;
  }
}

/** Images only, so a slash-menu image block cannot end up holding a PDF. */
export const IMAGE_MIME = /^image\/(png|jpe?g|gif|webp|avif|svg\+xml|bmp)$/i;

export async function uploadImage(file: File): Promise<Uploaded> {
  if (!IMAGE_MIME.test(file.type)) throw new UploadError('uploads.notImage');
  return uploadAttachment(file);
}

/** PDFs only – a knowledge-base pdf page renders its file inline and nothing else would. */
export async function uploadPdf(file: File): Promise<Uploaded> {
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  if (!isPdf) throw new UploadError('uploads.notPdf');
  // Some platforms hand over a .pdf with an empty mime; the server keys the
  // inline viewer off the stored mime, so pin it here.
  if (file.type !== 'application/pdf') {
    file = new File([file], file.name, { type: 'application/pdf' });
  }
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
