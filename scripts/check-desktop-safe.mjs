#!/usr/bin/env node
/**
 * The desktop app runs the same SPA on the tauri://localhost origin with a
 * bearer token instead of cookies. A handful of browser idioms silently break
 * there and have each caused a shipped bug once:
 *
 * - window.location.origin  -> tauri://localhost in links (use appOrigin())
 * - crypto.subtle           -> absent outside secure contexts (use lib/sha256)
 * - new EventSource(...)    -> cannot send Authorization, relative URL only
 * - sessionStorage          -> lost when a deep link relaunches the app
 *
 * This fails CI when one of them appears outside its sanctioned home, so the
 * mistake costs a red check instead of a broken desktop release.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../apps/web/src', import.meta.url).pathname;

const RULES = [
  { re: /window\.location\.origin/, allow: ['lib/api.ts'], hint: 'use appOrigin() from lib/api' },
  { re: /crypto\.subtle/, allow: ['lib/desktop.ts'], hint: 'use sha256Hex from lib/sha256 (guarded use lives in lib/desktop.ts)' },
  { re: /new EventSource\(/, allow: [], hint: 'use the fetch-based reader in lib/sse.ts' },
  { re: /sessionStorage/, allow: [], hint: 'use localStorage with an expiry – sessionStorage does not survive a relaunch' },
];

const failures = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) { walk(path); continue; }
    if (!/\.(ts|tsx)$/.test(name)) continue;
    const rel = path.slice(ROOT.length + 1);
    const lines = readFileSync(path, 'utf8').split('\n');
    for (const rule of RULES) {
      if (rule.allow.includes(rel)) continue;
      lines.forEach((line, i) => {
        if (line.trimStart().startsWith('*') || line.trimStart().startsWith('//')) return;
        if (rule.re.test(line)) failures.push(`${rel}:${i + 1}  ${line.trim().slice(0, 90)}\n    -> ${rule.hint}`);
      });
    }
  }
}
walk(ROOT);

if (failures.length) {
  console.error(`desktop-safe: ${failures.length} forbidden pattern(s):\n`);
  for (const f of failures) console.error(f);
  process.exit(1);
}
console.log('desktop-safe: no forbidden browser idioms outside their sanctioned homes');
