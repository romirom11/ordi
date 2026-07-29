#!/usr/bin/env node
/**
 * Assembles the landing page into site/dist.
 *
 * The page is hand-written HTML and CSS – there is nothing to compile. The
 * only build step is collecting the screenshots, which live in docs/ because
 * the README uses them too; duplicating ~2 MB of PNGs into site/ so the site
 * can serve them would mean every screenshot update touches two copies.
 *
 * Output is site/dist (gitignored via the root `dist/` rule). Run it locally
 * to preview, and the Pages workflow runs the same script.
 */
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = `${root}site/dist`;

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

// The page itself – entry by entry, because the output directory lives
// inside site/ and node's cp refuses to copy a directory into itself.
for (const entry of await readdir(`${root}site`)) {
  if (entry === 'dist' || entry === 'README.md') continue;
  await cp(`${root}site/${entry}`, `${out}/${entry}`, { recursive: true });
}

// Screenshots referenced as images/*.png.
await cp(`${root}docs/images`, `${out}/images`, { recursive: true });
await cp(`${root}mcp-consent.png`, `${out}/images/mcp-consent.png`);

console.log(`site built -> ${out}`);
