/**
 * Re-encrypt every stored credential with the current ENCRYPTION_KEY.
 *
 *   ENCRYPTION_KEY=<new> ENCRYPTION_KEY_PREVIOUS=<old> \
 *     pnpm --filter @ordi/api exec tsx src/rotate-encryption-key.ts [--dry-run]
 *
 * Docker: `docker compose exec api pnpm --filter @ordi/api exec tsx src/rotate-encryption-key.ts`.
 * Safe to run while the API is up and safe to run twice: values already under
 * the current key are skipped. When it reports nothing undecryptable, the old
 * key can be dropped from ENCRYPTION_KEY_PREVIOUS.
 */
import { getDb } from '@ordi/db';
import { keyring } from './lib/crypto';
import { EncryptionKeyError, ZERO_KEY } from './lib/encryption-keys';
import { rotateEncryptedData } from './lib/key-rotation';

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  let ring;
  try {
    ring = keyring();
  } catch (e) {
    if (e instanceof EncryptionKeyError) { console.error(e.message); process.exit(1); }
    throw e;
  }
  if (ring.current.key.toString('hex') === ZERO_KEY) {
    console.error('ENCRYPTION_KEY is the all-zero development key: rotating to it would protect nothing. Set a real key first (`openssl rand -hex 32`).');
    process.exit(1);
  }

  console.log(`${dryRun ? 'Dry run: ' : ''}re-encrypting with key ${ring.current.id} (${ring.ordered.length - 1} previous key(s) known)…`);
  const { sql } = getDb();
  const report = await rotateEncryptedData(sql, ring, { dryRun });

  const rotated = Object.entries(report.rotated);
  for (const [where, n] of rotated) console.log(`  ${dryRun ? 'would re-encrypt' : 're-encrypted'} ${n} in ${where}`);
  console.log(`${rotated.reduce((a, [, n]) => a + n, 0)} value(s) ${dryRun ? 'to re-encrypt' : 're-encrypted'}, ${report.current} already under the current key.`);

  const failed = Object.entries(report.undecryptable);
  if (failed.length) {
    for (const [where, n] of failed) console.error(`  ${n} value(s) in ${where} open with no known key`);
    console.error('Some values could not be decrypted. Add the key they were written with to ENCRYPTION_KEY_PREVIOUS and run this again; keep the old key until then.');
  }
  await sql.end({ timeout: 5 });
  process.exit(failed.length ? 2 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
