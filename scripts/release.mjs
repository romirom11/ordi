#!/usr/bin/env node
/**
 * Prepares a release on the current branch: the mechanical half of
 * cutting one, so it is never done by hand again.
 *
 *   pnpm release 1.44.0     # or: pnpm release minor | patch | major
 *
 * It sets the version in every file that carries it and turns the
 * CHANGELOG's "## Unreleased" heading into "## v<version>". The written
 * half stays with a person: docs/releases/v<version>.md and the Shipped
 * entry in docs/features.md. Merging the PR is what releases: the Release
 * workflow tags the version and creates the draft GitHub release.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

// Every file whose version must move together. The Release workflow reads
// the root package.json; the desktop updater compares tauri.conf.json.
const VERSION_FILES = [
  'package.json',
  'apps/api/package.json',
  'apps/web/package.json',
  'apps/desktop/package.json',
  'apps/desktop/src-tauri/tauri.conf.json',
];

const VERSION_RE = /("version"\s*:\s*")(\d+\.\d+\.\d+)(")/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const write = (rel, text) => writeFileSync(join(ROOT, rel), text);

const parse = (v) => v.split('.').map(Number);
const compare = (a, b) => {
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

function bump(current, kind) {
  const [major, minor, patch] = parse(current);
  if (kind === 'major') return `${major + 1}.0.0`;
  if (kind === 'minor') return `${major}.${minor + 1}.0`;
  if (kind === 'patch') return `${major}.${minor}.${patch + 1}`;
  return null;
}

const arg = process.argv[2]?.replace(/^v/, '');
if (!arg) fail('usage: pnpm release <x.y.z | major | minor | patch>');

// All files must agree before we move them, or one was missed last time.
const current = new Map();
for (const file of VERSION_FILES) {
  const match = read(file).match(VERSION_RE);
  if (!match) fail(`no "version" field in ${file}`);
  current.set(file, match[2]);
}
const versions = [...new Set(current.values())];
if (versions.length > 1) {
  const list = [...current].map(([f, v]) => `  ${f}: ${v}`).join('\n');
  fail(`the version files disagree, fix them first:\n${list}`);
}
const from = versions[0];
const to = bump(from, arg) ?? arg;
if (!SEMVER_RE.test(to)) fail(`"${process.argv[2]}" is not x.y.z, major, minor or patch`);
if (compare(to, from) <= 0) fail(`${to} is not newer than the current ${from}`);

// The CHANGELOG must have something to release.
const CHANGELOG = 'CHANGELOG.md';
const changelog = read(CHANGELOG);
if (new RegExp(`^## v${to.replaceAll('.', '\\.')}$`, 'm').test(changelog)) {
  fail(`${CHANGELOG} already has a "## v${to}" section`);
}
const unreleased = changelog.match(/^## Unreleased[ \t]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m);
if (!unreleased) fail(`${CHANGELOG} has no "## Unreleased" section`);
if (!unreleased[1].trim()) fail(`the "## Unreleased" section of ${CHANGELOG} is empty`);

for (const file of VERSION_FILES) write(file, read(file).replace(VERSION_RE, `$1${to}$3`));
write(CHANGELOG, changelog.replace(/^## Unreleased[ \t]*$/m, `## v${to}`));

const notes = `docs/releases/v${to}.md`;
console.log(`Bumped ${from} -> ${to} in ${VERSION_FILES.length} files and ${CHANGELOG}.

Still to do by hand, on a release/v${to} branch:
  - ${existsSync(join(ROOT, notes)) ? `review ${notes}` : `write ${notes} (the GitHub release body)`}
  - move the shipped rows of docs/features.md into "### v${to}" under Shipped
  - open the PR; merging it tags v${to} and creates the draft release`);
