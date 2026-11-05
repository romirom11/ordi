import { defineConfig, type Plugin, type UserConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { readFileSync } from 'node:fs';

// Baked into the bundle so the app can compare itself with the server it
// talks to (lib/version.ts). All workspace versions move in lockstep.
const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'));

// The newest release sections of CHANGELOG.md, for the "What's new" list
// shown after an update (lib/changelog.ts). Only a few versions, so the
// chunk stays small; it is loaded only once there is something to show.
// A build without the file (it sits outside apps/web) gets an empty list.
const CHANGELOG_SECTIONS = 12;
function changelog(): Plugin {
  const id = 'virtual:changelog';
  const file = fileURLToPath(new URL('../../CHANGELOG.md', import.meta.url));
  return {
    name: 'ordi-changelog',
    resolveId: (source) => (source === id ? `\0${id}` : undefined),
    load(resolved) {
      if (resolved !== `\0${id}`) return undefined;
      let text = '';
      try { text = readFileSync(file, 'utf8'); this.addWatchFile(file); } catch { /* not in this build context */ }
      const starts = [...text.matchAll(/^## \[?v?\d+\.\d+\.\d+/gm)].map((m) => m.index ?? 0);
      const end = starts[CHANGELOG_SECTIONS] ?? text.length;
      const recent = starts.length ? text.slice(starts[0], end) : '';
      return `export default ${JSON.stringify(recent)};`;
    },
  };
}

export default defineConfig({
  plugins: [react(), changelog()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  // Unit tests only – e2e/*.spec.ts belong to Playwright, not vitest. The
  // `test` key is vitest's; vite's own types don't know it, hence the cast.
  test: { include: ['src/**/*.test.{ts,tsx}'] },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: process.env.API_URL ?? 'http://localhost:3000', changeOrigin: true },
      // OAuth discovery for MCP clients lives on the API.
      '/.well-known': { target: process.env.API_URL ?? 'http://localhost:3000', changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
} as UserConfig);
