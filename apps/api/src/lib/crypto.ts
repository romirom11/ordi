import { randomBytes, scryptSync, timingSafeEqual, createHash, createHmac, createCipheriv, createDecipheriv } from 'node:crypto';
import { env } from '../env';

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

const KEY = Buffer.from(env.encryptionKey.slice(0, 64), 'hex');

/** AES-256-GCM for git credentials at rest (PRD §13.1). */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

export function decrypt(payload: string): string {
  const [ivHex, tagHex, dataHex] = payload.split(':');
  if (!ivHex || !tagHex || !dataHex) throw new Error('bad ciphertext');
  const decipher = createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
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
