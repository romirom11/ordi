import { defineConfig, type UserConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { readFileSync } from 'node:fs';

// Baked into the bundle so the app can compare itself with the server it
// talks to (lib/version.ts). All workspace versions move in lockstep.
const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'));

export default defineConfig({
  plugins: [react()],
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
