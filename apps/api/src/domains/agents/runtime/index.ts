/**
 * Runtime registry. Tests swap the Claude adapter for one driven by a fake
 * `query`, so nothing here ever spawns a model in CI.
 */
import type { AgentRuntime } from '@ordi/shared';
import { createClaudeCodeAdapter } from './claude-code';
import { createCodexAdapter } from './codex';
import type { RuntimeAdapter } from './types';

const adapters: Record<AgentRuntime, RuntimeAdapter> = {
  claude_code: createClaudeCodeAdapter(),
  codex: createCodexAdapter(),
};

export function runtimeAdapter(runtime: AgentRuntime): RuntimeAdapter {
  return adapters[runtime];
}

/** Test seam: replace an adapter for the current process. */
export function setRuntimeAdapter(adapter: RuntimeAdapter): () => void {
  const previous = adapters[adapter.runtime];
  adapters[adapter.runtime] = adapter;
  return () => { adapters[adapter.runtime] = previous; };
}

export * from './types';
