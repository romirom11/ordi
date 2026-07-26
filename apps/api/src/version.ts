/**
 * The version this server is running, read from the package manifest at boot.
 * Exposed via /healthz so clients that ship their own UI copy – the desktop
 * app above all – can tell when the server they talk to is behind or ahead.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');

export const SERVER_VERSION: string = (() => {
  try {
    return (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
