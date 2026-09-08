/**
 * Codex runtime – registered so the selector can show it as coming soon; every
 * call refuses until the adapter lands (plan 2026-09-05-001, scope boundary).
 */
import { RuntimeUnavailableError, type RuntimeAdapter } from './types';

export function createCodexAdapter(): RuntimeAdapter {
  return {
    runtime: 'codex',
    async available() {
      return { ok: false, version: null, error: 'Codex runtime is coming soon' };
    },
    async run() {
      throw new RuntimeUnavailableError('codex');
    },
    async verify() {
      return { ok: false, error: 'Codex runtime is coming soon', model: null };
    },
  };
}
