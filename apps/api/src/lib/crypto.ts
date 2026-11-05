import { randomBytes, scryptSync, timingSafeEqual, createHash, createHmac, createCipheriv, createDecipheriv } from 'node:crypto';
import { resolveEncryptionKey, resolvePreviousKeys } from './encryption-keys';

/** Password hashing (scrypt). Better Auth-compatible enough for our needs (PRD §6, §19.1). */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string | null): boolean {
  if (!stored) return false;
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const derived = scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(hashHex, 'hex');
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/** Opaque tokens (sessions, API tokens, public tokens) – 128-bit min (PRD §19.1). */
export function generateToken(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}

/** API tokens are stored as SHA-256 hashes (PRD §19.1). */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * AES-256-GCM for every credential stored at rest (PRD §13.1).
 *
 * Ciphertext: `v1:<keyId>:<iv>:<tag>:<data>` (hex), where keyId is the first
 * 8 hex characters of the key's SHA-256 – so a value names the key it needs,
 * and a key rotation can tell new values from old ones. Values written before
 * the version prefix (`<iv>:<tag>:<data>`) are still read: GCM's tag tells
 * which of the known keys they were written with.
 */
export interface Keyring {
  current: { id: string; key: Buffer };
  /** Every known key by id, the current one included. */
  byId: Map<string, Buffer>;
  /** Tried in order for unversioned ciphertext: current first, then previous. */
  ordered: Buffer[];
}

export function keyId(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 8);
}

export function createKeyring(currentHex: string, previousHex: string[] = []): Keyring {
  const current = Buffer.from(currentHex, 'hex');
  if (current.length !== 32) throw new Error('encryption key must be 32 bytes');
  const ordered = [current, ...previousHex.map((h) => Buffer.from(h, 'hex')).filter((k) => k.length === 32)];
  const byId = new Map<string, Buffer>();
  for (const k of ordered) if (!byId.has(keyId(k))) byId.set(keyId(k), k);
  return { current: { id: keyId(current), key: current }, byId, ordered };
}

let defaultRing: Keyring | null = null;

/** The process's keyring, resolved once (lib/encryption-keys.ts holds the rules). */
export function keyring(): Keyring {
  defaultRing ??= createKeyring(resolveEncryptionKey(), resolvePreviousKeys());
  return defaultRing;
}

/** Tests only: forget the resolved keyring so the next call reads the environment again. */
export function resetKeyringForTests(): void {
  defaultRing = null;
}

const VERSIONED = /^v1:([0-9a-f]{8}):([0-9a-f]{24}):([0-9a-f]{32}):([0-9a-f]*)$/;
const LEGACY = /^([0-9a-f]{24}):([0-9a-f]{32}):([0-9a-f]*)$/;

/** True when the string has the shape of something encrypt() produced (either format). */
export function looksEncrypted(value: string): boolean {
  return VERSIONED.test(value) || LEGACY.test(value);
}

/** The key id a versioned value names; null for the unversioned format. */
export function ciphertextKeyId(value: string): string | null {
  return VERSIONED.exec(value)?.[1] ?? null;
}

function open(key: Buffer, ivHex: string, tagHex: string, dataHex: string): string {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
}

export function encryptWith(ring: Keyring, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', ring.current.key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${ring.current.id}:${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

export function decryptWith(ring: Keyring, payload: string): string {
  const v = VERSIONED.exec(payload);
  if (v) {
    const key = ring.byId.get(v[1]!);
    if (!key) throw new Error(`encrypted with an unknown key (${v[1]}); set it in ENCRYPTION_KEY_PREVIOUS`);
    return open(key, v[2]!, v[3]!, v[4]!);
  }
  const l = LEGACY.exec(payload);
  if (!l) throw new Error('bad ciphertext');
  for (const key of ring.ordered) {
    try { return open(key, l[1]!, l[2]!, l[3]!); } catch { /* wrong key – GCM refused it, try the next */ }
  }
  throw new Error('no known key decrypts this value; set the old key in ENCRYPTION_KEY_PREVIOUS');
}

export function encrypt(plaintext: string): string {
  return encryptWith(keyring(), plaintext);
}

export function decrypt(payload: string): string {
  return decryptWith(keyring(), payload);
}

/** HMAC-SHA256 hex, for webhook signatures (PRD §13.2). */
/**
 * Real HMAC-SHA256 (hex). This is what GitHub/Gitea compute for
 * X-Hub-Signature-256 and what any receiver of our outbound webhooks will
 * reproduce with a standard library. (The previous sha256(secret+body)
 * concat-hash matched neither, so signature verification could never pass
 * against a real provider.)
 */
export function hmacSha256(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}
