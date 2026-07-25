/**
 * Guard against React Query cache-shape collisions.
 *
 * A cache entry is keyed by name alone, so two call sites using the same
 * queryKey MUST store the same shape. When one unwraps the envelope
 * (`.then((r) => r.data)`) and the other does not, whichever resolves last
 * wins and the other reads the wrong type – producing runtime crashes like
 * "(x.data ?? []).map is not a function".
 *
 * Shared lookups belong in apps/web/src/lib/queries.ts, unwrapped to a plain
 * array, so there is exactly one shape per key.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../apps/web/src', import.meta.url).pathname;

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.tsx?$/.test(entry) ? [full] : [];
  });
}

/** Key literal -> comparable signature; dynamic parts share a slot per value. */
function signature(raw) {
  return raw
    .split(',')
    .map((part) => {
      const literal = part.trim().match(/^['"`]([^'"`]+)['"`]$/);
      return literal ? literal[1] : '<var>';
    })
    .filter(Boolean)
    .join(' | ');
}

const byKey = new Map();
for (const file of walk(ROOT)) {
  const src = readFileSync(file, 'utf8');
  const re = /queryKey:\s*\[([^\]]*)\]/g;
  let match;
  while ((match = re.exec(src))) {
    const sig = signature(match[1]);
    if (!sig) continue;

    // Bound the window to this query – the next one starts another shape.
    let end = src.length;
    for (const marker of ['queryKey:', 'useQuery(', 'useMutation(']) {
      const i = src.indexOf(marker, match.index + match[0].length);
      if (i !== -1 && i < end) end = i;
    }
    const body = src.slice(match.index, end);
    const fnIdx = body.indexOf('queryFn:');
    if (fnIdx === -1) continue;
    const fn = body.slice(fnIdx);
    if (!/api\.(get|post)/.test(fn)) continue;

    const unwrapped = /\.then\(\s*\(?\s*\w+\s*\)?\s*=>\s*\w+\.data\s*\)/.test(fn);
    if (!byKey.has(sig)) byKey.set(sig, []);
    byKey.get(sig).push({
      file: file.slice(file.indexOf('apps/web/src')),
      line: src.slice(0, match.index).split('\n').length,
      unwrapped,
    });
  }
}

const collisions = [...byKey]
  .filter(([, uses]) => uses.length > 1 && new Set(uses.map((u) => u.unwrapped)).size > 1)
  .sort(([a], [b]) => a.localeCompare(b));

for (const [sig, uses] of collisions) {
  console.error(`\nqueryKey ['${sig.split(' | ').join("', '")}'] is stored in two different shapes:`);
  for (const u of uses) {
    console.error(`  ${u.unwrapped ? 'array   ' : 'envelope'}  ${u.file}:${u.line}`);
  }
}

if (collisions.length) {
  console.error(
    `\n${collisions.length} colliding query key(s). Move the shared lookup into ` +
      'apps/web/src/lib/queries.ts so every call site reads one shape.\n',
  );
  process.exit(1);
}

console.log(`query shapes: ${byKey.size} keys checked, no collisions`);
