/**
 * Reads CHANGELOG.md into the "What's new" list shown after an update.
 *
 * Two shapes live in the file. From v1.44.0 on, release-please writes
 * `## [1.44.0](compare-url) (2026-11-10)` with `### Features` / `### Fixes`
 * groups of `* line ([#159](pr-url)) ([abc1234](commit-url))`. Earlier
 * versions were written by hand: `## v1.43.0` and `- **Bold**: prose`
 * bullets, some with nested `  - ` items, and no groups.
 */
import { compareVersions, isVersion } from './version';

export type ChangelogItem = { text: string; children: string[] };
export type ChangelogGroup = { title: string | null; items: ChangelogItem[] };
export type ChangelogRelease = { version: string; date: string | null; groups: ChangelogGroup[] };

const HEADING = /^##\s+\[?v?(\d+\.\d+\.\d+)\]?(?:\([^)]*\))?(?:\s+\((\d{4}-\d{2}-\d{2})\))?/;
const BULLET = /^[-*]\s+(.*)$/;
const NESTED_BULLET = /^\s{2,}[-*]\s+(.*)$/;
// release-please appends the commit, e.g. ` ([abc1234](https://…/commit/abc1234…))`.
const COMMIT_LINK = /\s*\(\[[0-9a-f]{7,40}\]\([^)]*\)\)\s*$/;

export function parseChangelog(markdown: string): ChangelogRelease[] {
  const releases: ChangelogRelease[] = [];
  let release: ChangelogRelease | null = null;
  let group: ChangelogGroup | null = null;
  let item: ChangelogItem | null = null;
  let inChild = false;

  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    const heading = HEADING.exec(line);
    if (heading?.[1]) {
      const next: ChangelogRelease = { version: heading[1], date: heading[2] ?? null, groups: [] };
      releases.push(next);
      release = next; group = null; item = null; inChild = false;
      continue;
    }
    if (!release) continue;
    if (line.startsWith('## ')) { release = null; continue; } // e.g. "## Unreleased"
    if (line.startsWith('### ')) {
      group = { title: line.slice(4).trim(), items: [] };
      release.groups.push(group);
      item = null; inChild = false;
      continue;
    }
    if (!line.trim()) continue;
    const bullet = BULLET.exec(line)?.[1];
    // A bullet, or a plain paragraph at the left edge ("First release.").
    if (bullet !== undefined || !/^\s/.test(line)) {
      if (!group) { group = { title: null, items: [] }; release.groups.push(group); }
      item = { text: (bullet ?? line).replace(COMMIT_LINK, ''), children: [] };
      group.items.push(item);
      inChild = false;
      continue;
    }
    if (!item) continue;
    const nested = NESTED_BULLET.exec(line)?.[1];
    if (nested !== undefined) { item.children.push(nested); inChild = true; continue; }
    // Continuation lines. Four spaces continue a nested item; two continue
    // the item itself, including a paragraph after a nested list.
    const indent = line.length - line.trimStart().length;
    const last = item.children.length - 1;
    if (indent >= 4 && inChild && last >= 0) item.children[last] += ` ${line.trim()}`;
    else { item.text += ` ${line.trim()}`; inChild = false; }
  }
  return releases.filter((r) => r.groups.some((g) => g.items.length));
}

/** Releases newer than `seen`, up to and including `current`, newest first. */
export function releasesBetween(all: ChangelogRelease[], seen: string, current: string, max = 10): ChangelogRelease[] {
  return all
    .filter((r) => compareVersions(r.version, seen) > 0 && compareVersions(r.version, current) <= 0)
    .sort((a, b) => compareVersions(b.version, a.version))
    .slice(0, max);
}

const SEEN_KEY = 'ordi:whatsNewSeen';

/**
 * The version whose notes this person last saw on this device, or null when
 * there is nothing to show. The first time this runs, someone who already
 * used ordi here (any other `ordi:` key) is treated as having seen the
 * previous release, so the release that ships this list announces itself;
 * a brand-new install says nothing about versions it never ran.
 */
export function unseenSince(current: string, storage: Pick<Storage, 'getItem' | 'setItem' | 'key' | 'length'>): string | null {
  if (!isVersion(current)) return null;
  const seen = storage.getItem(SEEN_KEY);
  if (isVersion(seen)) return compareVersions(current, seen) > 0 ? seen : null;
  let usedBefore = false;
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k && k.startsWith('ordi:') && k !== SEEN_KEY) { usedBefore = true; break; }
  }
  if (!usedBefore) { storage.setItem(SEEN_KEY, current); return null; }
  return previousVersion(current);
}

export function markSeen(current: string, storage: Pick<Storage, 'setItem'>): void {
  storage.setItem(SEEN_KEY, current);
}

/** The highest version below `v` whose notes could exist: 1.44.0 → 1.43.999. */
function previousVersion(v: string): string {
  const [major = 0, minor = 0, patch = 0] = v.split('.').map(Number);
  if (patch > 0) return `${major}.${minor}.${patch - 1}`;
  if (minor > 0) return `${major}.${minor - 1}.999999`;
  return major > 0 ? `${major - 1}.999999.999999` : '0.0.0';
}
