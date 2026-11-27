/**
 * Signed, short-lived links to files (PRD §14.5).
 *
 * An `<img>` cannot send an Authorization header, and the desktop build has no
 * cookie to fall back on – it talks to the API with a bearer token from a
 * tauri:// origin. So a file is fetched by an unguessable path,
 * `/api/v1/files/<id>/<expiry>.<signature>`, that needs no session: an HMAC of
 * the attachment id and the expiry under AUTH_SECRET, so it cannot be forged,
 * enumerated or extended.
 *
 * A link works for about an hour. Before, the signature covered the id alone
 * and never expired: a link copied once kept opening the file for good, long
 * after its holder lost access to where it lives. Those old links are refused
 * now.
 *
 * Documents still store such paths (an image inside a task description, a
 * screenshot an agent embedded). They are not served as stored: every API
 * response re-signs the paths it carries for the reader it answers
 * (core/file-links), after the route has decided that reader may see the
 * document – so an embedded file opens for exactly the people who can read
 * the document, and a path copied out of it dies within the hour.
 */
import { timingSafeEqual } from 'node:crypto';
import { env } from '../env';
import { hmacSha256 } from './crypto';

/** 128 bits of the HMAC – unguessable, and short enough to keep urls readable. */
const SIG_LENGTH = 32;

/** How long a freshly signed link opens the file, at the least. */
export const FILE_LINK_TTL_SECONDS = 60 * 60;

/**
 * Expiries are rounded up to this step, so every link to one file signed in
 * the same quarter hour is the same url and the browser cache keeps working
 * across reloads. A link therefore lives between TTL and TTL + step.
 */
const EXPIRY_STEP_SECONDS = 15 * 60;

/**
 * How long past its expiry a link still counts as proof that its holder was
 * handed the file. A document open in an editor all afternoon carries the
 * links it was loaded with; saving it must not fail because those lapsed.
 * Past this, a holder needs a right of their own to the file (core/file-access).
 */
export const FILE_LINK_GRACE_SECONDS = 24 * 60 * 60;

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

function signature(attachmentId: string, expiresAt: number): string {
  return hmacSha256(env.authSecret, `attachment-link:${attachmentId}:${expiresAt}`).slice(0, SIG_LENGTH);
}

/** The signature of a link from before links expired; recognised, never served. */
function legacySignature(attachmentId: string): string {
  return hmacSha256(env.authSecret, `attachment:${attachmentId}`).slice(0, SIG_LENGTH);
}

function safeEqual(a: string, b: string): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** A fresh `<expiry>.<signature>` token for one attachment. */
export function signFileToken(attachmentId: string, now = nowSeconds()): string {
  const expiresAt = Math.ceil((now + FILE_LINK_TTL_SECONDS) / EXPIRY_STEP_SECONDS) * EXPIRY_STEP_SECONDS;
  return `${expiresAt}.${signature(attachmentId, expiresAt)}`;
}

export type FileToken =
  /** Minted by this server; `expiresAt` in unix seconds. */
  | { kind: 'link'; expiresAt: number }
  /** A pre-expiry link: genuine, but it no longer opens anything by itself. */
  | { kind: 'legacy' };

/**
 * A genuine token that opens nothing (expiry 0): what a path the API could not
 * vouch for is stored as (core/file-links). It still names the file, so a
 * reader with a right of their own to it gets it signed afresh.
 */
export function deadFileToken(attachmentId: string): string {
  return `0.${signature(attachmentId, 0)}`;
}

/** What a token is, if this server minted it for this attachment; null when forged. */
export function readFileToken(attachmentId: string, token: string): FileToken | null {
  const dot = token.indexOf('.');
  if (dot < 0) return safeEqual(token, legacySignature(attachmentId)) ? { kind: 'legacy' } : null;
  const expiry = token.slice(0, dot);
  if (!/^\d{1,12}$/.test(expiry)) return null;
  const expiresAt = Number(expiry);
  return safeEqual(token.slice(dot + 1), signature(attachmentId, expiresAt)) ? { kind: 'link', expiresAt } : null;
}

/** Whether a token opens the file right now: genuine, for this attachment, unexpired. */
export function verifyFileToken(attachmentId: string, token: string, now = nowSeconds()): boolean {
  const read = readFileToken(attachmentId, token);
  return read?.kind === 'link' && read.expiresAt >= now;
}

/** Seconds a token still opens its file; 0 for anything that does not. */
export function fileTokenSecondsLeft(attachmentId: string, token: string, now = nowSeconds()): number {
  const read = readFileToken(attachmentId, token);
  return read?.kind === 'link' ? Math.max(0, read.expiresAt - now) : 0;
}

/**
 * Whether a token proves its holder was handed this file recently: a genuine
 * link, unexpired or lapsed within the grace period.
 */
export function isRecentFileToken(attachmentId: string, token: string, now = nowSeconds()): boolean {
  const read = readFileToken(attachmentId, token);
  return read?.kind === 'link' && read.expiresAt + FILE_LINK_GRACE_SECONDS >= now;
}

/**
 * A file path wherever it appears: in a document's image node, in markdown,
 * as an absolute url (the MCP server hands agents absolute ones). Group 1 is
 * the attachment id, group 2 the token.
 */
export const FILE_PATH_PATTERN = /\/api\/v1\/files\/([0-9A-Za-z_-]{1,64})\/([0-9]{1,12}\.[0-9a-f]{32}|[0-9a-f]{32})(?![0-9A-Za-z])/g;

/**
 * The path an editor stores in a document's image node. Root-relative on
 * purpose: the web app resolves it against its own origin and the desktop app
 * against the configured instance, so moving the instance to another domain
 * does not break every image ever embedded.
 */
export function fileSrc(attachmentId: string, now = nowSeconds()): string {
  return `/api/v1/files/${attachmentId}/${signFileToken(attachmentId, now)}`;
}
