#!/usr/bin/env node
/**
 * Assembles the Pages site into site/dist.
 *
 * The site is one self-contained redirect to ordi.one, so there is nothing to
 * compile and nothing to collect - this copies the directory and stops. It
 * used to also pull ~2 MB of screenshots out of docs/images for a second copy
 * of the landing page; that copy is gone, and so is the copying.
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

// Entry by entry, because the output directory lives inside site/ and node's
// cp refuses to copy a directory into itself.
for (const entry of await readdir(`${root}site`)) {
  if (entry === 'dist' || entry === 'README.md') continue;
  await cp(`${root}site/${entry}`, `${out}/${entry}`, { recursive: true });
}

console.log(`site built -> ${out}`);
