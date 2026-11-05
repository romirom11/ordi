import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { markSeen, parseChangelog, releasesBetween, unseenSince, type ChangelogItem } from './changelog';

const RELEASE_PLEASE = `# Changelog

Intro paragraph.

## [1.45.0](https://github.com/romirom11/ordi/compare/v1.44.0...v1.45.0) (2026-11-20)


### Fixes

* The public form submits again ([#170](https://github.com/romirom11/ordi/pull/170)) ([1a2b3c4](https://github.com/romirom11/ordi/commit/1a2b3c4d5e))

## [1.44.0](https://github.com/romirom11/ordi/compare/v1.43.0...v1.44.0) (2026-11-10)


### ⚠ BREAKING CHANGES

* set ENCRYPTION_KEY before upgrading, or the api will not start.

### Features

* Milestones open in a side panel ([#161](https://github.com/romirom11/ordi/pull/161)) ([abcdef1](https://github.com/romirom11/ordi/commit/abcdef1234))
* **mcp:** \`create_project\` tool ([#162](https://github.com/romirom11/ordi/pull/162)) ([abcdef2](https://github.com/romirom11/ordi/commit/abcdef2345))

## v1.43.0

- **Project secrets**: credentials a client hands over. Access is three
  layers that must all agree:
  - the workspace role, through the new \`secrets.read\` and
    \`secrets.manage\` permissions;
  - the secret's audience.

  A secret restricted to people is invisible to everyone else.
- **Files can be renamed** in place.
`;

describe('parseChangelog', () => {
  const releases = parseChangelog(RELEASE_PLEASE);

  it('reads both heading shapes, with the date when there is one', () => {
    expect(releases.map((r) => [r.version, r.date])).toEqual([
      ['1.45.0', '2026-11-20'],
      ['1.44.0', '2026-11-10'],
      ['1.43.0', null],
    ]);
  });

  it('keeps release-please groups and drops the commit link but not the PR link', () => {
    const v144 = releases[1]!;
    expect(v144.groups.map((g) => g.title)).toEqual(['⚠ BREAKING CHANGES', 'Features']);
    expect(v144.groups[1]!.items[0]!.text).toBe(
      'Milestones open in a side panel ([#161](https://github.com/romirom11/ordi/pull/161))',
    );
    expect(v144.groups[1]!.items[1]!.text).toContain('**mcp:** `create_project` tool');
  });

  it('joins hand-written continuation lines and keeps nested items', () => {
    const group = releases[2]!.groups[0]!;
    const [secrets, files] = group.items as [ChangelogItem, ChangelogItem];
    expect(group.title).toBeNull();
    expect(secrets.text).toBe(
      '**Project secrets**: credentials a client hands over. Access is three layers that must all agree:'
      + ' A secret restricted to people is invisible to everyone else.',
    );
    expect(secrets.children).toEqual([
      'the workspace role, through the new `secrets.read` and `secrets.manage` permissions;',
      "the secret's audience.",
    ]);
    expect(files.text).toBe('**Files can be renamed** in place.');
  });

  it('reads the repository CHANGELOG without losing a version', () => {
    const real = readFileSync(new URL('../../../../CHANGELOG.md', import.meta.url), 'utf8');
    const parsed = parseChangelog(real);
    const headings = real.match(/^## \[?v?\d+\.\d+\.\d+/gm) ?? [];
    expect(parsed.length).toBe(headings.length);
    expect(parsed.every((r) => r.groups.every((g) => g.items.every((i) => i.text.trim())))).toBe(true);
  });
});

describe('releasesBetween', () => {
  const all = parseChangelog(RELEASE_PLEASE);

  it('returns the versions after the one seen, up to the running one, newest first', () => {
    expect(releasesBetween(all, '1.43.0', '1.45.0').map((r) => r.version)).toEqual(['1.45.0', '1.44.0']);
    expect(releasesBetween(all, '1.43.0', '1.44.0').map((r) => r.version)).toEqual(['1.44.0']);
    expect(releasesBetween(all, '1.45.0', '1.45.0')).toEqual([]);
  });
});

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get length() { return data.size; },
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v); },
  };
}

describe('unseenSince', () => {
  it('stays quiet on a brand-new install and remembers the version', () => {
    const s = memoryStorage();
    expect(unseenSince('1.44.0', s)).toBeNull();
    expect(s.data.get('ordi:whatsNewSeen')).toBe('1.44.0');
  });

  it('announces the running release to someone who used ordi before this list existed', () => {
    const s = memoryStorage({ 'ordi:theme': 'dark' });
    const since = unseenSince('1.44.0', s)!;
    expect(releasesBetween(parseChangelog(RELEASE_PLEASE), since, '1.44.0').map((r) => r.version)).toEqual(['1.44.0']);
  });

  it('returns the last seen version after an update, and nothing once marked seen', () => {
    const s = memoryStorage({ 'ordi:whatsNewSeen': '1.43.0' });
    expect(unseenSince('1.45.0', s)).toBe('1.43.0');
    markSeen('1.45.0', s);
    expect(unseenSince('1.45.0', s)).toBeNull();
  });

  it('says nothing when the running version is older than the one seen', () => {
    expect(unseenSince('1.43.0', memoryStorage({ 'ordi:whatsNewSeen': '1.44.0' }))).toBeNull();
  });
});
