/**
 * Re-encrypt everything ordi stored with the current key.
 *
 * Credentials live in many places – dedicated columns (agent credentials,
 * git and Slack connections, MCP connectors) and fields inside jsonb settings
 * (SMTP, GitHub App, Slack app, IMAP mailboxes) – and every new feature adds
 * another. So rotation does not keep a list: it scans every text and jsonb
 * column of the public schema for strings shaped like encrypt() output and
 * re-encrypts the ones a known key opens. A string that merely looks like
 * ciphertext is left alone, because GCM's tag refuses it under every key.
 */
import type { Sql } from '@ordi/db';
import { ciphertextKeyId, decryptWith, encryptWith, looksEncrypted, type Keyring } from './crypto';

/** Unanchored, for finding candidate rows; looksEncrypted() is the exact test. */
const CANDIDATE = '(v1:[0-9a-f]{8}:)?[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]*';

export interface RotationReport {
  /** "table.column" → values re-encrypted with the current key. */
  rotated: Record<string, number>;
  /** Values already under the current key. */
  current: number;
  /** "table.column" → values no known key opens (an old key is missing from ENCRYPTION_KEY_PREVIOUS). */
  undecryptable: Record<string, number>;
}

interface Column { table: string; column: string; type: 'text' | 'jsonb' }

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

async function candidateColumns(sql: Sql): Promise<Column[]> {
  const rows = await sql<{ table_name: string; column_name: string; data_type: string }[]>`
    select c.table_name, c.column_name, c.data_type
    from information_schema.columns c
    join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
      and c.data_type in ('text', 'character varying', 'jsonb', 'json')
    order by c.table_name, c.column_name`;
  return rows.map((r) => ({
    table: r.table_name, column: r.column_name,
    type: r.data_type === 'jsonb' || r.data_type === 'json' ? 'jsonb' : 'text',
  }));
}

type Outcome = { value: string; changed: boolean; current: number; failed: number };

function rotateString(ring: Keyring, value: string): Outcome {
  if (!looksEncrypted(value)) return { value, changed: false, current: 0, failed: 0 };
  if (ciphertextKeyId(value) === ring.current.id) return { value, changed: false, current: 1, failed: 0 };
  try {
    return { value: encryptWith(ring, decryptWith(ring, value)), changed: true, current: 0, failed: 0 };
  } catch {
    return { value, changed: false, current: 0, failed: 1 };
  }
}

/** Walk a JSON value and rotate every ciphertext string in it. */
function rotateJson(ring: Keyring, node: unknown, acc: { changed: number; current: number; failed: number }): unknown {
  if (typeof node === 'string') {
    const r = rotateString(ring, node);
    acc.changed += r.changed ? 1 : 0;
    acc.current += r.current;
    acc.failed += r.failed;
    return r.value;
  }
  if (Array.isArray(node)) return node.map((n) => rotateJson(ring, n, acc));
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) out[k] = rotateJson(ring, v, acc);
    return out;
  }
  return node;
}

export async function rotateEncryptedData(
  sql: Sql, ring: Keyring,
  /** `tables` narrows the scan (tests); by default every table in the public schema. */
  opts: { dryRun?: boolean; tables?: string[] } = {},
): Promise<RotationReport> {
  const report: RotationReport = { rotated: {}, current: 0, undecryptable: {} };
  const columns = (await candidateColumns(sql)).filter((c) => !opts.tables || opts.tables.includes(c.table));
  for (const col of columns) {
    const key = `${col.table}.${col.column}`;
    await sql.begin(async (tx) => {
      // ctid addresses the row whatever its primary key is; FOR UPDATE keeps
      // the API from writing it between the read and the re-encryption.
      const pattern = col.type === 'text' ? `^${CANDIDATE}$` : CANDIDATE;
      const rows = await tx.unsafe<{ ctid: string; v: string }[]>(
        `select ctid::text as ctid, ${ident(col.column)}::text as v from ${ident(col.table)}
         where ${ident(col.column)}::text ~ $1 for update`,
        [pattern],
      );
      let rotated = 0;
      let failed = 0;
      for (const row of rows) {
        let next: string | null = null;
        if (col.type === 'text') {
          const r = rotateString(ring, row.v);
          report.current += r.current;
          failed += r.failed;
          if (r.changed) { next = r.value; rotated += 1; }
        } else {
          const acc = { changed: 0, current: 0, failed: 0 };
          const value = rotateJson(ring, JSON.parse(row.v), acc);
          report.current += acc.current;
          failed += acc.failed;
          if (acc.changed) { next = JSON.stringify(value); rotated += acc.changed; }
        }
        if (next !== null && !opts.dryRun) {
          const cast = col.type === 'jsonb' ? '::jsonb' : '';
          await tx.unsafe(`update ${ident(col.table)} set ${ident(col.column)} = $1${cast} where ctid = $2::tid`, [next, row.ctid]);
        }
      }
      if (rotated) report.rotated[key] = rotated;
      if (failed) report.undecryptable[key] = failed;
    });
  }
  return report;
}
