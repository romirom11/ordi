/**
 * Runtime adapters (plan 2026-09-05-001, KTD3). One interface hides how a
 * model harness is driven: Claude Code through the Agent SDK today, Codex
 * later. The worker only ever sees events and an outcome.
 */
import type { AgentRuntime } from '@ordi/shared';

export interface RuntimeCredential {
  kind: 'api_key' | 'subscription';
  secret: string;
}

/** An MCP server the runtime may load – always ordi or the connector gateway. */
export interface RuntimeMcpServer {
  type: 'http';
  url: string;
  headers: Record<string, string>;
  /** Tools in the prompt from turn 1 instead of behind tool search (and startup waits for the server). */
  alwaysLoad?: boolean;
}

export interface RuntimeRunInput {
  /** The task brief. */
  prompt: string;
  /** Rules of engagement appended to the harness's own system prompt. */
  systemAppend: string;
  cwd: string;
  /** Home for the harness's own state, kept per task so a later run can resume the session. */
  configDir: string;
  credential: RuntimeCredential;
  model?: string | null;
  mcpServers: Record<string, RuntimeMcpServer>;
  maxTurns: number;
  maxBudgetUsd?: number | null;
  /** Runtime session to continue (follow-up runs). */
  resume?: string | null;
  allowedTools: string[];
  disallowedTools: string[];
  signal: AbortSignal;
  onEvent: (event: RuntimeEvent) => void | Promise<void>;
}

export type RuntimeEvent =
  | { type: 'init'; sessionId: string; model: string; mcpServers: { name: string; status: string }[] }
  | { type: 'assistant'; text: string; toolUses: { id: string; name: string; input: unknown }[] }
  | { type: 'tool_use'; toolUseId: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string | null; text: string; isError: boolean }
  | { type: 'rate_limit'; status: string; resetsAt: number | null; limitType: string | null }
  | { type: 'log'; message: string };

export interface RuntimeUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  costUsd: number;
  turns: number;
  durationMs: number;
}

/** What the agent said it did, parsed from its structured final answer. */
export interface RuntimeReport {
  status: 'done' | 'needs_input' | 'blocked';
  summary: string;
  prUrl: string | null;
  branch: string | null;
  question: string | null;
}

export interface RuntimeOutcome {
  status: 'succeeded' | 'failed' | 'rate_limited' | 'needs_input';
  sessionId: string | null;
  report: RuntimeReport | null;
  /** Free text: the final assistant message or the error. */
  message: string;
  error: string | null;
  usage: RuntimeUsage;
  /** Epoch ms when a rate-limited run may retry, when the runtime said so. */
  retryAt: number | null;
}

export interface RuntimeAdapter {
  readonly runtime: AgentRuntime;
  /** Whether the harness can be started on this host at all. */
  available(): Promise<{ ok: boolean; version: string | null; error: string | null }>;
  run(input: RuntimeRunInput): Promise<RuntimeOutcome>;
  /** A minimal call proving a credential works; never touches a task. */
  verify(credential: RuntimeCredential, opts: { configDir: string; model?: string | null; signal?: AbortSignal }): Promise<{ ok: boolean; error: string | null; model: string | null }>;
  /**
   * A short English kebab-case slug for a branch name, from the task title
   * and description in whatever language they are written. Null when the
   * runtime cannot answer; the caller falls back to transliteration.
   */
  suggestBranchSlug(input: { title: string; description: string; credential: RuntimeCredential; configDir: string; signal?: AbortSignal }): Promise<string | null>;
}

export class RuntimeUnavailableError extends Error {
  constructor(runtime: AgentRuntime) {
    super(`Runtime ${runtime} is not available yet`);
    this.name = 'RuntimeUnavailableError';
  }
}

/** JSON schema the agent's final answer must satisfy (R25, R31). */
export const AGENT_REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'summary'],
  properties: {
    status: { type: 'string', enum: ['done', 'needs_input', 'blocked'] },
    summary: { type: 'string', description: 'Two to five sentences on what was done, for the task comment.' },
    prUrl: { type: ['string', 'null'], description: 'The pull request url when one was opened.' },
    branch: { type: ['string', 'null'], description: 'The branch that carries the change.' },
    question: { type: ['string', 'null'], description: 'When status is needs_input: the question for the task author.' },
  },
} as const;

export function parseReport(value: unknown): RuntimeReport | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const status = v.status;
  if (status !== 'done' && status !== 'needs_input' && status !== 'blocked') return null;
  return {
    status,
    summary: typeof v.summary === 'string' ? v.summary : '',
    prUrl: typeof v.prUrl === 'string' && v.prUrl ? v.prUrl : null,
    branch: typeof v.branch === 'string' && v.branch ? v.branch : null,
    question: typeof v.question === 'string' && v.question ? v.question : null,
  };
}
