/**
 * Where the encryption key comes from, and what a production server refuses.
 *
 * The key protects every credential ordi stores, so a key everyone knows is no
 * key at all: the all-zero development key used to be the quick-start
 * default, which left those databases readable by anyone holding a dump.
 *
 * Resolution, first match wins:
 *   1. ENCRYPTION_KEY – 64 hex characters (`openssl rand -hex 32`).
 *   2. ENCRYPTION_KEY_FILE – read from that file; if the file does not exist
 *      yet it is generated (32 random bytes, mode 0600). The quick-start
 *      compose file points it at a named volume, so a fresh install gets a
 *      real key with nothing to configure.
 *   3. Outside production only: the all-zero development key.
 *
 * In production the server refuses to start without a key, with a malformed
 * one, or with the all-zero key. ENCRYPTION_KEY_PREVIOUS lists keys old data
 * may still be encrypted with (the zero key is allowed there – that is how an
 * install moves off it); `rotate-encryption-key` then re-encrypts everything.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { env } from '../env';
import { logger } from './logger';

export const ZERO_KEY = '0'.repeat(64);
const HEX_KEY = /^[0-9a-f]{64}$/i;

export class EncryptionKeyError extends Error {}

const HOW_TO_FIX = [
  'Generate a key with `openssl rand -hex 32` and set it as ENCRYPTION_KEY.',
  'If this install already stored credentials under the old key, also set',
  'ENCRYPTION_KEY_PREVIOUS to that old key, start the server, and run',
  '`pnpm --filter @ordi/api exec tsx src/rotate-encryption-key.ts` once',
  '(docker: `docker compose exec api pnpm --filter @ordi/api exec tsx src/rotate-encryption-key.ts`).',
  'See docs/deployment.md, "Encryption key".',
].join(' ');

function validate(hex: string, name: string): string {
  const key = hex.trim();
  if (!HEX_KEY.test(key)) {
    throw new EncryptionKeyError(`${name} must be 64 hexadecimal characters (32 bytes). ${HOW_TO_FIX}`);
  }
  return key.toLowerCase();
}

function fromFile(path: string): string {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    const generated = randomBytes(32).toString('hex');
    // `wx`: never overwrite a key another process wrote a moment ago.
    try {
      writeFileSync(path, `${generated}\n`, { mode: 0o600, flag: 'wx' });
      logger.warn({ path }, 'generated a new encryption key – back up this file together with the database');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
  return validate(readFileSync(path, 'utf8'), `ENCRYPTION_KEY_FILE (${path})`);
}

/** The current key as 64 lowercase hex characters. Throws EncryptionKeyError where production would be unsafe. */
export function resolveEncryptionKey(): string {
  let key: string;
  if (env.encryptionKey.trim()) key = validate(env.encryptionKey, 'ENCRYPTION_KEY');
  else if (env.encryptionKeyFile.trim()) key = fromFile(env.encryptionKeyFile.trim());
  else if (env.isProd) throw new EncryptionKeyError(`ENCRYPTION_KEY is not set. ${HOW_TO_FIX}`);
  else key = ZERO_KEY;

  if (env.isProd && key === ZERO_KEY) {
    throw new EncryptionKeyError(`ENCRYPTION_KEY is the all-zero development key, which anyone can read data with. ${HOW_TO_FIX}`);
  }
  return key;
}

/** Keys old data may be encrypted with. The zero key is allowed here: it is how an install moves off it. */
export function resolvePreviousKeys(): string[] {
  return env.encryptionKeysPrevious.map((k, i) => validate(k, `ENCRYPTION_KEY_PREVIOUS[${i}]`));
}
