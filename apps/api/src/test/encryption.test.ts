/**
 * Encryption at rest: the versioned format, reading what older releases
 * wrote, the production rules for the key, and rotating a database onto a
 * new key without a list of where credentials live.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createCipheriv, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb } from '@ordi/db';
import { env } from '../env';
import {
  createKeyring, decryptWith, encryptWith, keyId, looksEncrypted, ciphertextKeyId,
  keyring, resetKeyringForTests, encrypt, decrypt,
} from '../lib/crypto';
import { EncryptionKeyError, ZERO_KEY, resolveEncryptionKey } from '../lib/encryption-keys';
import { rotateEncryptedData } from '../lib/key-rotation';

const OLD = 'a'.repeat(64);
const NEW = 'b'.repeat(64);

/** What releases before the version prefix wrote: `<iv>:<tag>:<data>`. */
function legacyEncrypt(keyHex: string, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${enc.toString('hex')}`;
}

describe('ciphertext format', () => {
  it('writes v1 values that name their key, and reads them back', () => {
    const ring = createKeyring(NEW);
    const value = encryptWith(ring, 'ghp_secret');
    expect(value.startsWith(`v1:${keyId(Buffer.from(NEW, 'hex'))}:`)).toBe(true);
    expect(ciphertextKeyId(value)).toBe(ring.current.id);
    expect(looksEncrypted(value)).toBe(true);
    expect(decryptWith(ring, value)).toBe('ghp_secret');
  });

  it('reads values from before the version prefix, under the current or a previous key', () => {
    expect(decryptWith(createKeyring(OLD), legacyEncrypt(OLD, 'legacy'))).toBe('legacy');
    expect(decryptWith(createKeyring(NEW, [OLD]), legacyEncrypt(OLD, 'legacy'))).toBe('legacy');
    expect(() => decryptWith(createKeyring(NEW), legacyEncrypt(OLD, 'legacy'))).toThrow(/no known key/);
  });

  it('reads a v1 value written under a previous key, and names a missing one', () => {
    const old = encryptWith(createKeyring(OLD), 'rotated');
    expect(decryptWith(createKeyring(NEW, [OLD]), old)).toBe('rotated');
    expect(() => decryptWith(createKeyring(NEW), old)).toThrow(/unknown key/);
  });

  it('refuses a tampered value', () => {
    const ring = createKeyring(NEW);
    const value = encryptWith(ring, 'payload');
    const tampered = value.slice(0, -2) + (value.endsWith('00') ? '11' : '00');
    expect(() => decryptWith(ring, tampered)).toThrow();
  });

  it('round-trips the empty string and unicode', () => {
    const ring = createKeyring(NEW);
    expect(decryptWith(ring, encryptWith(ring, ''))).toBe('');
    expect(decryptWith(ring, encryptWith(ring, 'пароль ✓'))).toBe('пароль ✓');
  });
});

describe('which key a process uses', () => {
  const saved = { ...env };
  afterEach(() => {
    Object.assign(env, saved);
    resetKeyringForTests();
  });

  const prod = (patch: Partial<typeof env>) => Object.assign(env, { isProd: true, encryptionKey: '', encryptionKeyFile: '', ...patch });

  it('refuses no key, a malformed key and the zero key in production', () => {
    prod({});
    expect(() => resolveEncryptionKey()).toThrow(EncryptionKeyError);
    prod({ encryptionKey: 'not-hex' });
    expect(() => resolveEncryptionKey()).toThrow(/64 hexadecimal/);
    prod({ encryptionKey: ZERO_KEY });
    expect(() => resolveEncryptionKey()).toThrow(/all-zero/);
    prod({ encryptionKey: NEW.toUpperCase() });
    expect(resolveEncryptionKey()).toBe(NEW);
  });

  it('falls back to the zero key outside production only', () => {
    Object.assign(env, { isProd: false, encryptionKey: '', encryptionKeyFile: '' });
    expect(resolveEncryptionKey()).toBe(ZERO_KEY);
  });

  it('generates a key file on first start and keeps using it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordi-key-'));
    try {
      const path = join(dir, 'keys', 'encryption.key');
      prod({ encryptionKeyFile: path });
      const first = resolveEncryptionKey();
      expect(first).toMatch(/^[0-9a-f]{64}$/);
      expect(first).not.toBe(ZERO_KEY);
      expect(readFileSync(path, 'utf8').trim()).toBe(first);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(resolveEncryptionKey()).toBe(first);
      // An explicit ENCRYPTION_KEY wins over the file.
      prod({ encryptionKey: NEW, encryptionKeyFile: path });
      expect(resolveEncryptionKey()).toBe(NEW);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('encrypt/decrypt use the resolved keyring, previous keys included', () => {
    Object.assign(env, { isProd: true, encryptionKey: NEW, encryptionKeyFile: '', encryptionKeysPrevious: [ZERO_KEY] });
    resetKeyringForTests();
    expect(keyring().current.id).toBe(keyId(Buffer.from(NEW, 'hex')));
    // The zero key is allowed as a previous key: that is how an install moves off it.
    expect(decrypt(legacyEncrypt(ZERO_KEY, 'from the quick start'))).toBe('from the quick start');
    expect(decrypt(encrypt('fresh'))).toBe('fresh');
  });
});

describe('rotating a database', () => {
  const { sql } = getDb();

  beforeAll(async () => {
    await sql.unsafe('drop table if exists rotation_probe');
    await sql.unsafe('create table rotation_probe (id text primary key, secret text, settings jsonb, note text)');
  });
  afterAll(async () => {
    await sql.unsafe('drop table if exists rotation_probe');
  });

  // Scoped to its own table: the worker database holds other test files' rows,
  // encrypted under the development key, which later files still have to read.
  it('re-encrypts every value a known key opens, in text and inside jsonb, and leaves the rest', async () => {
    const zeroRing = createKeyring(ZERO_KEY);
    const settings = {
      smtp: { host: 'mail.example.com', pass: legacyEncrypt(ZERO_KEY, 'smtp-pass') },
      senders: [{ pass: encryptWith(zeroRing, 'sender-pass') }],
      plain: 'not encrypted',
    };
    const lookalike = `${'1'.repeat(24)}:${'2'.repeat(32)}:abcd`;
    await sql`insert into rotation_probe values ('1', ${legacyEncrypt(ZERO_KEY, 'git-token')}, ${JSON.stringify(settings)}::jsonb, 'hello')`;
    await sql`insert into rotation_probe values ('2', ${lookalike}, null, null)`;
    await sql`insert into rotation_probe values ('3', ${legacyEncrypt(OLD, 'lost-key')}, null, null)`;

    const ring = createKeyring(NEW, [ZERO_KEY]);
    const dry = await rotateEncryptedData(sql, ring, { dryRun: true, tables: ['rotation_probe'] });
    expect(dry.rotated['rotation_probe.secret']).toBe(1);
    expect(dry.rotated['rotation_probe.settings']).toBe(2);
    const [unchanged] = await sql<{ secret: string }[]>`select secret from rotation_probe where id = '1'`;
    expect(ciphertextKeyId(unchanged!.secret)).toBeNull();

    const report = await rotateEncryptedData(sql, ring, { tables: ['rotation_probe'] });
    expect(report.rotated).toEqual({ 'rotation_probe.secret': 1, 'rotation_probe.settings': 2 });
    // The look-alike and the value under a key nobody supplied are reported, not touched.
    expect(report.undecryptable).toEqual({ 'rotation_probe.secret': 2 });

    const rows = await sql<{ id: string; secret: string; settings: any; note: string | null }[]>`select * from rotation_probe order by id`;
    const fresh = createKeyring(NEW);
    expect(decryptWith(fresh, rows[0]!.secret)).toBe('git-token');
    expect(decryptWith(fresh, rows[0]!.settings.smtp.pass)).toBe('smtp-pass');
    expect(decryptWith(fresh, rows[0]!.settings.senders[0].pass)).toBe('sender-pass');
    expect(rows[0]!.settings.smtp.host).toBe('mail.example.com');
    expect(rows[0]!.settings.plain).toBe('not encrypted');
    expect(rows[0]!.note).toBe('hello');
    expect(rows[1]!.secret).toBe(lookalike);

    // A second run finds everything already under the current key.
    const again = await rotateEncryptedData(sql, ring, { tables: ['rotation_probe'] });
    expect(again.rotated).toEqual({});
    expect(again.current).toBe(3);
  });
});
