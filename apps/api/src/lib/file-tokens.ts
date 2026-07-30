/**
 * Signed, non-expiring links for files embedded in rich text (PRD §14.5).
 *
 * An `<img>` cannot send an Authorization header, and the desktop build has no
 * cookie to fall back on – it talks to the API with a bearer token from a
 * tauri:// origin. So an image inside a document cannot be fetched by any
 * session-based route, and a presigned S3 url cannot be stored in the document
 * either: it expires, and the document would rot within the hour.
 *
 * The answer is the model this app already uses for invoices, quotes and client
 * portals: an unguessable token in the url. The token is an HMAC of the
 * attachment id under AUTH_SECRET, so it cannot be forged or enumerated, and it
 * never expires – a document keeps working for as long as the file exists.
 *
 * The tradeoff is explicit: anyone holding the link can fetch the file without
 * signing in, exactly like a public invoice link. Rotating AUTH_SECRET
 * invalidates every issued link at once.
 */
import { timingSafeEqual } from 'node:crypto';
import { env } from '../env';
import { hmacSha256 } from './crypto';

/** 128 bits of the HMAC – unguessable, and short enough to keep urls readable. */
const TOKEN_LENGTH = 32;

export function signFileToken(attachmentId: string): string {
  return hmacSha256(env.authSecret, `attachment:${attachmentId}`).slice(0, TOKEN_LENGTH);
}

export function verifyFileToken(attachmentId: string, token: string): boolean {
  const expected = signFileToken(attachmentId);
  if (token.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}

/**
 * The path stored in a document's image node. Root-relative on purpose: the web
 * app resolves it against its own origin and the desktop app against the
 * configured instance, so moving the instance to another domain does not break
 * every image ever embedded.
 */
export function fileSrc(attachmentId: string): string {
  return `/api/v1/files/${attachmentId}/${signFileToken(attachmentId)}`;
}

/* ── Upload keys ─────────────────────────────────────────────────────────── */

/**
 * Proof that a file key came from this API's own presign call.
 *
 * Registering an attachment mints a signed, session-free link for whatever key
 * the caller names – so without this, a caller could register a key belonging to
 * another object in the bucket (an invoice PDF, someone else's upload) and walk
 * away with a public link to it. Presign signs the key it issued; register
 * refuses any key that does not carry a matching signature.
 */
export function signUploadKey(fileKey: string): string {
  return hmacSha256(env.authSecret, `upload:${fileKey}`).slice(0, TOKEN_LENGTH);
}

export function verifyUploadKey(fileKey: string, token: unknown): boolean {
  if (typeof token !== 'string') return false;
  const expected = signUploadKey(fileKey);
  if (token.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}
